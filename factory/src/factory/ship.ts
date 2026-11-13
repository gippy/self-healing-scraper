import type { FactoryConfig } from './config.ts';
import { run } from './workspace.ts';

// Opening and merging the PR, waiting for the deploy, and closing the Sentry issue.

function getGhEnv(config: FactoryConfig): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: process.env.HOME, ...(config.githubToken ? { GH_TOKEN: config.githubToken } : {}) };
}

export async function openPullRequest(
    config: FactoryConfig,
    branch: string,
    title: string,
    body: string,
): Promise<string> {
    const result = await run(
        'gh',
        ['pr', 'create', '--repo', config.targetRepo, '--head', branch, '--title', title, '--body', body],
        { env: getGhEnv(config) },
    );
    if (result.code !== 0) throw new Error(`gh pr create failed: ${result.stderr.slice(0, 500)}`);
    return result.stdout.trim().split('\n').at(-1) ?? '';
}

export async function mergePullRequest(config: FactoryConfig, prUrl: string): Promise<string> {
    const merged = await run('gh', ['pr', 'merge', prUrl, '--squash', '--delete-branch'], { env: getGhEnv(config) });
    if (merged.code !== 0) throw new Error(`gh pr merge failed: ${merged.stderr.slice(0, 500)}`);
    const view = await run('gh', ['pr', 'view', prUrl, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'], {
        env: getGhEnv(config),
    });
    return view.stdout.trim();
}

// Polls the feed's `GET /version` until it reports the merge commit. Resolves to false on timeout.
export async function waitForDeploy(feedUrl: string, commit: string, timeoutMs = 15 * 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(new URL('/version', feedUrl), { signal: AbortSignal.timeout(10_000) });
            if (response.ok) {
                const { release } = (await response.json()) as { release?: string };
                if (release && commit && (release.startsWith(commit.slice(0, 7)) || commit.startsWith(release))) return true;
            }
        } catch {
            // The app restarts during a deploy; keep polling.
        }
        await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    return false;
}

export async function resolveSentryIssue(issueId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (!env.SENTRY_AUTH_TOKEN || !env.SENTRY_ORG) return false;
    const response = await fetch(`https://sentry.io/api/0/organizations/${env.SENTRY_ORG}/issues/${issueId}/`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${env.SENTRY_AUTH_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
        signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
}

export async function resumeScraper(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (!env.SCRAPER_ADMIN_SECRET) return false;
    const response = await fetch(new URL('/resume', url), {
        method: 'POST',
        headers: { 'x-admin-secret': env.SCRAPER_ADMIN_SECRET },
        signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
}
