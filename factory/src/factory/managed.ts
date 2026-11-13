// Runs a factory agent on DigitalOcean Managed Agents (Harness Runtime) instead of locally: Claude Code in a
// Firecracker microVM, on DigitalOcean Serverless Inference. Same options and result as `runAgent`, selected
// with AGENT_RUNTIME=do-managed. The sandbox gets the worktree's current files; when the run ends, the
// agent's changes come back as a git patch, only for paths the policy lets it write, and are applied to the
// local worktree, so the factory's own checks, limits and tests run unchanged. Notes in docs/managed-agents.md.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentOptions, AgentRun, ToolPolicy } from './agents.ts';

const API_BASE = 'https://api.digitalocean.com';
const DO_INFERENCE_HOST = 'inference.do-ai.run';
const SANDBOX_SIZE = 'mars-2vcpu-4gb';
const SEED_FILE = '.factory-seed.tar';
const PATCH_FILE = '.git/factory.patch';
// /workspace belongs to the agent's user, not to the exec user, so git would refuse it as dubious.
const GIT = "git -c safe.directory='*'";
const GIT_ARGV = ['git', '-c', 'safe.directory=*'];
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
// The download endpoint appends `DOWSSHA1` + 64 hex chars of SHA-256 + `\n` to every payload.
const FOOTER_BYTES = 73;

export type ManagedDeps = {
    // A DigitalOcean API token with the agent_harness_session scopes. Defaults to DO_API_TOKEN.
    token?: string;
    apiBase?: string;
    fetch?: typeof fetch;
    pollMs?: number;
    readyTimeoutMs?: number;
    runTimeoutMs?: number;
};

type Json = Record<string, unknown>;
type Api = {
    request: (method: string, path: string, init?: { json?: unknown; yaml?: string; body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
    json: <T = Json>(method: string, path: string, init?: Parameters<Api['request']>[2]) => Promise<T>;
};

function createApi(token: string, base: string, fetchImpl: typeof fetch): Api {
    const request: Api['request'] = async (method, path, init = {}) => {
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...init.headers };
        let body: BodyInit | undefined;
        if (init.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(init.json);
        } else if (init.yaml !== undefined) {
            headers['Content-Type'] = 'application/yaml';
            body = init.yaml;
        } else if (init.body !== undefined) {
            headers['Content-Type'] = 'application/octet-stream';
            body = init.body;
        }
        const response = await fetchImpl(`${base}${path}`, { method, headers, body, signal: init.signal });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 300);
            throw new Error(`DigitalOcean ${method} ${path.split('?')[0]} failed with ${response.status}: ${detail}`);
        }
        return response;
    };
    return {
        request,
        json: async (method, path, init) => {
            const text = await (await request(method, path, init)).text();
            return (text ? JSON.parse(text) : {}) as never;
        },
    };
}

type CommandResult = { code: number; stdout: Buffer<ArrayBuffer>; stderr: string };

function runCommand(command: string, args: string[], options: { cwd: string; input?: Buffer; env?: NodeJS.ProcessEnv }): Promise<CommandResult> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        child.on('error', reject);
        child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
        child.stdin.end(options.input);
    });
}

// The worktree as the agent would see it locally: tracked and untracked files, without ignored ones
// (node_modules, .env) and without .git. The sandbox commits this as its baseline.
export async function packWorktree(cwd: string): Promise<Buffer<ArrayBuffer>> {
    const listed = await runCommand('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd });
    if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr.slice(0, 200)}`);
    const files = [...new Set(listed.stdout.toString('utf8').split('\0'))].filter((file) => file && existsSync(join(cwd, file)));
    const tar = await runCommand('tar', ['-cf', '-', '--no-xattrs', '--null', '-T', '-'], {
        cwd,
        input: Buffer.from(files.map((file) => `${file}\0`).join('')),
        // macOS tar would add AppleDouble `._*` files otherwise.
        env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    if (tar.code !== 0) throw new Error(`tar failed: ${tar.stderr.slice(0, 200)}`);
    return tar.stdout;
}

function globsFor(prefix: string): string[] {
    return prefix.endsWith('/') ? [`/workspace/${prefix}**`] : [`/workspace/${prefix}*`, `/workspace/${prefix}*/**`];
}

// The policy as a Harness Runtime permission block. Anything not allowed is denied; nothing asks, because
// nobody is there to approve. Edits outside `writable` are denied in the sandbox (seen live), but Bash can
// still write anywhere there, so the patch filter in `collectPatch` is what really enforces `writable`.
export function buildPermissions(policy: ToolPolicy, tools: string[]): Json {
    const rules: Json[] = [{ tool: 'file.read', action: 'allow' }];
    if (tools.some((tool) => WRITE_TOOLS.has(tool))) {
        for (const prefix of policy.writable) {
            for (const path of globsFor(prefix)) rules.push({ tool: 'file.write', action: 'allow', match: { path }, enforcement: 'best-effort' });
        }
    }
    // Seen live on the claude-code harness: with these allow rules any command runs, and a catch-all bash deny
    // removes the shell altogether (allow rules after it don't bring it back). So agents with Bash get it
    // unrestricted inside the sandbox, and agents without it get none.
    if (tools.includes('Bash')) {
        for (const command of policy.commands) {
            rules.push({ tool: 'bash', action: 'allow', match: { command } }, { tool: 'bash', action: 'allow', match: { command: `${command} *` } });
        }
    } else {
        rules.push({ tool: 'bash', action: 'deny' });
    }
    return { default: 'deny', filesystem: { mode: 'workspace-write' }, rules };
}

// The environment spec, as JSON (YAML is a superset of JSON, so the YAML endpoint takes it as is).
export function buildSpec(options: AgentOptions, name: string): Json {
    const onDoInference = !options.baseUrl || options.baseUrl.includes('do-ai.run');
    const directAnthropic = !options.baseUrl;
    if (!onDoInference) throw new Error(`Managed Agents can't use the inference endpoint ${options.baseUrl}`);
    const env: Record<string, string> = {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        ...(options.smallModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: options.smallModel, ANTHROPIC_SMALL_FAST_MODEL: options.smallModel } : {}),
    };
    // Write-only secrets: never stored in the manifest or returned on GET.
    const secrets: Record<string, string> = {};
    if (directAnthropic) {
        env.ANTHROPIC_MODEL = options.model;
        secrets.ANTHROPIC_API_KEY = options.apiKey;
    } else {
        env.HARNESS_INFERENCE_MODEL = options.model;
        secrets.HARNESS_INFERENCE_API_KEY = options.apiKey;
    }
    return {
        name,
        description: 'selfheal factory agent run',
        harness: 'claude-code',
        size: SANDBOX_SIZE,
        idle_timeout: '30m',
        env,
        secrets,
        // Only the model endpoint; the platform adds its own hosts once an allowlist is on.
        egress: { allow_hosts: [directAnthropic ? 'api.anthropic.com' : DO_INFERENCE_HOST] },
        permissions: buildPermissions(options.policy, options.tools),
    };
}

export function buildInput(options: AgentOptions): string {
    const answer = options.schema
        ? `\n\nWhen you are done, end your reply with your final answer as one JSON object in a \`\`\`json code block, matching this JSON schema:\n${JSON.stringify(options.schema)}`
        : '';
    return `<instructions>\n${options.systemPrompt}\n</instructions>\n\nThe repository is in /workspace.\n\n${options.prompt}${answer}`;
}

// The last JSON object in the answer: a ```json block, the whole text, or the outermost braces.
export function extractJson(text: string, schema?: Record<string, unknown>): unknown {
    const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
    const candidates = [...blocks.reverse(), text.trim(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
    for (const candidate of candidates) {
        try {
            const value: unknown = JSON.parse(candidate);
            if (typeof value !== 'object' || value === null) continue;
            const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
            if (required.every((key) => key in value)) return value;
        } catch {
            // Not JSON; try the next candidate.
        }
    }
    return undefined;
}

type SessionEvent = { type?: string; event_id?: string; run_id?: string; data?: Json };

async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SessionEvent> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
            if (data) {
                try {
                    yield JSON.parse(data) as SessionEvent;
                } catch {
                    // Keepalives and malformed frames carry nothing for us.
                }
            }
            end = buffer.indexOf('\n\n');
        }
    }
}

function describeToolCall(name: string, input: unknown): string {
    const value = (input ?? {}) as Json;
    const detail = value.file_path ?? value.path ?? value.command ?? value.pattern;
    return typeof detail === 'string' ? `${name} ${detail.replace(/^\/workspace\//, '').slice(0, 80)}` : name;
}

type TurnResult = { ok: boolean; text: string; costUsd: number; error?: string };

async function runTurn(api: Api, sessionId: string, input: string, options: AgentOptions, timeoutMs: number): Promise<TurnResult> {
    const base = `/v2/agents/sessions/${sessionId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text = '';
    let costMicros = 0;
    let toolCalls = 0;
    const cancel = async (error: string): Promise<TurnResult> => {
        await api.request('POST', `${base}/cancel`, { json: {} }).catch(() => undefined);
        return { ok: false, text, costUsd: costMicros / 1e6, error };
    };
    try {
        // Attach before sending the input so no event of the run is missed.
        const stream = await api.request('GET', `${base}/events`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
        if (!stream.body) throw new Error('the event stream has no body');
        const { run_id: runId } = await api.json<{ run_id?: string }>('POST', `${base}/input`, { json: { text: input } });
        const seen = new Set<string>();
        for await (const event of readEvents(stream.body)) {
            if (process.env.MANAGED_DEBUG) console.error(`[managed] ${event.type} ${event.run_id ?? ''} ${JSON.stringify(event.data ?? {}).slice(0, 300)}`);
            if (event.event_id) {
                if (seen.has(event.event_id)) continue;
                seen.add(event.event_id);
            }
            if (runId && event.run_id && event.run_id !== runId) continue;
            const data = event.data ?? {};
            switch (event.type) {
                case 'run.token_delta':
                    text += typeof data.text === 'string' ? data.text : '';
                    break;
                case 'run.tool_call_started':
                    // Keep only the text after the last tool call, like `runAgent` keeps the last text block.
                    text = '';
                    toolCalls += 1;
                    options.onStep?.(describeToolCall(String(data.name ?? 'tool'), data.input));
                    // Harness Runtime has no turn limit, so maxTurns caps tool calls instead.
                    if (toolCalls > options.maxTurns) return await cancel(`the agent passed ${options.maxTurns} tool calls`);
                    break;
                case 'run.cost_accrued':
                    costMicros = Number(data.running_total_micros ?? costMicros);
                    if (costMicros / 1e6 > options.maxBudgetUsd) return await cancel(`the run passed the $${options.maxBudgetUsd} budget`);
                    break;
                case 'run.human_input_requested':
                    return await cancel(`the agent asked for an approval: ${JSON.stringify(data.payload ?? {}).slice(0, 200)}`);
                case 'run.completed':
                    return { ok: true, text, costUsd: Number(data.run_cost_micros ?? costMicros) / 1e6 };
                case 'run.failed':
                    return { ok: false, text, costUsd: costMicros / 1e6, error: `${data.code ?? 'failed'}: ${String(data.message ?? '').slice(0, 300)}` };
            }
        }
        return { ok: false, text, costUsd: costMicros / 1e6, error: 'the event stream ended before the run finished' };
    } catch (error) {
        if (controller.signal.aborted) return await cancel(`the run took longer than ${Math.round(timeoutMs / 60_000)} minutes`);
        throw error;
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

type ExecResult = { exit_code?: number; stdout?: string; stderr?: string };

async function exec(api: Api, sessionId: string, argv: string[]): Promise<ExecResult> {
    const result = await api.json<ExecResult>('POST', `/v2/agents/sessions/${sessionId}/sandbox/exec`, {
        json: { argv, workdir: '/workspace', timeout_seconds: 240 },
    });
    if ((result.exit_code ?? 0) !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} failed in the sandbox: ${(result.stderr || result.stdout || '').slice(0, 300)}`);
    return result;
}

async function download(api: Api, sessionId: string, path: string): Promise<Buffer> {
    const response = await api.request('GET', `/v2/agents/sessions/${sessionId}/workspace/download?path=${encodeURIComponent(path)}`);
    const raw = Buffer.from(await response.arrayBuffer());
    const footer = raw.subarray(raw.length - FOOTER_BYTES).toString('latin1');
    const payload = raw.subarray(0, raw.length - FOOTER_BYTES);
    const match = /^DOWSSHA1([0-9a-f]{64})\n$/.exec(footer);
    if (!match || createHash('sha256').update(payload).digest('hex') !== match[1]) throw new Error(`the download of ${path} was truncated or corrupt`);
    return payload;
}

async function waitUntilReady(api: Api, sessionId: string, pollMs: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const body = await api.json<{ session?: Json } & Json>('GET', `/v2/agents/sessions/${sessionId}`);
        const status = String((body.session ?? body).status ?? '');
        if (status.endsWith('READY')) return;
        if (/FAILED|DESTROYED/.test(status)) throw new Error(`the session became ${status}`);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
    }
    throw new Error(`the sandbox wasn't ready after ${Math.round(timeoutMs / 1000)} s`);
}

export function isWritable(path: string, policy: ToolPolicy): boolean {
    return policy.writable.some((prefix) => path.startsWith(prefix));
}

// The agent's changes since the baseline, only under the writable prefixes. Symlinks never come back.
async function collectPatch(api: Api, sessionId: string, policy: ToolPolicy): Promise<{ patch?: Buffer; dropped: string[] }> {
    await exec(api, sessionId, [...GIT_ARGV, 'add', '-A']);
    const { stdout = '' } = await exec(api, sessionId, [...GIT_ARGV, 'diff', '--cached', '--name-only', '--no-renames', '-z']);
    const changed = stdout.split('\0').filter(Boolean);
    const allowed = changed.filter((path) => isWritable(path, policy));
    const dropped = changed.filter((path) => !isWritable(path, policy));
    if (allowed.length === 0) return { dropped };
    // `sh -c '... "$@"'` passes the paths as arguments, never through the shell.
    await exec(api, sessionId, ['sh', '-c', `${GIT} diff --cached --binary --no-renames -- "$@" > ${PATCH_FILE}`, 'sh', ...allowed]);
    const patch = await download(api, sessionId, PATCH_FILE);
    if (/^(new file mode|new mode|old mode) 120000$/m.test(patch.toString('latin1'))) throw new Error('the agent created a symlink');
    return { patch, dropped };
}

async function applyPatch(cwd: string, patch: Buffer): Promise<void> {
    const applied = await runCommand('git', ['apply', '--whitespace=nowarn', '-'], { cwd, input: patch });
    if (applied.code !== 0) throw new Error(`git apply failed: ${applied.stderr.slice(0, 300)}`);
}

export async function runAgentManaged<T>(options: AgentOptions, deps: ManagedDeps = {}): Promise<AgentRun<T>> {
    const token = deps.token ?? process.env.DO_API_TOKEN;
    if (!token) return { ok: false, text: '', costUsd: 0, error: 'AGENT_RUNTIME=do-managed needs DO_API_TOKEN (scopes agent_harness_session:create, read, update, delete)' };
    const api = createApi(token, deps.apiBase ?? API_BASE, deps.fetch ?? fetch);
    const name = `factory-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    let sessionId: string | undefined;
    let configId: string | undefined;
    let turn: TurnResult = { ok: false, text: '', costUsd: 0 };
    try {
        const seed = await packWorktree(options.cwd);
        const created = await api.json<{ session?: Json } & Json>('POST', '/v2/agents/sessions', { yaml: JSON.stringify(buildSpec(options, name)) });
        const session = (created.session ?? created) as Json;
        sessionId = typeof session.session_id === 'string' ? session.session_id : undefined;
        configId = typeof session.config_id === 'string' ? session.config_id : undefined;
        if (!sessionId) throw new Error('the create response had no session_id');
        options.onStep?.(`sandbox ${name} starting on DigitalOcean Managed Agents`);
        await waitUntilReady(api, sessionId, deps.pollMs ?? 2000, deps.readyTimeoutMs ?? 180_000);

        await api.request('POST', `/v2/agents/sessions/${sessionId}/workspace/upload?path=${encodeURIComponent(SEED_FILE)}`, {
            body: seed,
            headers: { 'X-Content-Sha256': createHash('sha256').update(seed).digest('hex') },
        });
        // Exec runs as another user than the one owning /workspace (the agent's), so git needs safe.directory,
        // and the extracted files go to the workspace owner so the agent can edit them.
        const seeded = await exec(api, sessionId, [
            'sh',
            '-c',
            // The harness keeps Claude Code's state and log in /workspace; never part of the patch.
            `set -e; tar --no-same-owner -xf ${SEED_FILE}; rm ${SEED_FILE}; ${GIT} init -q; printf '.agent-home/\\nclaude-code.log\\n' >> .git/info/exclude; ${GIT} add -A; ` +
                `${GIT} -c user.name=factory -c user.email=factory@localhost commit -q --no-verify --allow-empty -m baseline; ` +
                'owner=$(stat -c %u:%g . 2>/dev/null || true); ' +
                'if [ "$(id -u)" = 0 ] && [ -n "$owner" ]; then chown -R "$owner" .; fi; ' +
                'echo "exec as $(id -un), workspace owned by $(stat -c %U . 2>/dev/null || echo ?), node $(node --version 2>/dev/null || echo none)"',
        ]);
        options.onStep?.(`sandbox ready: ${(seeded.stdout ?? '').trim().slice(0, 120)}`);

        turn = await runTurn(api, sessionId, buildInput(options), options, deps.runTimeoutMs ?? 20 * 60_000);
        // Bring the changes back even when the run failed: a local run leaves them in the worktree too.
        const changes = await collectPatch(api, sessionId, options.policy).catch((error: unknown) => {
            if (turn.ok) throw error;
            return { patch: undefined, dropped: [] as string[] };
        });
        if (changes.dropped.length > 0) options.onStep?.(`dropped changes outside the writable paths: ${changes.dropped.join(', ').slice(0, 200)}`);
        if (changes.patch) await applyPatch(options.cwd, changes.patch);
        if (!turn.ok) return { ok: false, text: turn.text, costUsd: turn.costUsd, error: turn.error };
        if (!options.schema) return { ok: true, text: turn.text, costUsd: turn.costUsd };
        const output = extractJson(turn.text, options.schema);
        if (output === undefined) return { ok: false, text: turn.text, costUsd: turn.costUsd, error: 'the answer had no JSON object matching the schema' };
        return { ok: true, output: output as T, text: turn.text, costUsd: turn.costUsd };
    } catch (error) {
        return { ok: false, text: turn.text, costUsd: turn.costUsd, error: String(error).slice(0, 500) };
    } finally {
        // Remove the sandbox and the Environment Config that creating it saved (it holds the model key).
        if (sessionId) await api.request('DELETE', `/v2/agents/sessions/${sessionId}`).catch(() => options.onStep?.(`couldn't remove sandbox ${name}`));
        if (configId) await api.request('DELETE', `/v2/agents/configs/${configId}`).catch(() => options.onStep?.(`couldn't remove config of ${name}`));
    }
}
