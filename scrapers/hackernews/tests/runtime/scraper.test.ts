import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UpstreamError, type PageFetcher } from '../../src/brightdata.ts';
import { ParseError } from '../../src/parsers/errors.ts';
import { createScraper, type Parse } from '../../src/scraper.ts';
import { ITEMS, TARGET_URL, createMemorySink, createRecordingReporter } from './stubs.ts';

const PAGE = '<html><body>lots</body></html>';

function createTestScraper(options: { fetchPage?: PageFetcher; parse?: Parse } = {}) {
  const { calls, reporter } = createRecordingReporter();
  const { batches, sink } = createMemorySink();
  const parses: Array<[string, string]> = [];
  const scraper = createScraper({
    name: 'auction-house',
    targetUrl: TARGET_URL,
    fetchPage: options.fetchPage ?? (async () => ({ body: PAGE })),
    parse:
      options.parse ??
      ((raw, url) => {
        parses.push([raw, url]);
        return ITEMS;
      }),
    sink,
    reporter,
  });
  return { scraper, calls, batches, sink, parses };
}

describe('scraper poll', () => {
  it('fetches the target, parses it with its URL and writes one batch', async () => {
    const { scraper, calls, batches, parses } = createTestScraper();

    assert.equal(await scraper.pollIfRunning(), true);

    assert.deepEqual(parses, [[PAGE, TARGET_URL]]);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]?.items, ITEMS);
    assert.deepEqual(scraper.getItems(), ITEMS);
    assert.equal(calls[0]?.[0], 'polled');
    const status = scraper.getStatus();
    assert.equal(status.lastPoll?.ok, true);
    assert.equal(status.lastPoll?.items, 2);
    assert.equal(status.scrapedAt, batches[0]?.scrapedAt);
  });

  it('reports a ParseError with the exact page and keeps the last good items', async () => {
    let isBroken = false;
    const { scraper, calls, batches } = createTestScraper({
      parse: () => {
        if (isBroken) throw new ParseError('No lots found');
        return ITEMS;
      },
    });
    await scraper.pollIfRunning();
    isBroken = true;
    await scraper.pollIfRunning();

    const parseError = calls.find((call) => call[0] === 'parseError');
    assert.ok(parseError);
    assert.equal((parseError[1] as Error).message, 'No lots found');
    assert.equal(parseError[2], PAGE);
    assert.equal(parseError[3], TARGET_URL);
    assert.equal(batches.length, 1);
    assert.deepEqual(scraper.getItems(), ITEMS);
    assert.equal(scraper.getStatus().lastPoll?.ok, false);
    assert.equal(scraper.getStatus().lastError?.message, 'ParseError: No lots found');
  });

  it('treats an empty result or an item without a title as a ParseError', async () => {
    for (const result of [[], [{ id: 'LOT-1', title: '' }]]) {
      const { scraper, calls, batches } = createTestScraper({ parse: () => result as never });
      await scraper.pollIfRunning();

      const error = calls.find((call) => call[0] === 'parseError')?.[1];
      assert.ok(error instanceof ParseError, `no ParseError for ${JSON.stringify(result)}`);
      assert.equal(batches.length, 0);
    }
  });

  it('reports a recovered fetch as a warning and a failed fetch as an error', async () => {
    const firstFailure = new UpstreamError('Fetching the target page answered 503', { isRetryable: true, status: 503 });
    const recovered = createTestScraper({ fetchPage: async () => ({ body: PAGE, recoveredFrom: firstFailure }) });
    await recovered.scraper.pollIfRunning();
    assert.deepEqual(
      recovered.calls.map((call) => call[0]),
      ['upstreamRecovered', 'polled'],
    );

    const failed = createTestScraper({
      fetchPage: async () => {
        throw new UpstreamError('Fetching the target page answered 502', { isRetryable: true, status: 502 });
      },
    });
    await failed.scraper.pollIfRunning();
    assert.deepEqual(
      failed.calls.map((call) => call[0]),
      ['upstreamFailed'],
    );
    assert.equal(failed.scraper.getStatus().lastPoll?.ok, false);
  });

  it('reports a Snowflake failure without failing the poll', async () => {
    const { scraper, calls, sink } = createTestScraper();
    sink.failWith = new Error('warehouse suspended');

    await scraper.pollIfRunning();

    assert.equal(calls.at(-1)?.[0], 'storageError');
    assert.equal(scraper.getStatus().lastPoll?.ok, true);
    assert.equal(scraper.getStatus().lastError?.message, 'Snowflake: Error: warehouse suspended');
    assert.deepEqual(scraper.getItems(), ITEMS);
  });
});

describe('pause and resume', () => {
  it('does not poll while paused and polls right away on resume', async () => {
    let fetches = 0;
    const { scraper, calls } = createTestScraper({
      fetchPage: async () => {
        fetches += 1;
        return { body: PAGE };
      },
    });

    scraper.pause('parser is being fixed', 'SCRAPERS-12');
    assert.equal(await scraper.pollIfRunning(), false);
    assert.equal(fetches, 0);
    assert.deepEqual(
      {
        paused: scraper.getStatus().paused,
        reason: scraper.getStatus().reason,
        issue: scraper.getStatus().issue,
      },
      { paused: true, reason: 'parser is being fixed', issue: 'SCRAPERS-12' },
    );

    scraper.resume();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 1);
    assert.equal(scraper.getStatus().paused, false);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['paused', 'resumed', 'polled'],
    );
  });
});
