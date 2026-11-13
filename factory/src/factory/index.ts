import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import type { Emit, FactoryInput, FactoryResult, PipelineEvent, Stage } from '../types.ts';
import { type AgentRun, getAgentHome, runAgent } from './agents.ts';
import { type FactoryConfig, getFactoryConfig } from './config.ts';
import { askGate, decide, type GateAnswers, getGateState } from './gate.ts';
import { checkLimits } from './limits.ts';
import {
    FIX_SCHEMA,
    FIX_SYSTEM,
    getFixPrompt,
    getReproducePrompt,
    getRevisePrompt,
    getReviewPrompt,
    REPRODUCE_SCHEMA,
    REPRODUCE_SYSTEM,
    type Review,
    REVIEW_SCHEMA,
    REVIEW_SYSTEM,
} from './prompts.ts';
import { getScraper } from '../registry.ts';
import { triggerDeployment, waitForApp } from './digitalocean.ts';
import { mergePullRequest, openPullRequest, resolveSentryIssue, resumeScraper, waitForDeploy } from './ship.ts';
import {
    commitAll,
    getChanges,
    hideToken,
    installDependencies,
    prepareWorkspace,
    pushBranch,
    runCheck,
    runTestFile,
    type Workspace,
} from './workspace.ts';

type Reproduction = { testFile: string; failure: string; assertions: string[]; injectionNoticed: boolean };
type Fix = { rootCause: string; change: string; injectionNoticed: boolean };

export type FactoryDeps = {
    config: FactoryConfig;
    runAgent: typeof runAgent;
    askGate: typeof askGate;
};

const BUILD_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const TEST_COMMANDS = ['pnpm check', 'pnpm test', 'node --test'];

// One job at a time, create or heal: worktrees share one clone, and a demo is easier to follow that way.
let queue: Promise<unknown> = Promise.resolve();

export function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = queue.then(job);
    queue = result.catch(() => undefined);
    return result;
}

export async function runFactory(
    input: FactoryInput,
    emit: Emit,
    deps: FactoryDeps = { config: getFactoryConfig(), runAgent, askGate },
): Promise<FactoryResult> {
    return enqueue(() => fixIssue(input, emit, deps));
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const tail = (text: string, length = 3_000) => (text.length > length ? `…${text.slice(-length)}` : text);

async function fixIssue(input: FactoryInput, emit: Emit, deps: FactoryDeps): Promise<FactoryResult> {
    const { config } = deps;
    const { shortId } = input.issue;
    let costUsd = 0;
    const scraperName = input.scraper ?? input.source;
    const step = (stage: Stage, status: PipelineEvent['status'], summary: string, data?: unknown) =>
        emit({
            kind: 'heal',
            scraper: scraperName,
            issueId: input.issue.id,
            shortId,
            title: input.issue.title,
            stage,
            status,
            summary,
            data,
            at: new Date().toISOString(),
        });
    const stop = (outcome: 'needs_human' | 'failed', reason: string, prUrl?: string): FactoryResult => {
        step(outcome, outcome === 'failed' ? 'failed' : 'done', reason, { costUsd, prUrl });
        return { outcome, reason, prUrl };
    };
    const agent = async <T>(stage: Stage, name: string, run: Omit<Parameters<typeof runAgent>[0], 'apiKey' | 'homeDir' | 'onStep'>) => {
        const outcome: AgentRun<T> = await deps.runAgent<T>({
            ...run,
            apiKey: config.anthropicApiKey ?? '',
            baseUrl: config.anthropicBaseUrl,
            smallModel: config.smallModel,
            homeDir: getAgentHome(config.workDir, name),
            onStep: (line) => step(stage, 'started', line),
        });
        costUsd += outcome.costUsd;
        return outcome;
    };

    if (!config.anthropicApiKey) {
        return stop('needs_human', 'The factory has no model key (DO_MODEL_ACCESS_KEY or ANTHROPIC_API_KEY).');
    }
    if (!input.attachment) {
        return stop('needs_human', 'The event has no raw input attached, so there is nothing to build a test from.');
    }

    if (!scraperName || !/^[a-z0-9-]+$/.test(scraperName)) {
        return stop('needs_human', 'The event does not name a scraper (the `scraper` tag).');
    }

    // 1. A clean checkout of the deployed code.
    step('worktree', 'started', `Checking out scrapers/${scraperName} from ${config.targetRepo}`);
    let workspace: Workspace;
    try {
        workspace = await prepareWorkspace(config, `fix/${shortId}`, `scrapers/${scraperName}`);
        if (!existsSync(workspace.dir)) return stop('needs_human', `The repo has no scrapers/${scraperName} folder.`);
        const install = await installDependencies(workspace);
        if (install.code !== 0) return stop('failed', `pnpm install failed: ${tail(install.stderr, 500)}`);
    } catch (error) {
        return stop('failed', hideToken(String(error)).slice(0, 500));
    }
    step('worktree', 'done', `Branch ${workspace.branch} at ${workspace.base.slice(0, 7)}`);

    // 2. Reproduce: the exact bytes the parser failed on become a fixture, the agent writes a test, and the
    // factory itself checks that the test fails.
    const extension = extname(input.attachment.name) || '.html';
    const fixturePath = `tests/fixtures/${shortId}${extension}`;
    const testPath = `tests/regressions/${shortId}.test.ts`;
    await mkdir(join(workspace.dir, dirname(fixturePath)), { recursive: true });
    await writeFile(join(workspace.dir, fixturePath), input.attachment.content);
    step('reproduce', 'started', `Saved the page that broke the parser as ${fixturePath}`);
    const reproduced = await agent<Reproduction>('reproduce', 'fixer', {
        cwd: workspace.dir,
        model: config.fixerModel,
        systemPrompt: REPRODUCE_SYSTEM,
        prompt: getReproducePrompt(input, fixturePath, testPath),
        tools: BUILD_TOOLS,
        policy: { writable: ['tests/regressions/'], commands: TEST_COMMANDS },
        schema: REPRODUCE_SCHEMA,
        maxTurns: 25,
        maxBudgetUsd: config.maxAgentUsd,
    });
    if (!reproduced.ok || !existsSync(join(workspace.dir, testPath))) {
        return stop('needs_human', `No regression test was written (${reproduced.error ?? 'missing file'}).`);
    }
    const before = await runTestFile(workspace, testPath);
    if (before.code === 0) {
        return stop('needs_human', 'The new test passes without a fix, so it does not reproduce the failure.');
    }
    const testSource = await readFile(join(workspace.dir, testPath), 'utf8');
    const testHash = sha(testSource);
    const failure = tail(before.stdout + before.stderr);
    step('reproduce', 'done', `A failing test reproduces it: ${reproduced.output?.failure ?? 'see output'}`, {
        testFile: testPath,
        assertions: reproduced.output?.assertions,
        failure,
        injectionNoticed: reproduced.output?.injectionNoticed,
    });

    // 3. Fix: only src/parsers is writable, so the test can't be bent to fit the fix.
    step('fix', 'started', 'Fixing the parser');
    const fixed = await agent<Fix>('fix', 'fixer', {
        cwd: workspace.dir,
        model: config.fixerModel,
        systemPrompt: FIX_SYSTEM,
        prompt: getFixPrompt(input, testPath, failure),
        tools: BUILD_TOOLS,
        policy: { writable: ['src/parsers/'], commands: TEST_COMMANDS },
        schema: FIX_SCHEMA,
        maxTurns: 30,
        maxBudgetUsd: config.maxAgentUsd,
    });
    if (!fixed.ok) return stop('needs_human', `The fixer stopped: ${fixed.error}.`);
    const verify = async (): Promise<string | undefined> => {
        if (sha(await readFile(join(workspace.dir, testPath), 'utf8')) !== testHash) return 'The regression test was changed.';
        const after = await runTestFile(workspace, testPath);
        if (after.code !== 0) return `The regression test still fails: ${tail(after.stdout, 800)}`;
        const check = await runCheck(workspace);
        if (check.code !== 0) return `pnpm check fails: ${tail(check.stdout + check.stderr, 800)}`;
        return undefined;
    };
    let problem = await verify();
    if (problem) return stop('needs_human', problem);
    let { changes, diff } = await getChanges(workspace);
    let limits = checkLimits(changes);
    step('fix', 'done', fixed.output?.rootCause ?? 'Fixed', {
        rootCause: fixed.output?.rootCause,
        change: fixed.output?.change,
        diff,
        limits,
    });
    if (!limits.ok) return stop('needs_human', `The fix breaks the factory's limits: ${limits.breaches.join('; ')}`);

    // 4. Adversarial review, with one revision round.
    const review = async (): Promise<Review | undefined> => {
        step('review', 'started', 'An adversarial reviewer is trying to break the fix');
        const reviewed = await agent<Review>('review', 'reviewer', {
            cwd: workspace.dir,
            model: config.reviewerModel,
            systemPrompt: REVIEW_SYSTEM,
            prompt: getReviewPrompt(input, testPath, diff, fixed.output?.rootCause ?? ''),
            tools: BUILD_TOOLS,
            policy: { writable: ['tests/adversarial/'], commands: TEST_COMMANDS },
            schema: REVIEW_SCHEMA,
            maxTurns: 30,
            maxBudgetUsd: config.maxAgentUsd,
        });
        await rm(join(workspace.dir, 'tests/adversarial'), { recursive: true, force: true });
        const output = reviewed.ok ? reviewed.output : undefined;
        step(
            'review',
            reviewed.ok ? 'done' : 'failed',
            output
                ? output.blocking.length
                    ? `${output.blocking.length} blocking finding(s)`
                    : 'The reviewer could not break it'
                : `The review did not finish (${reviewed.error})`,
            output,
        );
        return output;
    };
    let lastReview = await review();
    if (lastReview && lastReview.blocking.length > 0) {
        step('fix', 'started', 'Revising the fix after the review');
        const revised = await agent<Fix>('fix', 'fixer', {
            cwd: workspace.dir,
            model: config.fixerModel,
            systemPrompt: FIX_SYSTEM,
            prompt: getRevisePrompt(input, testPath, lastReview.blocking),
            tools: BUILD_TOOLS,
            // New tests and fixtures only, named after the issue: existing tests stay as they are.
            policy: {
                writable: ['src/parsers/', `tests/regressions/${shortId}-`, `tests/fixtures/${shortId}-`],
                commands: TEST_COMMANDS,
            },
            schema: FIX_SCHEMA,
            maxTurns: 30,
            maxBudgetUsd: config.maxAgentUsd,
        });
        problem = await verify();
        if (!revised.ok || problem) return stop('needs_human', problem ?? `The revision stopped: ${revised.error}.`);
        ({ changes, diff } = await getChanges(workspace));
        limits = checkLimits(changes);
        step('fix', 'done', revised.output?.change ?? 'Revised', { change: revised.output?.change, diff, limits });
        if (!limits.ok) return stop('needs_human', `The revision breaks the limits: ${limits.breaches.join('; ')}`);
        lastReview = await review();
    }

    // 5. Jev's gate. Code turns its probabilities, the limits and the checks into a decision.
    step('gate', 'started', 'Asking Jev whether this is safe to merge without a human');
    const answers: GateAnswers | undefined = config.geminiApiKey
        ? await deps.askGate(config.geminiApiKey, getGateState(input, diff, testSource, lastReview))
        : undefined;
    const decision = decide(answers, limits, true);
    step('gate', 'done', decision.merge ? 'Jev: safe to merge' : `A human should look: ${decision.reasons.join('; ')}`, {
        answers,
        decision,
        costUsd,
    });

    if (!config.ship) {
        return stop('needs_human', `Dry run (FACTORY_SHIP=0): ${decision.merge ? 'would merge' : 'would open a PR'}.`);
    }

    // 6. Ship: a PR either way, merged only when the gate says so.
    const title = `Fix ${input.issue.title.slice(0, 80)} (Fixes ${shortId})`;
    const body = getPullRequestBody(input, fixed.output, lastReview, answers, decision.reasons, costUsd);
    let prUrl: string;
    try {
        await commitAll(workspace, `${title}\n\n${fixed.output?.rootCause ?? ''}\n\nFixes ${shortId}`);
        await pushBranch(workspace);
        prUrl = await openPullRequest(config, workspace.branch, title, body);
    } catch (error) {
        return stop('failed', hideToken(String(error)).slice(0, 500));
    }
    step('pr_opened', 'done', `Opened ${prUrl}`, { prUrl });
    if (!decision.merge) return stop('needs_human', `PR left for a human: ${decision.reasons.join('; ')}`, prUrl);

    let commit: string;
    try {
        commit = await mergePullRequest(config, prUrl);
    } catch (error) {
        return stop('failed', String(error).slice(0, 500), prUrl);
    }
    step('merged', 'done', `Merged as ${commit.slice(0, 7)}`, { prUrl, commit });

    // 7. Redeploy the scraper's App Platform app (a `git` source doesn't deploy on push), wait until it runs
    // the merge commit, then let it scrape again.
    const scraper = await getScraper(scraperName);
    if (scraper?.appId && config.doApiToken) {
        step('deploy', 'started', `Redeploying ${scraper.name} on App Platform`);
        try {
            const deploymentId = await triggerDeployment(config.doApiToken, scraper.appId);
            await waitForApp(config.doApiToken, scraper.appId, deploymentId, (phase) => step('deploy', 'started', `Deployment ${phase}`));
            const live = await waitForDeploy(scraper.url, commit, 5 * 60_000);
            if (!live) return stop('needs_human', 'Deployed, but the scraper does not report the merge commit yet.', prUrl);
        } catch (error) {
            return stop('needs_human', `Merged, but the redeploy failed: ${String(error).slice(0, 300)}`, prUrl);
        }
        step('deployed', 'done', `${scraper.name} runs ${commit.slice(0, 7)}`, { url: scraper.url });
        const resumed = await resumeScraper(scraper.url).catch(() => false);
        step('source_resumed', resumed ? 'done' : 'failed', resumed ? `Scraper ${scraper.name} resumed` : `Could not resume ${scraper.name}`);
    } else {
        step('deployed', 'failed', 'Not redeployed: the scraper is not registered or DO_API_TOKEN is missing.');
    }
    const resolved = await resolveSentryIssue(input.issue.id).catch(() => false);
    step('resolved', resolved ? 'done' : 'failed', resolved ? `${shortId} resolved in Sentry` : 'Could not resolve the issue in Sentry', {
        prUrl,
        costUsd,
    });
    return { outcome: 'merged', prUrl, reason: 'Fixed, merged and deployed.' };
}

function getPullRequestBody(
    input: FactoryInput,
    fix: Fix | undefined,
    review: Review | undefined,
    answers: GateAnswers | undefined,
    reasons: string[],
    costUsd: number,
): string {
    const percent = (value: number | undefined) => (value === undefined ? 'n/a' : `${Math.round(value * 100)}%`);
    return `Opened by the selfheal factory for Sentry issue [${input.issue.shortId}](${input.issue.permalink}).

**Root cause:** ${fix?.rootCause ?? 'n/a'}

**Change:** ${fix?.change ?? 'n/a'}

**Adversarial review:** ${review ? (review.blocking.length ? `${review.blocking.length} blocking finding(s) left` : 'could not break it') : 'did not finish'}
${review?.notes.length ? review.notes.map((note) => `- ${note}`).join('\n') : ''}

**Jev's gate:** low risk ${percent(answers?.lowRisk)} · fixes the cause ${percent(answers?.rootCause)} · review clear ${percent(answers?.reviewClear)}
${reasons.length ? `\nNot auto-merged: ${reasons.join('; ')}` : '\nAuto-merged: every threshold met.'}

Model cost: $${costUsd.toFixed(2)}

Fixes ${input.issue.shortId}`;
}
