import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { FactoryConfig } from './config.ts';
import type { FileChange } from './limits.ts';

export type RunResult = { code: number; stdout: string; stderr: string };

// Commands that run the target repo's code (install, tests) get this environment and nothing else: the
// code under test was just written by a model that read untrusted data, so it must not see our secrets.
export function getSandboxEnv(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', NODE_ENV: 'test' };
}

export function run(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
    return new Promise((resolve) => {
        execFile(
            command,
            args,
            {
                cwd: options.cwd,
                env: options.env ?? process.env,
                timeout: options.timeoutMs ?? 300_000,
                maxBuffer: 20 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
                const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
                resolve({ code, stdout: String(stdout), stderr: String(stderr) });
            },
        );
    });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
    const result = await run('git', args, { cwd });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${hideToken(result.stderr).slice(0, 500)}`);
    return result.stdout.trim();
}

// Tokens in clone URLs must never reach logs or the dashboard.
export function hideToken(text: string): string {
    return text.replaceAll(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

// With a token, HTTPS with the token; without one, SSH with the machine's own key (Jarda's laptop).
function getCloneUrl(config: FactoryConfig): string {
    if (!/^[\w.-]+\/[\w.-]+$/.test(config.targetRepo)) return config.targetRepo;
    return config.githubToken
        ? `https://x-access-token:${config.githubToken}@github.com/${config.targetRepo}.git`
        : `git@github.com:${config.targetRepo}.git`;
}

// `path` is the monorepo worktree; `dir` is the scraper's folder in it (`rel`, e.g. `scrapers/auction-house`),
// where installs, tests and agents run.
export type Workspace = { path: string; branch: string; base: string; rel: string; dir: string };

// A fresh worktree on `branch`, cut from the newest default branch. A rerun with the same branch starts over.
export async function prepareWorkspace(config: FactoryConfig, branch: string, rel: string): Promise<Workspace> {
    const repo = join(config.workDir, 'repo');
    await mkdir(config.workDir, { recursive: true });
    if (existsSync(join(repo, '.git'))) await git(repo, 'fetch', '--prune', 'origin');
    else await git(config.workDir, 'clone', '--quiet', getCloneUrl(config), repo);

    const base = await git(repo, 'rev-parse', 'origin/HEAD').catch(() => git(repo, 'rev-parse', 'origin/main'));
    const path = join(config.workDir, 'worktrees', branch.replaceAll('/', '-'));
    await run('git', ['worktree', 'remove', '--force', path], { cwd: repo });
    await run('git', ['worktree', 'prune'], { cwd: repo });
    await run('git', ['branch', '-D', branch], { cwd: repo });
    await git(repo, 'worktree', 'add', '--quiet', '-b', branch, path, base);
    return { path, branch, base, rel, dir: join(path, rel) };
}

export async function installDependencies(workspace: Workspace): Promise<RunResult> {
    return run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
        cwd: workspace.dir,
        env: getSandboxEnv(),
        timeoutMs: 240_000,
    });
}

export async function runTestFile(workspace: Workspace, file: string): Promise<RunResult> {
    return run('node', ['--test', file], { cwd: workspace.dir, env: getSandboxEnv(), timeoutMs: 120_000 });
}

export async function runCheck(workspace: Workspace): Promise<RunResult> {
    return run('pnpm', ['check'], { cwd: workspace.dir, env: getSandboxEnv(), timeoutMs: 240_000 });
}

// Runs the scraper's parser on one page and returns its items as JSON, or the error it threw.
export async function runParser(workspace: Workspace, pagePath: string, url: string): Promise<{ items?: unknown[]; error?: string }> {
    const script = `import { readFileSync } from 'node:fs';
import { parse } from './src/parsers/index.ts';
try { console.log(JSON.stringify({ items: parse(readFileSync(process.argv[1], 'utf8'), process.argv[2]) })); }
catch (error) { console.log(JSON.stringify({ error: String(error) })); }`;
    const result = await run('node', ['--input-type=module', '-e', script, pagePath, url], {
        cwd: workspace.dir,
        env: getSandboxEnv(),
        timeoutMs: 60_000,
    });
    try {
        return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as { items?: unknown[]; error?: string };
    } catch {
        return { error: `the parser could not run: ${(result.stderr || result.stdout).slice(0, 500)}` };
    }
}

// Every change against the base, new files included. Paths are relative to the scraper's folder; a change
// outside it keeps its repo path with a `../` prefix, so the limits reject it.
export async function getChanges(workspace: Workspace): Promise<{ changes: FileChange[]; diff: string }> {
    await git(workspace.path, 'add', '--all');
    const numstat = await git(workspace.path, 'diff', '--cached', '--numstat', workspace.base);
    const prefix = `${workspace.rel}/`;
    const changes = numstat
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [added = '0', removed = '0', path = ''] = line.split('\t');
            const file = path.startsWith(prefix) ? path.slice(prefix.length) : `../${path}`;
            // Binary files show `-`; count them as one line so they can't hide.
            return { file, added: Number(added) || 1, removed: Number(removed) || 0 };
        });
    const diff = await git(workspace.path, 'diff', '--cached', workspace.base);
    return { changes, diff };
}

export async function commitAll(workspace: Workspace, message: string): Promise<string> {
    await git(workspace.path, 'add', '--all');
    await git(
        workspace.path,
        '-c',
        'user.name=selfheal-factory',
        '-c',
        'user.email=factory@selfheal.invalid',
        'commit',
        '--quiet',
        '-m',
        message,
    );
    return git(workspace.path, 'rev-parse', 'HEAD');
}

export async function pushBranch(workspace: Workspace): Promise<void> {
    await git(workspace.path, 'push', '--force', '--quiet', 'origin', `HEAD:refs/heads/${workspace.branch}`);
}
