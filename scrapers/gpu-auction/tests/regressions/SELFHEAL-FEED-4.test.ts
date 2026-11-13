import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from '../../src/parsers/index.ts';
import { loadFixture } from '../helpers/fixtures.ts';

const URL = 'https://auction-house-a96xc.ondigitalocean.app/';

// SELFHEAL-FEED-4: production fetched the auction floor page in its "v2" layout,
// where lots are <article class="tile"> cards (price in data-bid/data-currency,
// ends in data-ends) instead of <li class="lot">. The parser found no `li.lot`
// and threw ParseError: No auction lots found.
describe('SELFHEAL-FEED-4: v2 tile layout', () => {
  const items = parse(loadFixture('SELFHEAL-FEED-4.html'), URL);

  it('reads every tile on the page', () => {
    assert.equal(items.length, 60);
  });

  it('reads the first tile fully', () => {
    assert.deepEqual(items[0], {
      id: 'LOT-0243',
      title: 'Pixel Pusher Ultra 16GB, White Edition',
      category: 'flagship-gaming',
      price: { amount: 1360.0, currency: 'USD' },
      bids: 10,
      status: 'open',
      endsAt: '2026-11-13T22:15:57Z',
    });
  });

  it('reads the last tile fully', () => {
    assert.deepEqual(items[59], {
      id: 'LOT-0305',
      title: 'Shoebox Build Special 8GB',
      category: 'low-profile',
      price: { amount: 230.0, currency: 'USD' },
      bids: 0,
      status: 'open',
      endsAt: '2026-11-13T22:28:53Z',
    });
  });

  it('takes the price from the listing, not the sold ticker', () => {
    const byId = new Map(items.map((item) => [item.id, item]));
    // The ticker at the top shows "Thermal Pad Transplant 8GB · $425.00"; the lot's
    // own data-bid is 180.00. Same for "ISA Graphics Adapter, 256KB · $170.00" vs 85.00.
    assert.deepEqual(byId.get('LOT-0304')?.price, { amount: 180.0, currency: 'USD' });
    assert.deepEqual(byId.get('LOT-0299')?.price, { amount: 85.0, currency: 'USD' });
  });

  it('reads categories and bid counts across the floor', () => {
    const byId = new Map(items.map((item) => [item.id, item]));
    assert.equal(byId.get('LOT-0290')?.category, 'datacenter');
    assert.equal(byId.get('LOT-0290')?.price?.amount, 22500);
    assert.equal(byId.get('LOT-0290')?.bids, 1);
    assert.equal(byId.get('LOT-0221')?.category, 'low-profile');
    assert.equal(byId.get('LOT-0221')?.bids, 20);
    assert.equal(byId.get('LOT-0303')?.endsAt, '2026-11-13T22:23:25Z');
  });
});
