import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseError } from '../../src/parsers/errors.ts';
import { parse } from '../../src/parsers/index.ts';
import { loadFixture } from '../helpers/fixtures.ts';

const URL = 'http://localhost:8081/';

function renderV1Lot(overrides: { bid?: string; bids?: string; ends?: string } = {}): string {
  return `<section class="category" data-category="gadgets"><ul class="lot-list">
  <li class="lot" data-lot="LOT-0001" data-category="gadgets">
    <h3 class="lot-title">Vintage Rubber Duck Debugger</h3>
    <span class="lot-bid">${overrides.bid ?? '$24.00'}</span>
    <span class="lot-bids">${overrides.bids ?? '7 bids'}</span>
    <time class="lot-ends" datetime="${overrides.ends ?? '2026-11-13T22:00:00Z'}">Ends in 2h 13m</time>
    <p class="lot-description">A patient yellow listener.</p>
  </li>
</ul></section>`;
}

describe('auction v1 parser', () => {
  it('reads every lot of the v1 page with categories', () => {
    const items = parse(loadFixture('auction-v1-categories.html'), URL);

    assert.equal(items.length, 60);
    assert.deepEqual(items[0], {
      id: 'LOT-0038',
      title: 'Vintage Rubber Duck Debugger',
      category: 'gadgets',
      price: { amount: 27, currency: 'USD' },
      bids: 2,
      status: 'open',
      endsAt: '2026-11-13T20:12:26.000Z',
    });
    assert.equal(items[1]?.title, 'Label Maker, Pre-Loaded with "Misc"');
    assert.ok(items.every((item) => item.category));
  });

  it('reads the older v1 page without categories', () => {
    const items = parse(loadFixture('auction-v1.html'), URL);

    assert.equal(items.length, 12);
    assert.deepEqual(items[0], {
      id: 'LOT-001',
      title: 'Vintage Rubber Duck Debugger',
      price: { amount: 33.5, currency: 'USD' },
      bids: 9,
      status: 'open',
      endsAt: '2026-11-13T21:33:00.000Z',
    });
  });

  it('reads a single bid', () => {
    assert.equal(parse(renderV1Lot({ bids: '1 bid' }), URL)[0]?.bids, 1);
  });

  it('throws a ParseError naming the page when no lot matches', () => {
    const html = '<html><head><title>Sign in</title></head><body><form class="signin"></form></body></html>';
    assert.throws(() => parse(html, URL), { name: 'ParseError', message: /No lots found.*"Sign in"/ });
  });

  it('throws a ParseError on a bid it cannot read instead of skipping the lot', () => {
    assert.throws(() => parse(renderV1Lot({ bid: 'Reserve not met' }), URL), (error) => {
      assert.ok(error instanceof ParseError);
      assert.match(error.message, /Unreadable bid "Reserve not met" for LOT-0001/);
      return true;
    });
  });

  it('throws a ParseError on an unreadable bid count or end time', () => {
    assert.throws(() => parse(renderV1Lot({ bids: 'no bids yet' }), URL), { name: 'ParseError', message: /Unreadable bid count/ });
    assert.throws(() => parse(renderV1Lot({ ends: 'soon' }), URL), { name: 'ParseError', message: /Unreadable end time "soon"/ });
  });
});
