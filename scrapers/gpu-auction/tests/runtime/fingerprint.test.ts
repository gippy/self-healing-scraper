import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UpstreamError } from '../../src/brightdata.ts';
import { ParseError } from '../../src/parsers/errors.ts';
import { getParseFingerprint, getUpstreamFingerprint, normalizeMessage } from '../../src/reporting.ts';

describe('normalizeMessage', () => {
  it('replaces ids, quoted strings and numbers', () => {
    assert.equal(normalizeMessage('Unreadable bid "€33,50" for LOT-0042'), 'Unreadable bid "…" for <id>');
    assert.equal(normalizeMessage('Unreadable bid count "no bids yet" for SKU-7'), 'Unreadable bid count "…" for <id>');
    assert.equal(normalizeMessage('Expected 60 lots, found 12 (1234.5 USD, 0,75 EUR)'), 'Expected <n> lots, found <n> (<n> USD, <n> EUR)');
    assert.equal(normalizeMessage('Lot #7 has no data-lot'), 'Lot #<n> has no data-lot');
  });

  it('keeps the parts that tell failures apart', () => {
    const redesign = 'No lots found: nothing matches "ul.lot-list > li.lot" (page title "Auction floor | Gavel & Glitch Auctions")';
    assert.equal(normalizeMessage(redesign), 'No lots found: nothing matches "…" (page title "…")');
    assert.notEqual(normalizeMessage('Unreadable bid "x" for LOT-1'), normalizeMessage('Unreadable end time "x" for LOT-1'));
  });

  it('leaves lowercase ids and plain words alone', () => {
    assert.equal(normalizeMessage('not implemented'), 'not implemented');
    assert.equal(normalizeMessage('Item is invalid: price.amount Expected number'), 'Item is invalid: price.amount Expected number');
  });
});

describe('fingerprints', () => {
  it('puts the scraper, the error name and the normalized message in a parser fingerprint', () => {
    assert.deepEqual(getParseFingerprint('auction-house', new ParseError('Unreadable bid "Reserve not met" for LOT-0000')), [
      'auction-house',
      'ParseError',
      'Unreadable bid "…" for <id>',
    ]);
    assert.deepEqual(
      getParseFingerprint('auction-house', new ParseError('Unreadable bid "€12,00" for LOT-0042')),
      getParseFingerprint('auction-house', new ParseError('Unreadable bid "CZK 1 200" for LOT-0007')),
    );
    assert.deepEqual(getParseFingerprint('auction-house', new TypeError("Cannot read properties of undefined (reading 'trim')")), [
      'auction-house',
      'TypeError',
      "Cannot read properties of undefined (reading 'trim')",
    ]);
  });

  it('groups fetch failures by status', () => {
    const answered = new UpstreamError('Fetching the target page answered 503 (Bright Data: x)', { isRetryable: true, status: 503 });
    assert.deepEqual(getUpstreamFingerprint('auction-house', answered), ['auction-house', 'UpstreamError', '503']);
    const network = new UpstreamError('Fetching the target page failed: ECONNRESET', { isRetryable: true, status: 'network' });
    assert.deepEqual(getUpstreamFingerprint('auction-house', network), ['auction-house', 'UpstreamError', 'network']);
  });
});
