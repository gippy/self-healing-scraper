import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import type { AgentOptions } from '../src/factory/agents.ts';
import { buildPermissions, buildSpec, extractJson, runAgentManaged } from '../src/factory/managed.ts';

const MODEL_KEY = 'model-access-key-for-tests';

let root: string;
let repo: string;
let sandbox: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-test-'));
    repo = join(root, 'repo');
    sandbox = join(root, 'sandbox');
    await mkdir(join(repo, 'src/parsers'), { recursive: true });
    await mkdir(sandbox);
    await writeFile(join(repo, 'src/parsers/index.js'), 'export const add = (a, b) => a - b;\n');
    await writeFile(join(repo, 'README.md'), '# scraper\n');
    await writeFile(join(repo, '.gitignore'), '.env\n');
    await writeFile(join(repo, '.env'), 'SECRET=never-uploaded\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    // Untracked but not ignored: the agent sees it locally, so the sandbox must too.
    await writeFile(join(repo, 'src/parsers/notes.txt'), 'untracked\n');
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function options(overrides: Partial<AgentOptions> = {}): AgentOptions {
    return {
        cwd: repo,
        model: 'kimi-k3.1-pro',
        apiKey: MODEL_KEY,
        baseUrl: 'https://inference.do-ai.run',
        smallModel: 'minimax-m3.1-flash',
        homeDir: join(root, 'home'),
        systemPrompt: 'You fix scrapers.',
        prompt: 'Fix add() in src/parsers/index.js.',
        tools: ['Read', 'Edit', 'Bash'],
        policy: { writable: ['src/parsers/'], commands: ['node --test'] },
        schema: { type: 'object', properties: { fixed: { type: 'boolean' } }, required: ['fixed'] },
        maxTurns: 10,
        maxBudgetUsd: 1,
        ...overrides,
    };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const frame = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;

// A fake Harness Runtime API: commands run for real in a temp folder that plays /workspace, and the
// "agent" edits files there when the input arrives.
function createFakeApi(agent: (dir: string) => Promise<Record<string, unknown>[]>) {
    const calls: string[] = [];
    let spec: Record<string, unknown> | undefined;
    let input = '';
    let polls = 0;
    let onInput: () => void = () => {};
    const inputArrived = new Promise<void>((resolveInput) => (onInput = resolveInput));

    const fakeFetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
        const { pathname, searchParams } = new URL(String(url));
        const method = init.method ?? 'GET';
        calls.push(`${method} ${pathname}`);
        assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer do-token');
        if (method === 'POST' && pathname === '/v2/agents/sessions') {
            assert.equal(new Headers(init.headers).get('Content-Type'), 'application/yaml');
            spec = JSON.parse(String(init.body));
            return json({ session: { session_id: 's-1', config_id: 'c-1', status: 'SESSION_STATUS_UPDATING' } });
        }
        if (method === 'GET' && pathname === '/v2/agents/sessions/s-1') {
            polls += 1;
            return json({ session: { session_id: 's-1', status: polls > 1 ? 'SESSION_STATUS_READY' : 'SESSION_STATUS_UPDATING' } });
        }
        if (pathname === '/v2/agents/sessions/s-1/workspace/upload') {
            const body = Buffer.from(init.body as Uint8Array);
            assert.equal(new Headers(init.headers).get('X-Content-Sha256'), createHash('sha256').update(body).digest('hex'));
            await writeFile(join(sandbox, searchParams.get('path') ?? ''), body);
            return json({});
        }
        if (pathname === '/v2/agents/sessions/s-1/sandbox/exec') {
            const { argv, workdir } = JSON.parse(String(init.body)) as { argv: string[]; workdir: string };
            assert.equal(workdir, '/workspace');
            const result = spawnSync(argv[0] ?? '', argv.slice(1), { cwd: sandbox, encoding: 'utf8' });
            return json({ exit_code: result.status, stdout: result.stdout, stderr: result.stderr });
        }
        if (pathname === '/v2/agents/sessions/s-1/workspace/download') {
            const payload = await readFile(join(sandbox, searchParams.get('path') ?? ''));
            const footer = `DOWSSHA1${createHash('sha256').update(payload).digest('hex')}\n`;
            return new Response(Buffer.concat([payload, Buffer.from(footer)]));
        }
        if (pathname === '/v2/agents/sessions/s-1/input') {
            input = (JSON.parse(String(init.body)) as { text: string }).text;
            onInput();
            return json({ run_id: 'r-1' });
        }
        if (pathname === '/v2/agents/sessions/s-1/events') {
            const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                    const encoder = new TextEncoder();
                    controller.enqueue(encoder.encode(frame({ type: 'stream.state', data: { state: 'live' } })));
                    await inputArrived;
                    controller.enqueue(encoder.encode(': keepalive\n\n'));
                    for (const event of await agent(sandbox)) controller.enqueue(encoder.encode(frame(event)));
                    controller.close();
                },
            });
            return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (method === 'DELETE' || pathname.endsWith('/cancel')) return json({});
        return new Response('not found', { status: 404 });
    };
    return { fakeFetch: fakeFetch as typeof fetch, calls, getSpec: () => spec, getInput: () => input };
}

const fixingAgent = async (dir: string) => {
    // The seed landed: tracked and untracked files, no ignored ones.
    assert.equal(await readFile(join(dir, 'src/parsers/notes.txt'), 'utf8'), 'untracked\n');
    await assert.rejects(readFile(join(dir, '.env')));
    await writeFile(join(dir, 'src/parsers/index.js'), 'export const add = (a, b) => a + b;\n');
    await writeFile(join(dir, 'src/parsers/index.test.js'), 'test\n');
    await writeFile(join(dir, 'README.md'), '# hacked\n');
    const started = { type: 'run.tool_call_started', event_id: 'e1', run_id: 'r-1', data: { name: 'Edit', input: { file_path: '/workspace/src/parsers/index.js' } } };
    return [
        { type: 'run.started', event_id: 'e0', run_id: 'r-1', data: {} },
        { type: 'run.token_delta', event_id: 'e0b', run_id: 'r-1', data: { text: 'Looking. ' } },
        started,
        started,
        { type: 'run.token_delta', event_id: 'e2', run_id: 'r-1', data: { text: 'Fixed.\n```json\n{"fixed": true}\n```' } },
        { type: 'run.token_delta', event_id: 'e3', run_id: 'other-run', data: { text: 'noise' } },
        { type: 'run.cost_accrued', event_id: 'e4', run_id: 'r-1', data: { running_total_micros: 9000, delta_micros: 9000 } },
        { type: 'run.completed', event_id: 'e5', run_id: 'r-1', data: { total_tokens_in: 100, total_tokens_out: 20, run_cost_micros: 12_300 } },
    ];
};

test('runs the agent in the sandbox and brings back only the writable changes', async () => {
    const fake = createFakeApi(fixingAgent);
    const steps: string[] = [];
    const run = await runAgentManaged<{ fixed: boolean }>(
        { ...options(), onStep: (line) => steps.push(line) },
        { token: 'do-token', fetch: fake.fakeFetch, pollMs: 1 },
    );

    assert.equal(run.error, undefined);
    assert.equal(run.ok, true);
    assert.deepEqual(run.output, { fixed: true });
    assert.equal(run.text, 'Fixed.\n```json\n{"fixed": true}\n```');
    assert.equal(run.costUsd, 0.0123);
    // The fix and the new test landed locally; the README change outside `writable` did not.
    assert.equal(await readFile(join(repo, 'src/parsers/index.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
    assert.equal(await readFile(join(repo, 'src/parsers/index.test.js'), 'utf8'), 'test\n');
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), '# scraper\n');
    assert.match(steps[1] ?? '', /^sandbox ready: exec as /);
    assert.deepEqual(steps.slice(2), ['Edit src/parsers/index.js', 'dropped changes outside the writable paths: README.md']);
    // The prompt carries the system prompt and the answer format.
    assert.match(fake.getInput(), /You fix scrapers\.[\s\S]*Fix add\(\)[\s\S]*"required":\["fixed"\]/);
    // The sandbox and its saved config are removed.
    assert.deepEqual(fake.calls.slice(-2), ['DELETE /v2/agents/sessions/s-1', 'DELETE /v2/agents/configs/c-1']);
});

test('the spec runs Claude Code on DigitalOcean inference with the key as a secret', () => {
    const spec = buildSpec(options(), 'factory-x');
    assert.equal(spec.harness, 'claude-code');
    assert.deepEqual(spec.secrets, { HARNESS_INFERENCE_API_KEY: MODEL_KEY });
    assert.equal((spec.env as Record<string, string>).HARNESS_INFERENCE_MODEL, 'kimi-k3.1-pro');
    assert.equal((spec.env as Record<string, string>).ANTHROPIC_DEFAULT_HAIKU_MODEL, 'minimax-m3.1-flash');
    assert.ok(!JSON.stringify(spec.env).includes(MODEL_KEY));
    assert.deepEqual(spec.egress, { allow_hosts: ['inference.do-ai.run'] });
    assert.throws(() => buildSpec(options({ baseUrl: 'https://example.com' }), 'factory-x'));
});

test('maps the tool policy to a deny-by-default permission block', () => {
    const permissions = buildPermissions({ writable: ['src/parsers/', 'tests/regressions/abc-'], commands: ['pnpm check'] }, ['Read', 'Write', 'Bash']);
    assert.equal(permissions.default, 'deny');
    assert.deepEqual(permissions.rules, [
        { tool: 'file.read', action: 'allow' },
        { tool: 'file.write', action: 'allow', match: { path: '/workspace/src/parsers/**' }, enforcement: 'best-effort' },
        { tool: 'file.write', action: 'allow', match: { path: '/workspace/tests/regressions/abc-*' }, enforcement: 'best-effort' },
        { tool: 'file.write', action: 'allow', match: { path: '/workspace/tests/regressions/abc-*/**' }, enforcement: 'best-effort' },
        { tool: 'bash', action: 'allow', match: { command: 'pnpm check' } },
        { tool: 'bash', action: 'allow', match: { command: 'pnpm check *' } },
    ]);
    // Without write tools or Bash, nothing but reads is allowed.
    assert.deepEqual(buildPermissions({ writable: ['src/'], commands: ['pnpm check'] }, ['Read']).rules, [{ tool: 'file.read', action: 'allow' }]);
});

test('finds the JSON answer', () => {
    const schema = { required: ['verdict'] };
    assert.deepEqual(extractJson('Done.\n```json\n{"verdict": "ok"}\n```', schema), { verdict: 'ok' });
    assert.deepEqual(extractJson('{"verdict": "ok"}', schema), { verdict: 'ok' });
    assert.deepEqual(extractJson('Answer: {"verdict": "ok"} thanks', schema), { verdict: 'ok' });
    assert.equal(extractJson('```json\n{"other": 1}\n```', schema), undefined);
    assert.equal(extractJson('no json here', schema), undefined);
});

test('a failed run still brings back its changes and reports the error', async () => {
    const fake = createFakeApi(async (dir) => {
        await writeFile(join(dir, 'src/parsers/index.js'), 'partial\n');
        return [{ type: 'run.failed', event_id: 'f1', run_id: 'r-1', data: { code: 'model_error', message: '403 from the provider' } }];
    });
    const run = await runAgentManaged(options(), { token: 'do-token', fetch: fake.fakeFetch, pollMs: 1 });
    assert.equal(run.ok, false);
    assert.match(run.error ?? '', /403 from the provider/);
    assert.equal(await readFile(join(repo, 'src/parsers/index.js'), 'utf8'), 'partial\n');
    assert.ok(fake.calls.includes('DELETE /v2/agents/sessions/s-1'));
});

test('without a DigitalOcean token it fails before creating anything', async () => {
    const saved = process.env.DO_API_TOKEN;
    delete process.env.DO_API_TOKEN;
    try {
        const run = await runAgentManaged(options(), { fetch: (() => assert.fail('no request expected')) as typeof fetch });
        assert.equal(run.ok, false);
        assert.match(run.error ?? '', /DO_API_TOKEN/);
    } finally {
        if (saved !== undefined) process.env.DO_API_TOKEN = saved;
    }
});

// The live proof, skipped in `pnpm check`. Needs DO_API_TOKEN and DO_MODEL_ACCESS_KEY in .env:
// MANAGED_LIVE=1 node --env-file-if-exists=.env --test --test-name-pattern=live tests/managed.test.ts
test('live: an agent on Managed Agents fixes a one-line bug and the patch lands locally', { skip: !process.env.MANAGED_LIVE, timeout: 15 * 60_000 }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'managed-live-'));
    try {
        await writeFile(join(scratch, 'math.js'), 'export const add = (a, b) => a - b;\n');
        await writeFile(
            join(scratch, 'math.test.js'),
            "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from './math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\n",
        );
        await writeFile(join(scratch, 'package.json'), '{ "type": "module" }\n');
        const git = (...args: string[]) => execFileSync('git', args, { cwd: scratch, stdio: 'ignore' });
        git('init', '-q');
        git('add', '-A');
        git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
        // A clean env: inside `node --test`, NODE_TEST_CONTEXT would make the nested run report to this one.
        const runTests = () => spawnSync('node', ['--test'], { cwd: scratch, env: { PATH: process.env.PATH } }).status;
        assert.notEqual(runTests(), 0);

        const run = await runAgentManaged<{ fixed: boolean; summary: string }>({
            cwd: scratch,
            model: process.env.FIXER_MODEL ?? 'kimi-k3.1-pro',
            apiKey: process.env.DO_MODEL_ACCESS_KEY ?? '',
            baseUrl: 'https://inference.do-ai.run',
            smallModel: process.env.SMALL_MODEL ?? 'minimax-m3.1-flash',
            homeDir: join(scratch, '.home'),
            systemPrompt: 'You fix bugs in small JavaScript projects. Change as little as possible.',
            prompt: 'The test in math.test.js fails. Run `node --test`, fix the bug in math.js, and run `node --test` again.',
            tools: ['Read', 'Glob', 'Grep', 'Edit', 'Bash'],
            policy: { writable: ['math.js'], commands: ['node --test'] },
            schema: { type: 'object', properties: { fixed: { type: 'boolean' }, summary: { type: 'string' } }, required: ['fixed', 'summary'] },
            maxTurns: 20,
            maxBudgetUsd: 0.5,
            onStep: (line) => console.log(`  step: ${line}`),
        });
        console.log(`  ok=${run.ok} cost=$${run.costUsd} output=${JSON.stringify(run.output)} error=${run.error ?? ''}`);
        assert.equal(run.ok, true, run.error);
        assert.equal(runTests(), 0);
        assert.match(execFileSync('git', ['diff'], { cwd: scratch, encoding: 'utf8' }), /\+export const add = \(a, b\) => a \+ b;/);
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});
