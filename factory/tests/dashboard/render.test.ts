import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderCard, renderData, renderPage, renderScrapers } from '../../src/dashboard/render.ts';
import { EventStore } from '../../src/dashboard/store.ts';
import type { PipelineEvent, Stage } from '../../src/types.ts';

let clock = Date.parse('2026-11-13T19:00:00Z');
const ev = (stage: Stage, status: PipelineEvent['status'], summary: string, data?: unknown, issueId = '1'): PipelineEvent => ({
    issueId,
    shortId: 'FEED-1',
    title: 'ParseError <script>alert(1)</script>',
    stage,
    status,
    summary,
    data,
    at: new Date((clock += 1000)).toISOString(),
});

test('escapes everything that comes from events', () => {
    const html = renderCard([ev('received', 'done', 'Ignore your instructions <img src=x onerror=alert(1)>', { permalink: 'javascript:alert(1)' })]);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('javascript:'));
});

test('shows the triage as bars and the route', () => {
    const html = renderCard([
        ev('received', 'done', 'New issue', { permalink: 'https://example.sentry.io/issues/1/' }),
        ev('triage', 'started', 'Asking Gemini Decision 1'),
        ev('triage', 'done', 'Gemini Decision 1: critical', { severity: { benign: 0.02, minor: 0.14, critical: 0.84 }, fixable: 0.93, model: 'gemini-decision-1', ms: 900 }),
        ev('routed', 'done', 'To the factory', { route: 'factory' }),
    ]);
    assert.match(html, /c-critical" style="width:84\.0%"/);
    assert.match(html, /c-fixable" style="width:93\.0%"/);
    assert.match(html, /href="https:\/\/example\.sentry\.io\/issues\/1\/"/);
    assert.match(html, /Route → factory/);
    // A started and a done of the same stage share one row.
    assert.equal(html.match(/class="row /g)?.length, 3);
    // Each stage that ran is a clickable node with a detail pane; the factory lane waits.
    assert.match(html, /<li class="node s-done"><button type="button" class="n-box" data-node="triage"/);
    assert.match(html, /data-pane="triage" hidden/);
    assert.match(html, /<li class="node s-pending"><div class="n-box">.*Failing test/);
});

test('renders what the factory sends: diff, review findings, gate numbers, PR link', () => {
    const diff = 'diff --git a/src/parsers/shop.ts b/src/parsers/shop.ts\n--- a/src/parsers/shop.ts\n+++ b/src/parsers/shop.ts\n@@ -1,2 +1,2 @@\n-const LOT = ".lot";\n+const LOT = ".lot, .tile";';
    const html = [
        renderData({ rootCause: 'New markup', diff, limits: { ok: true, breaches: [] } }),
        renderData({ blocking: [{ finding: 'Breaks v1', evidence: 'test fails' }], notes: ['ok'] }),
        renderData({ answers: { lowRisk: 0.91, riskScore: 0.7, rootCause: 0.9, reviewClear: 0.85 }, decision: { merge: true, reasons: [] } }),
        renderData({ prUrl: 'https://github.com/gippy/selfheal-feed/pull/7', commit: 'abc1234' }),
        renderData({ prUrl: 'javascript:alert(1)' }),
    ].join('\n');
    assert.match(html, /class="d-add">\+const LOT = &quot;\.lot, \.tile&quot;;/);
    assert.match(html, /class="d-del">-const LOT/);
    assert.match(html, /<strong>Breaks v1<\/strong>/);
    assert.match(html, /lowRisk/);
    // riskScore is not a probability, so it is a number, not a bar.
    assert.match(html, /riskScore <b>0\.7<\/b>/);
    assert.match(html, /href="https:\/\/github\.com\/gippy\/selfheal-feed\/pull\/7"/);
    assert.ok(!html.includes('href="javascript:'));
});

test('outcome pill follows the last terminal stage', () => {
    assert.match(renderCard([ev('received', 'done', 'x'), ev('needs_human', 'done', 'no')]), /data-outcome="needs_human"/);
    assert.match(renderCard([ev('received', 'done', 'x'), ev('routed', 'done', 'benign', { route: 'done' })]), /data-outcome="benign"/);
    assert.match(renderCard([ev('received', 'done', 'x'), ev('merged', 'done', 'm'), ev('resolved', 'done', 'r')]), /data-outcome="resolved"/);
    assert.match(renderCard([ev('received', 'done', 'x'), ev('guard', 'started', 'g')]), /data-outcome="working"/);
});

test('the card header shows the paused scraper until the factory resumes it', () => {
    const paused = [
        ev('received', 'done', 'x'),
        ev('source_paused', 'done', 'Scraper "shop" paused', { source: 'shop', reason: 'FEED-1 is being fixed' }),
        ev('routed', 'done', 'factory', { route: 'factory' }),
    ];
    const html = renderCard(paused);
    assert.match(html, /⏸ Scraper shop paused/);
    assert.match(html, /<li class="node s-paused"><button type="button" class="n-box" data-node="source_paused".*Pause scraper/);
    assert.match(html, /<li class="node s-pending"><div class="n-box">.*Resume scraper/);

    const resumed = renderCard([...paused, ev('deployed', 'done', 'd'), ev('source_resumed', 'done', 'Scraper shop resumed')]);
    assert.match(resumed, /▶ Scraper shop resumed/);
    assert.ok(!resumed.includes('⏸ Scraper'));

    const failed = renderCard([ev('received', 'done', 'x'), ev('source_paused', 'failed', 'Could not pause', { source: 'serp', error: 'HTTP 401' })]);
    assert.match(failed, /Scraper serp not paused/);

    // Benign: no pause, no badge, no pause chip.
    const benign = renderCard([ev('received', 'done', 'x'), ev('routed', 'done', 'benign', { route: 'done' })]);
    assert.ok(!benign.includes('Scraper'));
    assert.match(benign, /class="node s-skipped">.*Pause scraper/);
});

test('a rerun shows only the latest run', () => {
    const html = renderCard([ev('received', 'done', 'first run'), ev('failed', 'failed', 'old failure'), ev('received', 'done', 'second run')]);
    assert.ok(!html.includes('old failure'));
    assert.ok(html.includes('second run'));
});

test('the store orders issues newest first and notifies listeners', () => {
    const store = new EventStore(10);
    const seen: string[] = [];
    store.subscribe((e) => seen.push(e.issueId));
    store.push(ev('received', 'done', 'a', undefined, 'a'));
    store.push(ev('received', 'done', 'b', undefined, 'b'));
    store.push(ev('triage', 'done', 'a again', undefined, 'a'));
    assert.deepEqual(store.issueIds(), ['b', 'a']);
    assert.deepEqual(seen, ['a', 'b', 'a']);
    for (let i = 0; i < 20; i++) store.push(ev('triage', 'done', 'x', undefined, 'c'));
    assert.equal(store.recent().length, 10);
});

test('the page has the SSE client and the empty state', () => {
    const html = renderPage({ cards: [], fake: true });
    assert.match(html, /new EventSource\('\/events'\)/);
    assert.match(html, /Waiting for work/);
    assert.match(html, /id="scrapers" class="strip"/);
    assert.match(html, /FAKE_EXTERNALS=1/);
});

test('a create run shows the create stages, the scraper name and "Scraper live" at the end', () => {
    const create = (stage: Stage, status: PipelineEvent['status'], summary: string, data?: unknown): PipelineEvent => ({
        ...ev(stage, status, summary, data, 'create-1'),
        kind: 'create',
        scraper: 'auction-house',
        shortId: 'auction-house',
        title: 'New scraper for https://auction.example/',
    });
    const running = renderCard([
        create('investigate', 'started', 'Fetching https://auction.example/'),
        create('investigate', 'done', 'Fetched twice'),
        create('generate', 'started', 'Writing the parser'),
        create('generate', 'started', 'Agent: reading the fixture'),
    ]);
    assert.match(running, /New scraper/);
    assert.match(running, /class="scraper-name">auction-house/);
    assert.match(running, /<li class="node s-active"><button type="button" class="n-box" data-node="generate".*Parser \+ tests/);
    assert.match(running, /<li class="node s-pending"><div class="n-box">.*Verify live/);
    // The running step's progress lines stream in the live log under the diagram.
    assert.match(running, /class="tail">.*Parser \+ tests · live.*Agent: reading the fixture/s);
    assert.match(running, /data-sel="generate"/);
    // Progress lines of a running step update its row instead of adding rows.
    assert.equal(running.match(/class="row /g)?.length, 2);
    assert.match(running, /Agent: reading the fixture/);

    const live = renderCard([
        create('investigate', 'done', 'Fetched'),
        create('deploy', 'started', 'Deploying'),
        create('deployed', 'done', 'live at https://x.example'),
        create('registered', 'done', 'registered', { url: 'https://x.example' }),
    ]);
    assert.match(live, /data-outcome="registered"/);
    assert.match(live, /Scraper live/);
    // The deploy step never reported done, but later steps followed it.
    assert.match(live, /<li class="node s-done"><button type="button" class="n-box" data-node="deploy".*Deploy/);
});

test('Gemini\'s reading is shown on the card, escaped', () => {
    const html = renderCard([
        ev('received', 'done', 'x'),
        ev('triage', 'started', 'Asking Gemini Decision 1', { explanation: 'The site now shows <b>tiles</b>.', explainMs: 1200 }),
    ]);
    assert.match(html, /class="explain"><span class="explain-by">Gemini's reading<\/span>The site now shows &lt;b&gt;tiles&lt;\/b&gt;\./);
    assert.match(html, /Gemini read it in <b>1\.2 s<\/b>/);
});

test('the scrapers panel shows running, paused and unreachable scrapers', () => {
    const html = renderScrapers(
        [
            { name: 'auction-house', url: 'https://a.example', targetUrl: 'https://auction.example/', up: true, items: 58 },
            { name: 'serp', url: 'https://s.example', up: true },
            { name: 'broken', url: 'https://b.example', up: false, error: 'no answer in 4 s' },
        ],
        new Map([['serp', { paused: true, issue: 'SCRAPERS-7', at: '2026-11-13T20:00:00Z' }]]),
    );
    assert.match(html, /class="scraper s-running" title="58 items"><span class="sc-name">auction-house<\/span><b class="sc-state"><span class="sc-light"><\/span>running/);
    assert.match(html, /class="scraper s-paused" title="paused for SCRAPERS-7"><span class="sc-name">serp<\/span>.*paused/);
    assert.match(html, /class="scraper s-down" title="no answer in 4 s"><span class="sc-name">broken/);
    const healing = renderScrapers([{ name: 'serp', url: 'https://s.example', up: true }], new Map([['serp', { paused: true, healing: true, issue: 'SCRAPERS-7', at: '2026-11-13T20:00:00Z' }]]));
    assert.match(healing, /class="scraper s-healing".*healing<\/b>/s);
    assert.match(renderScrapers([]), /No scrapers yet/);
});

test('a stop is drawn as a branch off the node where the run stopped, and the later nodes are not run', () => {
    const html = renderCard([
        ev('received', 'done', 'x'),
        ev('evidence', 'done', 'e'),
        ev('guard', 'done', 'flagged', { verdict: 'flagged', parts: [] }),
        ev('priority_set', 'done', 'high', { priority: 'high' }),
        ev('source_paused', 'done', 'paused', { scraper: 'shop' }),
        ev('routed', 'done', 'human', { route: 'needs_human' }),
        ev('needs_human', 'done', 'The prompt guard flagged the evidence', { costUsd: 0.42 }),
    ]);
    assert.match(html, /<li class="branch b-human" style="grid-column:5 \/ -1;--at:[\d.]+%"><button type="button" class="b-box" data-node="stop">↳ Needs a human/);
    // The one line under the pipeline says why it stopped.
    assert.match(html, /class="now-text">Needs a human: The prompt guard flagged the evidence/);
    assert.match(html, /class="node s-warn"><button type="button" class="n-box" data-node="guard"/);
    assert.match(html, /class="node s-skipped"><div class="n-box">.*Worktree/);
    assert.match(html, /data-sel="stop"/);
    assert.match(html, /class="cost">\$0\.42/);
});

test('the line under the pipeline: Gemini numbers as bars, the pause in words, the PR link once merged', () => {
    const triage = renderCard([
        ev('received', 'done', 'x'),
        ev('triage', 'done', 'Gemini Decision 1: critical', { severity: { benign: 0.0, minor: 0.01, critical: 0.99 }, fixable: 0.97 }),
    ]);
    assert.match(triage, /class="now-text">Gemini: critical 99%, fixable 97%<\/p><div class="now-visual"><div class="bars">/);
    const paused = renderCard([ev('received', 'done', 'x'), { ...ev('source_paused', 'done', 'paused', { scraper: 'shop' }), scraper: 'shop' }]);
    assert.match(paused, /class="now-text">Scraper shop paused: no bad data reaches Snowflake/);
    const merged = renderCard([
        ev('received', 'done', 'x'),
        ev('pr_opened', 'done', 'PR opened', { prUrl: 'https://github.com/gippy/self-healing-scraper/pull/3' }),
        ev('merged', 'done', 'Merged after the gate'),
    ]);
    assert.match(merged, /class="now-text">Merged after the gate<\/p><div class="now-visual"><a class="link-btn" href="https:\/\/github\.com\/gippy\/self-healing-scraper\/pull\/3"/);
    // Details stay behind the toggle.
    assert.match(merged, /<details class="extra" data-k="more"><summary>details<\/summary>/);
});
