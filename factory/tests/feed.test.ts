import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { pauseScraper, resumeScraper, scraperStatuses } from '../src/feed.ts';

beforeEach(() => {
    delete process.env.FAKE_EXTERNALS;
    // The registry (src/registry.ts) reads FACTORY_WORK_DIR/scrapers.json.
    const dir = mkdtempSync(join(tmpdir(), 'factory-feed-test-'));
    process.env.FACTORY_WORK_DIR = dir;
    writeFileSync(
        join(dir, 'scrapers.json'),
        JSON.stringify([
            { name: 'auction-house', url: 'https://auction-house-scraper.ondigitalocean.app', dir: 'scrapers/auction-house', targetUrl: 'https://auction.example/', createdAt: '2026-11-13T19:00:00Z' },
        ]),
    );
    process.env.SCRAPER_ADMIN_SECRET = 'scraper-admin-test';
});
afterEach(() => mock.restoreAll());

test('pause finds the scraper in the registry and posts the reason and the issue', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('ok'));
    const result = await pauseScraper('auction-house', 'FEED-1 is being fixed', 'FEED-1');
    assert.deepEqual(result, { ok: true, url: 'https://auction-house-scraper.ondigitalocean.app' });
    const [url, init] = fetchMock.mock.calls[0]!.arguments as [URL, RequestInit];
    assert.equal(String(url), 'https://auction-house-scraper.ondigitalocean.app/pause');
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>)['x-admin-secret'], 'scraper-admin-test');
    assert.deepEqual(JSON.parse(String(init.body)), { reason: 'FEED-1 is being fixed', issue: 'FEED-1' });
});

test('resume posts to {url}/resume', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('ok'));
    assert.equal((await resumeScraper('auction-house')).ok, true);
    assert.equal(String(fetchMock.mock.calls[0]!.arguments[0]), 'https://auction-house-scraper.ondigitalocean.app/resume');
});

test('an unregistered scraper or a failing call comes back as { ok: false }, never a throw', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('no', { status: 401 }));
    assert.deepEqual(await pauseScraper('nope', 'r', 'FEED-1'), { ok: false, error: 'scraper "nope" is not in the registry' });
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal((await pauseScraper('auction-house', 'r', 'FEED-1')).error, 'the scraper answered HTTP 401');
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('fetch failed');
    });
    assert.equal((await pauseScraper('auction-house', 'r', 'FEED-1')).ok, false);
});

test('status reads /status; failures are reported, not thrown', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
        Response.json({ scraper: 'auction-house', paused: true, lastPoll: { at: '2026-11-13T21:00:00Z', ok: true, items: 2 } }),
    );
    const [status] = await scraperStatuses(0);
    assert.deepEqual(status, {
        name: 'auction-house',
        url: 'https://auction-house-scraper.ondigitalocean.app',
        targetUrl: 'https://auction.example/',
        up: true,
        items: 2,
        paused: true,
    });
    assert.match(String(fetchMock.mock.calls[0]?.arguments[0]), /\/status$/);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('fetch failed');
    });
    const [down] = await scraperStatuses(0);
    assert.equal(down!.up, false);
    assert.equal(down!.error, 'fetch failed');
});

test('fake mode never calls a scraper and stands in for unregistered ones', async () => {
    process.env.FAKE_EXTERNALS = '1';
    mock.method(console, 'log', () => {});
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('ok'));
    assert.equal((await pauseScraper('unknown-scraper', 'r', 'FEED-1')).ok, true);
    assert.equal((await resumeScraper('auction-house')).ok, true);
    assert.equal((await scraperStatuses(0))[0]!.up, true);
    assert.equal(fetchMock.mock.callCount(), 0);
});
