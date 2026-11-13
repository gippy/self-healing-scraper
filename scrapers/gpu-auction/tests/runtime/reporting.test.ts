import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as Sentry from '@sentry/node';
import { UpstreamError } from '../../src/brightdata.ts';
import { ParseError } from '../../src/parsers/errors.ts';
import { createSentryReporter } from '../../src/reporting.ts';

type EnvelopeItem = [{ type: string; filename?: string; content_type?: string }, unknown];

const envelopes: EnvelopeItem[][] = [];

// Sends every captured envelope to the list above instead of the network.
before(() => {
  Sentry.init({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    defaultIntegrations: false,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope[1] as unknown as EnvelopeItem[]);
        return {};
      },
      flush: async () => true,
    }),
  });
});

async function captureEnvelope(report: () => void): Promise<EnvelopeItem[]> {
  envelopes.length = 0;
  report();
  await Sentry.flush(1000);
  const envelope = envelopes.find((items) => items.some(([header]) => header.type === 'event'));
  assert.ok(envelope, 'no event was sent');
  return envelope;
}

function getEvent(envelope: EnvelopeItem[]): Sentry.Event {
  return envelope.find(([header]) => header.type === 'event')?.[1] as Sentry.Event;
}

describe('Sentry reporter', () => {
  it('sends a parser failure tagged with the scraper and the exact page attached as raw.html', async () => {
    const page = '<html><head><title>Catalog</title></head><body>Ünïcode ✓</body></html>';
    const message = 'Unreadable bid "Reserve not met" for LOT-0000';
    const envelope = await captureEnvelope(() =>
      createSentryReporter('auction-house').parseError(new ParseError(message), page, 'https://auction.example/'),
    );

    const event = getEvent(envelope);
    assert.equal(event.exception?.values?.[0]?.type, 'ParseError');
    assert.equal(event.exception?.values?.[0]?.value, message);
    assert.deepEqual(event.tags, { scraper: 'auction-house', source: 'auction-house', parser: 'index' });
    assert.deepEqual(event.fingerprint, ['auction-house', 'ParseError', 'Unreadable bid "…" for <id>']);
    const attachment = envelope.find(([header]) => header.type === 'attachment');
    assert.equal(attachment?.[0].filename, 'raw.html');
    assert.equal(attachment?.[0].content_type, 'text/html');
    assert.deepEqual(Buffer.from(attachment?.[1] as Uint8Array), Buffer.from(page, 'utf8'));
  });

  it('sends a retried fetch as an UpstreamError warning without an attachment', async () => {
    const error = new UpstreamError('Fetching the target page answered 503', { isRetryable: true, status: 503 });
    const envelope = await captureEnvelope(() => createSentryReporter('auction-house').upstreamRecovered(error));

    const event = getEvent(envelope);
    assert.equal(event.level, 'warning');
    assert.equal(event.exception?.values?.[0]?.type, 'UpstreamError');
    assert.deepEqual(event.tags, { scraper: 'auction-house', source: 'auction-house' });
    assert.deepEqual(event.fingerprint, ['auction-house', 'UpstreamError', '503']);
    assert.equal(envelope.some(([header]) => header.type === 'attachment'), false);
  });

  it('groups a fetch that failed after the retry by status too', async () => {
    const error = new UpstreamError('Fetching the target page timed out: TimeoutError', { isRetryable: true, status: 'timeout' });
    const envelope = await captureEnvelope(() => createSentryReporter('auction-house').upstreamFailed(error));

    const event = getEvent(envelope);
    assert.equal(event.level, 'error');
    assert.deepEqual(event.fingerprint, ['auction-house', 'UpstreamError', 'timeout']);
  });

  it('tags a Snowflake failure with component snowflake', async () => {
    const envelope = await captureEnvelope(() => createSentryReporter('auction-house').storageError(new Error('warehouse suspended')));

    assert.deepEqual(getEvent(envelope).tags, { scraper: 'auction-house', source: 'auction-house', component: 'snowflake' });
  });
});
