import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { dashboardRoutes } from './dashboard/routes.ts';
import { EventStore, logEvent } from './dashboard/store.ts';
import { factoryRoutes } from './factory/routes.ts';
import { triageRoutes } from './triage/http.ts';
import { defaultDeps, startIssue } from './triage/pipeline.ts';
import { startPolling } from './triage/poll.ts';
import type { PipelineEvent } from './types.ts';

const store = new EventStore();
const emit = (event: PipelineEvent) => {
    store.push(event);
    logEvent(event);
};
const deps = defaultDeps(emit);
const start = (issue: Parameters<typeof startIssue>[0], origin: Parameters<typeof startIssue>[1]) => startIssue(issue, origin, deps);

const app = new Hono();
app.get('/health', (c) => c.text('ok'));
app.route('/', triageRoutes(start));
app.route('/', dashboardRoutes(store));
// POST /scrapers (create a scraper) and GET /scrapers (the registry), from the factory.
app.route('/', factoryRoutes(emit));

if (process.env.POLL_SENTRY === '1') startPolling(start);
if (process.env.FAKE_EXTERNALS === '1') console.log('FAKE_EXTERNALS=1: Sentry, the prompt guard, Gemini, Gemini Decision 1 and the scraper pause answer with canned data');

const port = Number(process.env.PORT ?? 8083);
serve({ fetch: app.fetch, port }, () => console.log(`selfheal-factory listening on http://localhost:${port}`));
