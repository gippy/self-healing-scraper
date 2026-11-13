import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { blocksModels, checkText } from '../guard.ts';
import { getScraper, saveScraper } from '../registry.ts';
import type { Emit, PipelineEvent, Stage } from '../types.ts';
import { type AgentRun, getAgentHome, runAgent } from './agents.ts';
import { type FactoryConfig, getFactoryConfig } from './config.ts';
import { createApp, getScraperEnvs, getScraperSpec, triggerDeployment, waitForApp } from './digitalocean.ts';
import { fetchPage } from './fetch-page.ts';
import { askCreateGate, type CreateAnswers, decideCreate } from './gate.ts';
import { enqueue, getAgentRuntime } from './index.ts';
import {
    GENERATE_SCHEMA,
    GENERATE_SYSTEM,
    getGeneratePrompt,
    getVerifyPrompt,
    type Verification,
    VERIFY_SCHEMA,
    VERIFY_SYSTEM,
} from './prompts.ts';
import { mergePullRequest, openPullRequest } from './ship.ts';
import {
    commitAll,
    getChanges,
    hideToken,
    installDependencies,
    prepareWorkspace,
    pushBranch,
    runCheck,
    runParser,
    type Workspace,
} from './workspace.ts';

export type CreateRequest = { name: string; url: string; fields?: string };
export type CreateResult = { outcome: 'deployed' | 'pr_open' | 'needs_human' | 'failed'; url?: string; prUrl?: string; reason: string };

type Generated = { strategy: string; fields: string[]; skipped: string[]; injectionNoticed: boolean };
type Item = { id?: unknown; title?: unknown; price?: { amount?: unknown; currency?: unknown } };

const DEFAULT_FIELDS = 'every listing with its id, title, category, current price and currency, number of bids, status and end time';
const BUILD_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const TEST_COMMANDS = ['pnpm check', 'pnpm test', 'node --test'];

export function isValidScraperName(name: string): boolean {
    return /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/.test(name);
}

// Checks a parser's live output in code, before any model looks at it.
export function checkOutput(items: Item[], fields: string): string[] {
    const problems: string[] = [];
    if (items.length === 0) problems.push('the parser returned no items for the live page');
    const ids = items.map((item) => String(item.id ?? ''));
    if (ids.some((id) => !id)) problems.push('some items have no id');
    if (new Set(ids).size !== ids.length) problems.push('item ids are not unique');
    if (items.some((item) => typeof item.title !== 'string' || !item.title.trim())) problems.push('some items have no title');
    if (/price|bid|cost/i.test(fields)) {
        const priced = items.filter((item) => typeof item.price?.amount === 'number' && typeof item.price.currency === 'string');
        if (priced.length < items.length * 0.9) problems.push(`only ${priced.length} of ${items.length} items have a price`);
    }
    return problems;
}

export function createScraper(request: CreateRequest, emit: Emit, config: FactoryConfig = getFactoryConfig()): Promise<CreateResult> {
    return enqueue(() => build(request, emit, config));
}

async function build(request: CreateRequest, emit: Emit, config: FactoryConfig): Promise<CreateResult> {
    const runId = `create-${request.name}-${randomUUID().slice(0, 6)}`;
    const fields = request.fields?.trim() || DEFAULT_FIELDS;
    let costUsd = 0;
    const step = (stage: Stage, status: PipelineEvent['status'], summary: string, data?: unknown) =>
        emit({
            kind: 'create',
            scraper: request.name,
            issueId: runId,
            shortId: request.name,
            title: `New scraper for ${request.url}`,
            stage,
            status,
            summary,
            data,
            at: new Date().toISOString(),
        });
    const stop = (outcome: 'needs_human' | 'failed', reason: string, prUrl?: string): CreateResult => {
        step(outcome, outcome === 'failed' ? 'failed' : 'done', reason, { costUsd, prUrl });
        return { outcome, reason, prUrl };
    };
    const agent = async <T>(stage: Stage, name: string, run: Omit<Parameters<typeof runAgent>[0], 'apiKey' | 'homeDir' | 'onStep' | 'baseUrl' | 'smallModel'>) => {
        const outcome: AgentRun<T> = await getAgentRuntime()<T>({
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

    if (!isValidScraperName(request.name)) return stop('needs_human', 'Scraper names are 3–24 lowercase letters, digits and dashes.');
    if (!config.anthropicApiKey) return stop('needs_human', 'The factory has no model key (DO_MODEL_ACCESS_KEY or ANTHROPIC_API_KEY).');

    // 1. Investigate: fetch the page the way the scraper will, twice, a few seconds apart.
    step('investigate', 'started', `Fetching ${request.url}`);
    const pages: string[] = [];
    let via = '';
    try {
        for (let index = 0; index < 2; index++) {
            if (index > 0) await new Promise((resolve) => setTimeout(resolve, 4_000));
            const page = await fetchPage(request.url);
            pages.push(page.html);
            via = page.via;
        }
    } catch (error) {
        return stop('failed', `Could not fetch ${request.url}: ${String(error).slice(0, 300)}`);
    }
    if (process.env.APIFY_TOKEN) {
        const guard = await checkText(pages[0] ?? '');
        if (blocksModels(guard.verdict)) {
            return stop('needs_human', `The prompt guard ${guard.verdict === 'flagged' ? 'flagged' : 'could not check'} the page, so no model reads it.`);
        }
    }
    const title = (/<title>([^<]*)<\/title>/i.exec(pages[0] ?? '')?.[1]?.trim() ?? '(no title)')
        .replaceAll('&amp;', '&')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'");
    step('investigate', 'done', `Fetched "${title}" twice through ${via} (${Math.round((pages[0]?.length ?? 0) / 1024)} KB)`, { url: request.url, via, title });

    // 2. A new scraper folder from the template, in a fresh worktree of the monorepo.
    const rel = `scrapers/${request.name}`;
    let workspace: Workspace;
    try {
        workspace = await prepareWorkspace(config, `scraper/${request.name}`, rel);
        if (existsSync(workspace.dir)) return stop('needs_human', `${rel} already exists; heal it instead.`);
        const template = join(workspace.path, 'scraper-template');
        if (!existsSync(template)) return stop('failed', 'The repo has no scraper-template folder.');
        await cp(template, workspace.dir, {
            recursive: true,
            filter: (source) => !/\/(node_modules|examples|\.git)(\/|$)|\/\.env/.test(source.slice(template.length)),
        });
        await mkdir(join(workspace.dir, 'tests/fixtures'), { recursive: true });
        for (const [index, html] of pages.entries()) await writeFile(join(workspace.dir, `tests/fixtures/page-${index + 1}.html`), html);
        const install = await installDependencies(workspace);
        if (install.code !== 0) return stop('failed', `pnpm install failed: ${install.stderr.slice(-500)}`);
    } catch (error) {
        return stop('failed', hideToken(String(error)).slice(0, 500));
    }

    // 3. Generate the parser and its tests; the factory runs the checks itself.
    step('generate', 'started', 'Writing the parser and its tests');
    const fixtures = pages.map((_, index) => `tests/fixtures/page-${index + 1}.html`);
    const generated = await agent<Generated>('generate', 'builder', {
        cwd: workspace.dir,
        model: config.fixerModel,
        systemPrompt: GENERATE_SYSTEM,
        prompt: getGeneratePrompt(request.name, request.url, fields, fixtures),
        tools: BUILD_TOOLS,
        policy: { writable: ['src/parsers/', 'tests/'], commands: TEST_COMMANDS },
        schema: GENERATE_SCHEMA,
        maxTurns: 40,
        maxBudgetUsd: config.maxAgentUsd,
    });
    if (!generated.ok) return stop('needs_human', `The builder stopped: ${generated.error}`);
    const check = await runCheck(workspace);
    if (check.code !== 0) return stop('needs_human', `pnpm check fails: ${(check.stdout + check.stderr).slice(-800)}`);
    const parserSource = await readFile(join(workspace.dir, 'src/parsers/index.ts'), 'utf8');
    step('generate', 'done', generated.output?.strategy ?? 'Parser written; pnpm check passes', {
        ...generated.output,
        parser: parserSource,
    });

    // 4. Verify against the live site: a fresh fetch, the parser's output on it, checks in code, and an
    // independent model reading the page itself.
    step('verify', 'started', 'Running the scraper against the live site');
    let live: string;
    try {
        live = (await fetchPage(request.url)).html;
    } catch (error) {
        return stop('failed', `Could not fetch the live page again: ${String(error).slice(0, 300)}`);
    }
    const livePath = 'tests/fixtures/live.html';
    await writeFile(join(workspace.dir, livePath), live);
    const run = await runParser(workspace, livePath, request.url);
    const items = (run.items ?? []) as Item[];
    const problems = run.error ? [`the parser threw on the live page: ${run.error}`] : checkOutput(items, fields);
    step('verify', 'started', run.error ? `The parser threw on the live page` : `${items.length} items from the live page`, {
        sample: items.slice(0, 5),
        problems,
    });
    const verified = await agent<Verification>('verify', 'verifier', {
        cwd: workspace.dir,
        model: config.reviewerModel,
        systemPrompt: VERIFY_SYSTEM,
        prompt: getVerifyPrompt(request.url, fields, livePath, items, run.error),
        tools: ['Read', 'Glob', 'Grep', 'Bash'],
        policy: { writable: [], commands: ['node --test'] },
        schema: VERIFY_SCHEMA,
        maxTurns: 25,
        maxBudgetUsd: config.maxAgentUsd,
    });
    const verification = verified.ok ? verified.output : undefined;
    if (!verification) problems.push(`the verifier did not finish (${verified.error})`);
    else if (verification.verdict === 'reject') problems.push('the verifier rejected the output');
    step('verify', problems.length ? 'failed' : 'done', verification
        ? `Verifier: ${verification.verdict}; it counts ${verification.listingsOnPage} listings, the parser read ${items.length}`
        : 'The verifier did not finish', { verification, parsed: items.length, problems });

    // 5. Gemini's gate on the evidence.
    step('gate', 'started', 'Asking Gemini whether this scraper is right and safe to deploy');
    const gateInput = `A scraper factory built a scraper for ${request.url} and must decide whether to deploy it without a human.
It should collect: ${fields}

The parser:
${parserSource.slice(0, 10_000)}

Its output on a page fetched from the live site just now (${items.length} items; first 15):
${JSON.stringify(items.slice(0, 15)).slice(0, 6_000)}

Checks in code: ${problems.length ? problems.join('; ') : 'all passed'}
Independent verifier: ${verification ? JSON.stringify(verification).slice(0, 4_000) : 'did not finish'}`;
    const answers: CreateAnswers | undefined = config.geminiApiKey ? await askCreateGate(config.geminiApiKey, gateInput) : undefined;
    const decision = decideCreate(answers, problems);
    step('gate', 'done', decision.merge ? 'Gemini: right and safe to deploy' : `A human should look: ${decision.reasons.join('; ')}`, {
        answers,
        decision,
        costUsd,
    });
    if (!config.ship) return stop('needs_human', `Dry run (FACTORY_SHIP=0): ${decision.merge ? 'would deploy' : 'would open a PR'}.`);

    // 6. Ship: a PR either way, merged only when the gate says so.
    const { diff } = await getChanges(workspace);
    const prTitle = `Add the ${request.name} scraper`;
    let prUrl: string;
    try {
        await commitAll(workspace, `${prTitle}\n\nBuilt by the scraper factory for ${request.url}.`);
        await pushBranch(workspace);
        prUrl = await openPullRequest(config, workspace.branch, prTitle, getCreatePrBody(request, fields, generated.output, verification, answers, decision.reasons, items.length, costUsd));
    } catch (error) {
        return stop('failed', hideToken(String(error)).slice(0, 500));
    }
    step('pr_opened', 'done', `Opened ${prUrl}`, { prUrl, diffLines: diff.split('\n').length });
    if (!decision.merge) return stop('needs_human', `PR left for a human: ${decision.reasons.join('; ')}`, prUrl);
    try {
        const commit = await mergePullRequest(config, prUrl);
        step('merged', 'done', `Merged as ${commit.slice(0, 7)}`, { prUrl, commit });
    } catch (error) {
        return stop('failed', String(error).slice(0, 500), prUrl);
    }

    // 7. Deploy it as its own App Platform app and register it.
    if (!config.doApiToken) return stop('needs_human', 'Merged, but there is no DO_API_TOKEN to deploy it.', prUrl);
    step('deploy', 'started', `Deploying ${request.name} to DigitalOcean App Platform`);
    let url: string;
    let appId: string;
    try {
        const existing = await getScraper(request.name);
        let deploymentId: string | undefined;
        if (existing?.appId) {
            appId = existing.appId;
            deploymentId = await triggerDeployment(config.doApiToken, appId);
        } else {
            const repoUrl = `https://github.com/${config.targetRepo}.git`;
            const app = await createApp(config.doApiToken, getScraperSpec(request.name, rel, repoUrl, await getScraperEnvs(request.name, request.url)));
            appId = app.id;
        }
        url = await waitForApp(config.doApiToken, appId, deploymentId, (phase) => step('deploy', 'started', `Deployment ${phase}`));
    } catch (error) {
        return stop('needs_human', `Merged, but the deploy failed: ${String(error).slice(0, 400)}`, prUrl);
    }
    step('deployed', 'done', `${request.name} is live at ${url}`, { url, appId });
    await saveScraper({ name: request.name, url, appId, dir: rel, targetUrl: request.url, createdAt: new Date().toISOString() });
    step('registered', 'done', `${request.name} is registered; the monitor watches it`, { url, prUrl, costUsd });
    return { outcome: 'deployed', url, prUrl, reason: 'Built, verified against the live site, deployed.' };
}

function getCreatePrBody(
    request: CreateRequest,
    fields: string,
    generated: Generated | undefined,
    verification: Verification | undefined,
    answers: CreateAnswers | undefined,
    reasons: string[],
    parsed: number,
    costUsd: number,
): string {
    const percent = (value: number | undefined) => (value === undefined ? 'n/a' : `${Math.round(value * 100)}%`);
    return `Built by the scraper factory for ${request.url}.

**Collects:** ${fields}

**How it reads the page:** ${generated?.strategy ?? 'n/a'}

**Verified against the live site:** the parser read ${parsed} items; the independent verifier counted ${verification?.listingsOnPage ?? 'n/a'} and said **${verification?.verdict ?? 'n/a'}**.
${verification?.wrongValues.length ? verification.wrongValues.map((wrong) => `- ${wrong.item} ${wrong.field}: page "${wrong.page}", parsed "${wrong.parsed}"`).join('\n') : ''}

**Gemini's gate:** correct ${percent(answers?.correct)} · complete ${percent(answers?.complete)} · fails loudly ${percent(answers?.failsLoudly)}
${reasons.length ? `\nNot auto-merged: ${reasons.join('; ')}` : '\nAuto-merged and deployed: every threshold met.'}

Model cost: $${costUsd.toFixed(2)}`;
}
