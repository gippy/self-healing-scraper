import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { scraperStatuses } from '../feed.ts';
import type { PipelineEvent } from '../types.ts';
import { renderCard, renderPage, renderScrapers, type PauseHint } from './render.ts';
import type { EventStore } from './store.ts';

// GET / — the dashboard. GET /scrapers.html — the scrapers panel (the page refreshes it every 15 s).
// GET /events — SSE: on connect, the recent `pipeline` events (PipelineEvent JSON) and one `card` per run
// (rendered HTML); then both live as events arrive, plus `scrapers` when a scraper is paused or resumed.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// What the factory itself did to each scraper, from the pause and resume events it emitted: paused for an
// issue, healing while the factory works on that issue, running again once resumed.
const HEALING_STAGES = new Set(['worktree', 'reproduce', 'fix', 'review', 'gate', 'pr_opened', 'merged', 'deploy', 'deployed']);

export function pauseHints(events: PipelineEvent[]): Map<string, PauseHint> {
    const hints = new Map<string, PauseHint>();
    const pausedBy = new Map<string, string>();
    for (const event of events) {
        const data = isRecord(event.data) ? event.data : {};
        const name = event.scraper ?? (typeof data.scraper === 'string' ? data.scraper : typeof data.source === 'string' ? data.source : undefined);
        const forIssue = pausedBy.get(event.issueId);
        if (forIssue && hints.get(forIssue)?.paused) {
            const hint = hints.get(forIssue)!;
            if (HEALING_STAGES.has(event.stage)) hint.healing = event.status !== 'failed';
            if (event.stage === 'needs_human' || event.stage === 'failed') hint.healing = false;
        }
        if (event.status !== 'done' || (event.stage !== 'source_paused' && event.stage !== 'source_resumed')) continue;
        if (!name) continue;
        hints.set(name, { paused: event.stage === 'source_paused', healing: false, issue: event.shortId, at: event.at });
        if (event.stage === 'source_paused') pausedBy.set(event.issueId, name);
        else pausedBy.delete(event.issueId);
    }
    return hints;
}

export function dashboardRoutes(store: EventStore): Hono {
    const app = new Hono();
    const scrapersHtml = async (maxAgeMs?: number) => renderScrapers(await scraperStatuses(maxAgeMs), pauseHints(store.recent()));

    app.get('/', async (c) => {
        const cards = store.issueIds().map((id) => renderCard(store.forIssue(id)));
        return c.html(renderPage({ cards, fake: process.env.FAKE_EXTERNALS === '1', scrapers: await scrapersHtml() }));
    });

    app.get('/scrapers.html', async (c) => c.html(await scrapersHtml()));

    app.get('/events', (c) =>
        streamSSE(c, async (stream) => {
            let closed = false;
            let id = 0;
            // Writes are chained so events arrive in order.
            let chain: Promise<unknown> = Promise.resolve();
            const write = (event: string, data: unknown) => {
                chain = chain.then(() => (closed ? undefined : stream.writeSSE({ event, data: JSON.stringify(data), id: String(++id) })));
                return chain;
            };
            const card = (issueId: string, replay: boolean) => write('card', { issueId, html: renderCard(store.forIssue(issueId)), replay });

            const unsubscribe = store.subscribe((event: PipelineEvent) => {
                void write('pipeline', event);
                void card(event.issueId, false);
                const breaker = (event.stage === 'source_paused' || event.stage === 'source_resumed') && event.status !== 'started';
                if (breaker || event.stage === 'worktree' || event.stage === 'needs_human' || event.stage === 'failed') {
                    void scrapersHtml(0).then((html) => write('scrapers', { html })).catch(() => undefined);
                }
            });
            stream.onAbort(() => {
                closed = true;
                unsubscribe();
            });

            for (const event of store.recent()) void write('pipeline', event);
            // Oldest first: the page prepends, so the newest ends on top.
            for (const issueId of store.issueIds().reverse()) void card(issueId, true);
            await chain;

            while (!closed) {
                await stream.sleep(20_000);
                if (!closed) await write('ping', { at: new Date().toISOString() });
            }
        }),
    );

    return app;
}
