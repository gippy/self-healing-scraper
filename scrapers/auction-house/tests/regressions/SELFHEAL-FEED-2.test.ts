import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from '../../src/parsers/index.ts';
import { loadFixture } from '../helpers/fixtures.ts';

const URL = 'https://auction-house-a96xc.ondigitalocean.app/';

test('SELFHEAL-FEED-2: reads listings from the tile-based auction page', () => {
  const items = parse(loadFixture('SELFHEAL-FEED-2.html'), URL);

  assert.equal(items.length, 60);
  assert.deepEqual(items[0], {
    id: 'LOT-0057',
    title: 'Combination Waterstone, 1000/6000',
    category: 'hand-tools',
    price: { amount: 55, currency: 'USD' },
    bids: 8,
    status: 'open',
    endsAt: '2026-11-13T20:48:44Z',
  });
});
