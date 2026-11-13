import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { listUnresolvedIssues, type IssueInfo } from '../sentry.ts';
import type { StartIssue } from './http.ts';

// POLL_SENTRY=1 (the main mode: the factory runs on a laptop without a public URL). Lists unresolved issues
// every 30 s and runs the ones it has not seen. Seen IDs are saved in `work/seen-issues.json`, so a restart
// runs only issues that appeared while it was down. On the very first start (no file yet) the issues already
// open are recorded, not run; POST /issues/:id/run runs one of those on demand.

export const seenPath = () => resolve(process.env.FACTORY_WORK_DIR || 'work', 'seen-issues.json');

export function loadSeen(path = seenPath()): Set<string> | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const ids = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return new Set(Array.isArray(ids) ? ids.map(String) : []);
    } catch (error) {
        console.warn(`[poll] could not read ${path}: ${(error as Error).message}; starting fresh`);
        return undefined;
    }
}

export function saveSeen(seen: Set<string>, path = seenPath()): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify([...seen], null, 2)}\n`);
    renameSync(tmp, path);
}

export type PollOptions = { intervalMs?: number; list?: () => Promise<IssueInfo[]>; path?: string };

// One poll: returns the issues it started. Exported for tests.
export function createPoller(startIssue: StartIssue, options: PollOptions = {}) {
    const { list = listUnresolvedIssues, path = seenPath() } = options;
    const loaded = loadSeen(path);
    const seen = loaded ?? new Set<string>();
    let baseline = loaded === undefined;

    return async function tick(): Promise<IssueInfo[]> {
        const issues = await list();
        if (baseline) {
            for (const issue of issues) seen.add(issue.id);
            baseline = false;
            saveSeen(seen, path);
            console.log(`[poll] first start: ${issues.length} unresolved issue(s) already open are recorded, not run`);
            return [];
        }
        const fresh = issues.filter((issue) => !seen.has(issue.id));
        for (const issue of fresh) seen.add(issue.id);
        // Saved before starting, so a crash mid-run doesn't run the issue again on restart.
        if (fresh.length) saveSeen(seen, path);
        for (const issue of fresh) startIssue(issue, 'poll');
        return fresh;
    };
}

export function startPolling(startIssue: StartIssue, options: PollOptions = {}): () => void {
    const { intervalMs = 30_000 } = options;
    const tick = createPoller(startIssue, options);
    const run = () =>
        tick().catch((error) => console.warn(`[poll] listing issues failed: ${(error as Error).message}`));
    console.log(`[poll] polling Sentry every ${intervalMs / 1000} s; seen issues in ${options.path ?? seenPath()}`);
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => clearInterval(timer);
}
