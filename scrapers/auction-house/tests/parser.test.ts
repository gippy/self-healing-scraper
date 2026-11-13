import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseError } from '../src/parsers/errors.ts';
import { parse } from '../src/parsers/index.ts';
import { loadFixture } from './helpers/fixtures.ts';

const URL = 'https://auction-house-a96xc.ondigitalocean.app/';

function readPage(name: string) {
  return parse(loadFixture(name), URL);
}

describe('auction-house parser', () => {
  it('reads all 60 listings and the concrete fields in the first snapshot', () => {
    const items = readPage('page-1.html');

    assert.equal(items.length, 60);
    assert.equal(new Set(items.map(({ id }) => id)).size, 60);
    assert.deepEqual(items[0], {
      id: 'LOT-0024',
      title: 'Vintage Rubber Duck Debugger',
      category: 'gadgets',
      price: { amount: 48, currency: 'USD' },
      bids: 12,
      status: 'open',
      endsAt: '2026-11-13T20:35:46Z',
    });
    assert.deepEqual(items.at(-1), {
      id: 'LOT-0092',
      title: 'Hammock Rated for One Long Weekend',
      category: 'outdoors',
      price: { amount: 73, currency: 'USD' },
      bids: 1,
      status: 'open',
      endsAt: '2026-11-13T20:43:27Z',
    });
    assert.deepEqual(items.find(({ id }) => id === 'LOT-0039'), {
      id: 'LOT-0039',
      title: 'Snow Globe with Tiny Data Center',
      category: 'collectibles',
      price: { amount: 51, currency: 'USD' },
      bids: 12,
      status: 'closing',
      endsAt: '2026-11-13T20:34:39Z',
    });
    assert.deepEqual(items.find(({ id }) => id === 'LOT-0067')?.price, { amount: 1499, currency: 'USD' });
  });

  it('reads all 60 listings and changed values in the second snapshot', () => {
    const items = readPage('page-2.html');

    assert.equal(items.length, 60);
    assert.equal(new Set(items.map(({ id }) => id)).size, 60);
    assert.deepEqual(items[0], {
      id: 'LOT-0024',
      title: 'Vintage Rubber Duck Debugger',
      category: 'gadgets',
      price: { amount: 48, currency: 'USD' },
      bids: 12,
      status: 'open',
      endsAt: '2026-11-13T20:35:46Z',
    });
    assert.deepEqual(items.at(-1), {
      id: 'LOT-0092',
      title: 'Hammock Rated for One Long Weekend',
      category: 'outdoors',
      price: { amount: 73, currency: 'USD' },
      bids: 1,
      status: 'open',
      endsAt: '2026-11-13T20:43:27Z',
    });
    assert.deepEqual(items.find(({ id }) => id === 'LOT-0042'), {
      id: 'LOT-0042',
      title: 'Cassette Mixtape: Songs to Debug To',
      category: 'music',
      price: { amount: 35, currency: 'USD' },
      bids: 13,
      status: 'open',
      endsAt: '2026-11-13T20:37:46Z',
    });
    assert.equal(items.find(({ id }) => id === 'LOT-0099')?.title, 'Snow Globe with Tiny Data Center');
  });

  it('throws ParseError when the page has no auction listings', () => {
    assert.throws(
      () => parse('<html><body><form>Sign in</form></body></html>', URL),
      (error: unknown) => error instanceof ParseError && /No auction listings/.test(error.message),
    );
  });

  it('fails the whole page when a listing has an unreadable required field', () => {
    const page = `<main><ul class="lot-list">
      <li class="lot" data-lot="LOT-0001" data-category="gadgets">
        <h3 class="lot-title">Broken lot</h3><span class="lot-bid">not a price</span>
        <span class="lot-bids">2 bids</span><time class="lot-ends" datetime="2026-11-13T20:35:46Z">Ends in 2s</time>
      </li>
    </ul></main>`;

    assert.throws(
      () => parse(page, URL),
      (error: unknown) => error instanceof ParseError && /price "not a price" on LOT-0001/.test(error.message),
    );
  });
});
