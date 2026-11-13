import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from '../src/parsers/index.ts';
import { ParseError } from '../src/parsers/errors.ts';
import { loadFixture } from './helpers/fixtures.ts';

const URL = 'https://auction-house-a96xc.ondigitalocean.app/';

describe('gpu auction parser', () => {
  it('reads every lot on page 1', () => {
    const items = parse(loadFixture('page-1.html'), URL);

    assert.equal(items.length, 60);
    assert.deepEqual(items[0], {
      id: 'LOT-0014',
      title: 'RGB Rainbow Reaper 12GB',
      category: 'Flagship Gaming',
      price: { amount: 600, currency: 'USD' },
      bids: 5,
      status: 'open',
      endsAt: '2026-11-13T21:36:32Z',
    });
    assert.deepEqual(items.at(-1), {
      id: 'LOT-0030',
      title: 'Fanless Phantom 4GB',
      category: 'Mini & Low-Profile',
      price: { amount: 155, currency: 'USD' },
      bids: 4,
      status: 'open',
      endsAt: '2026-11-13T21:47:14Z',
    });
    assert.deepEqual(items.find((item) => item.id === 'LOT-0062')?.price, {
      amount: 24000,
      currency: 'USD',
    });
    assert.equal(items.find((item) => item.id === 'LOT-0062')?.bids, 0);
  });

  it('reads every lot on page 2 and keeps the later bid values', () => {
    const items = parse(loadFixture('page-2.html'), URL);

    assert.equal(items.length, 60);
    assert.deepEqual(items[0], {
      id: 'LOT-0007',
      title: 'Thermal Throttle TX-9000 24GB',
      category: 'Flagship Gaming',
      price: { amount: 1600, currency: 'USD' },
      bids: 2,
      status: 'open',
      endsAt: '2026-11-13T21:37:34Z',
    });
    assert.deepEqual(items.at(-1), {
      id: 'LOT-0030',
      title: 'Fanless Phantom 4GB',
      category: 'Mini & Low-Profile',
      price: { amount: 155, currency: 'USD' },
      bids: 4,
      status: 'open',
      endsAt: '2026-11-13T21:47:14Z',
    });
    assert.deepEqual(items.find((item) => item.id === 'LOT-0015'), {
      id: 'LOT-0015',
      title: 'Seed-Round Special 80GB',
      category: 'Datacenter Accelerators',
      price: { amount: 16300, currency: 'USD' },
      bids: 6,
      status: 'closing',
      endsAt: '2026-11-13T21:36:34Z',
    });
    assert.deepEqual(items.find((item) => item.id === 'LOT-0048')?.price, {
      amount: 850,
      currency: 'USD',
    });
    assert.equal(items.find((item) => item.id === 'LOT-0048')?.bids, 7);
  });

  it('throws ParseError when the page has no listings', () => {
    assert.throws(
      () => parse('<html><body><form>Sign in</form></body></html>', URL),
      (error) => {
        assert.ok(error instanceof ParseError);
        assert.match(error.message, /No auction listings found/);
        return true;
      },
    );
  });

  it('throws ParseError naming an unreadable price and its lot', () => {
    const raw = `
      <section class="category">
        <h2 class="category-name">Flagship Gaming</h2>
        <li class="lot" data-lot="LOT-0042">
          <h3 class="lot-title">Broken Price</h3>
          <span class="lot-bid">price on request</span>
          <span class="lot-bids">3 bids</span>
          <time class="lot-ends" datetime="2026-11-13T21:38:25Z">Ends in 2m</time>
        </li>
      </section>`;

    assert.throws(() => parse(raw, URL), /Unreadable price "price on request" on LOT-0042/);
  });

  it('reads the tile layout used by the live updater', () => {
    const raw = `
      <article class="tile" data-lot="LOT-0100" data-category="retro"
        data-bid="42.50" data-currency="USD" data-ends="2026-11-13T22:00:00Z">
        <h3 class="tile__title">Tile GPU</h3>
        <div class="tile__meta">
          <span class="tile__category">Retro &amp; Collectible</span>
          <span class="tile__bids">1 bid</span>
          <span class="tile__ends">Closing</span>
        </div>
      </article>`;

    assert.deepEqual(parse(raw, URL), [
      {
        id: 'LOT-0100',
        title: 'Tile GPU',
        category: 'Retro & Collectible',
        price: { amount: 42.5, currency: 'USD' },
        bids: 1,
        status: 'closing',
        endsAt: '2026-11-13T22:00:00Z',
      },
    ]);
  });
});
