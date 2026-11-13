import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GuardResult } from '../../src/guard.ts';
import type { Attachment, IssueInfo, Priority } from '../../src/sentry.ts';
import { runPipeline, type PipelineDeps } from '../../src/triage/pipeline.ts';
import type { Triage } from '../../src/triage/questions.ts';
import type { FactoryInput, PipelineEvent } from '../../src/types.ts';

const ISSUE: IssueInfo = {
    id: '42',
    shortId: 'FEED-42',
    title: 'ParseError: shop: no .lot elements found',
    permalink: 'https://example.sentry.io/issues/42/',
    projectSlug: 'selfheal-feed',
};
const MARKDOWN = '# ParseError\nshop: no .lot elements found\nAuthorization: Bearer abcdef0123456789abcdef';
const PAGE: Attachment = { name: 'raw.html', content: '<main class="auction-grid"><article class="tile"></article></main>' };
const clean: GuardResult = { verdict: 'clean', findings: [], ms: 1 };
const critical: Triage = { severity: { benign: 0.02, minor: 0.14, critical: 0.84 }, fixable: 0.93, model: 'gemini-decision-1', ms: 900 };
const READING = 'The site changed its markup; the parser finds no lots.';

type Harness = {
    deps: PipelineDeps;
    events: PipelineEvent[];
    priorities: Priority[];
    paused: string[];
    guarded: string[];
    triaged: string[];
    explained: Array<{ markdown: string; logs: string }>;
    factoryInputs: FactoryInput[];
};

function harness(overrides: Partial<PipelineDeps> = {}): Harness {
    const h: Harness = { events: [], priorities: [], paused: [], guarded: [], triaged: [], explained: [], factoryInputs: [] } as unknown as Harness;
    h.deps = {
        emit: (event) => h.events.push(event),
        getIssue: async () => ISSUE,
        getLatestEvent: async () => ({
            eventId: 'abc123',
            markdown: MARKDOWN,
            tags: { scraper: 'auction-house' },
            logs: '19:02 info fetch with token=abc123secretvalue',
        }),
        getAttachment: async () => PAGE,
        getRecentLogs: async (scraper) => `19:01 info poll ${scraper}: 60 items`,
        setPriority: async (_id, priority) => void h.priorities.push(priority),
        addNote: async () => false,
        pauseScraper: async (scraper) => {
            h.paused.push(scraper);
            return { ok: true, url: `https://${scraper}.example` };
        },
        guard: async (text) => {
            h.guarded.push(text);
            return clean;
        },
        explain: async (markdown, logs) => {
            h.explained.push({ markdown, logs });
            return READING;
        },
        askTriage: async (input) => {
            h.triaged.push(input);
            return critical;
        },
        runFactory: async (input, emit) => {
            h.factoryInputs.push(input);
            emit({ issueId: input.issue.id, shortId: input.issue.shortId, title: input.issue.title, stage: 'worktree', status: 'started', summary: 'x', at: new Date().toISOString() });
            return { outcome: 'pr_open', reason: 'test' };
        },
        ...overrides,
    };
    return h;
}

const stages = (events: PipelineEvent[]) => events.map((e) => `${e.stage}:${e.status}`);

test('critical and fixable: every triage stage, then the factory gets the redacted evidence', async () => {
    const h = harness();
    await runPipeline(ISSUE, 'webhook', h.deps);
    assert.deepEqual(stages(h.events), [
        'received:done',
        'evidence:started',
        'evidence:done',
        'guard:started',
        'guard:done',
        'triage:started',
        'triage:started',
        'triage:done',
        'priority_set:done',
        'source_paused:done',
        'routed:done',
        'worktree:started',
    ]);
    assert.deepEqual(h.priorities, ['high']);
    assert.deepEqual(h.paused, ['auction-house']);
    assert.equal(h.factoryInputs.length, 1);
    const input = h.factoryInputs[0]!;
    assert.equal(input.scraper, 'auction-house');
    assert.deepEqual(input.attachment, PAGE);
    assert.deepEqual(input.triage, { severity: critical.severity, fixable: 0.93 });
    // Redacted before the guard, Gemini, Decisions and the factory saw it.
    for (const secret of ['abcdef0123456789abcdef', 'abc123secretvalue']) {
        assert.ok(!input.eventMarkdown.includes(secret));
        assert.ok(h.guarded.every((text) => !text.includes(secret)));
        assert.ok(!JSON.stringify(h.explained).includes(secret));
        assert.ok(!h.triaged.join('').includes(secret));
    }
    // The event, the attachment and the logs went through the guard before Gemini read them.
    assert.equal(h.guarded.length, 3);
    assert.match(h.explained[0]!.logs, /poll auction-house: 60 items/);
    // Gemini's reading is part of the Decisions input and of the dashboard event.
    assert.match(h.triaged[0]!, /Gemini\)\n.*The site changed its markup/);
    assert.match(h.triaged[0]!, /Scraper: auction-house/);
    const triageDone = h.events.find((e) => e.stage === 'triage' && e.status === 'done')!;
    assert.equal((triageDone.data as { explanation: string }).explanation, READING);
    assert.ok(h.events.every((e) => e.issueId === '42' && e.shortId === 'FEED-42'));
    // Every event from the pipeline says it's a heal run; after the evidence, which scraper.
    const own = h.events.filter((e) => e.stage !== 'worktree'); // the last one comes from the mock factory
    assert.ok(own.every((e) => e.kind === 'heal'));
    assert.ok(own.slice(2).every((e) => e.scraper === 'auction-house'));
});

test('flagged by the guard: no model sees it, high, paused, needs_human', async () => {
    const h = harness({
        guard: async (text) =>
            text.includes('auction-grid')
                ? { verdict: 'flagged', findings: [{ type: 'injection', detail: 'ignore your instructions' }], ms: 1 }
                : clean,
    });
    await runPipeline(ISSUE, 'webhook', h.deps);
    assert.equal(h.triaged.length, 0);
    assert.equal(h.explained.length, 0);
    assert.equal(h.factoryInputs.length, 0);
    assert.deepEqual(h.priorities, ['high']);
    assert.deepEqual(h.paused, ['auction-house']);
    assert.deepEqual(stages(h.events).slice(-5), ['guard:done', 'priority_set:done', 'source_paused:done', 'routed:done', 'needs_human:done']);
    const human = h.events.at(-1)!;
    assert.equal(human.stage, 'needs_human');
    assert.deepEqual((human.data as { findings: unknown[] }).findings, [{ type: 'injection', detail: 'ignore your instructions', part: 'raw.html' }]);
});

test('unchecked by the guard is treated like flagged', async () => {
    const h = harness({ guard: async () => ({ verdict: 'unchecked', findings: [], reason: 'down', ms: 1 }) });
    await runPipeline(ISSUE, 'poll', h.deps);
    assert.equal(h.triaged.length, 0);
    assert.deepEqual(h.priorities, ['high']);
    assert.equal(h.events.at(-1)!.stage, 'needs_human');
});

test('benign: low priority, the scraper keeps running, nothing else', async () => {
    const h = harness({ askTriage: async () => ({ ...critical, severity: { benign: 0.88, minor: 0.09, critical: 0.03 } }) });
    await runPipeline(ISSUE, 'webhook', h.deps);
    assert.deepEqual(h.priorities, ['low']);
    assert.deepEqual(h.paused, []);
    assert.equal(h.factoryInputs.length, 0);
    const routed = h.events.at(-1)!;
    assert.equal(routed.stage, 'routed');
    assert.equal((routed.data as { route: string }).route, 'done');
});

test('no Decisions answer: high, paused, needs_human', async () => {
    const h = harness({ askTriage: async () => undefined });
    await runPipeline(ISSUE, 'webhook', h.deps);
    assert.ok(stages(h.events).includes('triage:failed'));
    assert.deepEqual(h.priorities, ['high']);
    assert.deepEqual(h.paused, ['auction-house']);
    assert.equal(h.events.at(-1)!.stage, 'needs_human');
    assert.equal(h.factoryInputs.length, 0);
});

test('not fixable: priority by severity, paused, needs_human', async () => {
    const h = harness({ askTriage: async () => ({ ...critical, severity: { benign: 0.06, minor: 0.61, critical: 0.33 }, fixable: 0.12 }) });
    await runPipeline(ISSUE, 'webhook', h.deps);
    assert.deepEqual(h.priorities, ['medium']);
    assert.deepEqual(h.paused, ['auction-house']);
    assert.equal(h.events.at(-1)!.stage, 'needs_human');
});

test('Sentry failing to fetch the event escalates instead of dropping', async () => {
    const h = harness({
        getLatestEvent: async () => {
            throw new Error('HTTP 502');
        },
    });
    await runPipeline(ISSUE, 'webhook', h.deps);
    assert.ok(stages(h.events).includes('evidence:failed'));
    assert.deepEqual(h.priorities, ['high']);
    assert.equal(h.events.at(-1)!.stage, 'needs_human');
});

test('a failing priority write or pause is shown but does not stop the pipeline', async () => {
    const h = harness({
        setPriority: async () => {
            throw new Error('HTTP 403');
        },
        pauseScraper: async () => ({ ok: false, error: 'scraper "auction-house" is not in the registry' }),
    });
    await runPipeline(ISSUE, 'webhook', h.deps);
    assert.ok(stages(h.events).includes('priority_set:failed'));
    assert.ok(stages(h.events).includes('source_paused:failed'));
    assert.equal(h.factoryInputs.length, 1);
});

test('a manual run loads the issue first; a crashing factory is reported as failed', async () => {
    const h = harness({
        runFactory: async () => {
            throw new Error('boom');
        },
    });
    await runPipeline({ id: '42' }, 'manual', h.deps);
    assert.equal(h.events[0]!.shortId, 'FEED-42');
    const last = h.events.at(-1)!;
    assert.equal(last.stage, 'failed');
    assert.match(last.summary, /boom/);
});

test('the older `source` tag still names the scraper; no tag means a failed pause, and triage goes on', async () => {
    const legacy = harness({ getLatestEvent: async () => ({ eventId: 'e', markdown: MARKDOWN, tags: { source: 'shop' }, logs: '' }) });
    await runPipeline(ISSUE, 'poll', legacy.deps);
    assert.deepEqual(legacy.paused, ['shop']);

    const untagged = harness({ getLatestEvent: async () => ({ eventId: 'e', markdown: MARKDOWN, tags: {}, logs: '' }) });
    await runPipeline(ISSUE, 'poll', untagged.deps);
    assert.ok(stages(untagged.events).includes('source_paused:failed'));
    assert.equal(untagged.factoryInputs.length, 1);
});

test('without a reading from Gemini, triage still asks Decisions', async () => {
    const h = harness({ explain: async () => undefined });
    await runPipeline(ISSUE, 'poll', h.deps);
    assert.match(h.triaged[0]!, /\(not available\)/);
    assert.equal(h.factoryInputs.length, 1);
});
