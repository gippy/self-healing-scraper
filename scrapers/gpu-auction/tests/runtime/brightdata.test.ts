import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPageFetcher, UpstreamError } from '../../src/brightdata.ts';

const TARGET_URL = 'https://auction.example/';

// Answers each request with the next response in the list and records what was requested.
function createFetchStub(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses[calls.length - 1];
    assert.ok(next, `unexpected request #${calls.length}`);
    return next();
  };
  return { calls, fetchStub: fetchStub as typeof fetch };
}

describe('page fetcher', () => {
  it('sends the target URL and zone to the Web Unlocker request API', async () => {
    const { calls, fetchStub } = createFetchStub([() => new Response('<html></html>')]);
    const fetchPage = createPageFetcher({ isFake: false, apiKey: 'test-key', zone: 'unlocker_zone' }, fetchStub);

    assert.deepEqual(await fetchPage(TARGET_URL), { body: '<html></html>' });
    assert.equal(calls[0]?.url, 'https://api.brightdata.com/request');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { zone: 'unlocker_zone', url: TARGET_URL, format: 'raw' });
    assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Bearer test-key');
  });

  it('fetches directly when faked, retries once on a 5xx and returns the first failure with the page', async () => {
    const { calls, fetchStub } = createFetchStub([
      () => new Response('busy', { status: 503 }),
      () => new Response('<html>ok</html>'),
    ]);
    const fetchPage = createPageFetcher({ isFake: true }, fetchStub);

    const result = await fetchPage(TARGET_URL);
    assert.equal(result.body, '<html>ok</html>');
    assert.ok(result.recoveredFrom instanceof UpstreamError);
    assert.match(result.recoveredFrom.message, /answered 503/);
    assert.equal(calls[0]?.url, TARGET_URL);
  });

  it('reads the target status Bright Data reports in x-brd-status-code', async () => {
    const { fetchStub } = createFetchStub([
      () => new Response('busy', { headers: { 'x-brd-status-code': '503' } }),
      () => new Response('busy', { headers: { 'x-brd-status-code': '503' } }),
    ]);
    const fetchPage = createPageFetcher({ isFake: false, apiKey: 'test-key', zone: 'unlocker_zone' }, fetchStub);

    await assert.rejects(fetchPage(TARGET_URL), { name: 'UpstreamError', message: /answered 503/ });
  });

  it('does not retry a 4xx', async () => {
    const { calls, fetchStub } = createFetchStub([() => new Response('denied', { status: 403 })]);
    const fetchPage = createPageFetcher({ isFake: true }, fetchStub);

    await assert.rejects(fetchPage(TARGET_URL), { name: 'UpstreamError', message: /answered 403/ });
    assert.equal(calls.length, 1);
  });
});
