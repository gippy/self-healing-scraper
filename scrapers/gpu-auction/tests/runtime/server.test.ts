import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScraper } from '../../src/scraper.ts';
import { createServer } from '../../src/server.ts';
import { ITEMS, TARGET_URL, createMemorySink, createRecordingReporter } from './stubs.ts';

const SECRET = 'test-secret';

// Pass `null` to run without an admin secret.
function createTestServer(adminSecret: string | null = SECRET) {
  let fetches = 0;
  const scraper = createScraper({
    name: 'auction-house',
    targetUrl: TARGET_URL,
    fetchPage: async () => {
      fetches += 1;
      return { body: '<html></html>' };
    },
    parse: () => ITEMS,
    sink: createMemorySink().sink,
    reporter: createRecordingReporter().reporter,
  });
  const app = createServer({ scraper, release: 'abc123', adminSecret: adminSecret ?? undefined });
  return { app, scraper, getFetches: () => fetches };
}

function post(app: ReturnType<typeof createTestServer>['app'], path: string, body?: unknown, secret: string | null = SECRET) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-admin-secret': secret }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('admin routes', () => {
  it('pauses with { reason, issue } and resumes with the admin secret', async () => {
    const { app, scraper, getFetches } = createTestServer();

    const paused = await post(app, '/pause', { reason: 'parser is being fixed', issue: 'SCRAPERS-12' });
    assert.equal(paused.status, 200);
    assert.deepEqual(
      (({ paused, reason, issue }) => ({ paused, reason, issue }))((await paused.json()) as Record<string, unknown>),
      { paused: true, reason: 'parser is being fixed', issue: 'SCRAPERS-12' },
    );
    assert.equal(await scraper.pollIfRunning(), false);

    const resumed = await post(app, '/resume');
    assert.equal(resumed.status, 200);
    assert.equal(((await resumed.json()) as { paused: boolean }).paused, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getFetches(), 1);
  });

  it('accepts a pause without a body', async () => {
    const { app } = createTestServer();
    const response = await post(app, '/pause');
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { reason: string }).reason, 'Paused by the factory');
  });

  it('refuses a wrong secret, and every request when no secret is configured', async () => {
    assert.equal((await post(createTestServer().app, '/pause', {}, 'wrong')).status, 401);
    assert.equal((await post(createTestServer().app, '/resume', undefined, null)).status, 401);
    assert.equal((await post(createTestServer(null).app, '/pause', {})).status, 503);
  });

  it('refuses a body that is not JSON', async () => {
    const response = await createTestServer().app.request('/pause', {
      method: 'POST',
      headers: { 'x-admin-secret': SECRET },
      body: 'pause please',
    });
    assert.equal(response.status, 400);
  });
});

describe('read routes', () => {
  it('serves items, status, version, health and the status page', async () => {
    const { app, scraper } = createTestServer();
    await scraper.pollIfRunning();

    assert.deepEqual(await (await app.request('/items')).json(), ITEMS);
    assert.equal(((await (await app.request('/status')).json()) as { itemCount: number }).itemCount, 2);
    assert.deepEqual(await (await app.request('/version')).json(), { release: 'abc123' });
    assert.equal(await (await app.request('/health')).text(), 'ok');

    const page = await (await app.request('/')).text();
    assert.match(page, /<h1>auction-house<\/h1>/);
    assert.match(page, /Vintage Rubber Duck Debugger/);
    assert.match(page, /\$24\.00/);
  });

  it('escapes item text on the status page', async () => {
    const scraper = createScraper({
      name: 'auction-house',
      targetUrl: TARGET_URL,
      fetchPage: async () => ({ body: '' }),
      parse: () => [{ id: 'LOT-1', title: '<script>alert(1)</script>' }],
      sink: createMemorySink().sink,
      reporter: createRecordingReporter().reporter,
    });
    await scraper.pollIfRunning();
    const page = await (await createServer({ scraper, release: undefined, adminSecret: SECRET }).request('/')).text();
    assert.doesNotMatch(page, /<script>alert/);
  });
});
