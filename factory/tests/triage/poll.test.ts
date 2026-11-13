import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, mock, test } from 'node:test';

import type { IssueInfo } from '../../src/sentry.ts';
import { createPoller } from '../../src/triage/poll.ts';

const issue = (id: string): IssueInfo => ({ id, shortId: `SCRAPERS-${id}`, title: 'ParseError', permalink: '' });

let path: string;
beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), 'factory-poll-test-')), 'seen-issues.json');
    mock.method(console, 'log', () => {});
});

test('a fresh project with no issues runs the first issue that appears', async () => {
    let open: IssueInfo[] = [];
    const started: string[] = [];
    const tick = createPoller((i) => (started.push(i.id), true), { list: async () => open, path });
    assert.deepEqual(await tick(), []);
    assert.ok(existsSync(path));
    open = [issue('1')];
    await tick();
    assert.deepEqual(started, ['1']);
    await tick();
    assert.deepEqual(started, ['1']);
});

test('the first start records issues already open instead of running them', async () => {
    const started: string[] = [];
    const tick = createPoller((i) => (started.push(i.id), true), { list: async () => [issue('old')], path });
    await tick();
    await tick();
    assert.deepEqual(started, []);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), ['old']);
});

test('after a restart only issues it has not seen run', async () => {
    let open = [issue('1')];
    const first: string[] = [];
    const before = createPoller((i) => (first.push(i.id), true), { list: async () => open, path });
    await before();
    open = [issue('1'), issue('2')];
    await before();
    assert.deepEqual(first, ['2']);

    // Restart: a new poller reads the saved IDs; issue 3 appeared while it was down.
    open = [issue('1'), issue('2'), issue('3')];
    const second: string[] = [];
    const after = createPoller((i) => (second.push(i.id), true), { list: async () => open, path });
    await after();
    assert.deepEqual(second, ['3']);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).sort(), ['1', '2', '3']);
});
