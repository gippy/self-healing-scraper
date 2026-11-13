import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from '../src/parsers/index.ts';
import { ParseError } from '../src/parsers/errors.ts';
import { loadFixture } from './helpers/fixtures.ts';

const URL = 'https://auction-house-a96xc.ondigitalocean.app/';

describe('page-1', () => {
  const items = parse(loadFixture('page-1.html'), URL);

  it('reads every lot on the page', () => {
    assert.equal(items.length, 60);
  });

  it('reads the first lot fully', () => {
    const first = items[0];
    assert.deepEqual(first, {
      id: 'LOT-0196',
      title: 'Quiet Mode Qx 16GB',
      category: 'flagship-gaming',
      price: { amount: 840.0, currency: 'USD' },
      bids: 9,
      status: 'open',
      endsAt: '2026-11-13T22:07:15Z',
    });
  });

  it('reads the last lot fully', () => {
    const last = items[59];
    assert.deepEqual(last, {
      id: 'LOT-0222',
      title: 'Tiny Tensor TT-2 16GB',
      category: 'low-profile',
      price: { amount: 700.0, currency: 'USD' },
      bids: 1,
      status: 'open',
      endsAt: '2026-11-13T22:17:19Z',
    });
  });

  it('keeps categories from the data attribute across sections', () => {
    const byId = new Map(items.map((item) => [item.id, item]));
    assert.equal(byId.get('LOT-0195')?.category, 'datacenter');
    assert.equal(byId.get('LOT-0204')?.category, 'retro');
    assert.equal(byId.get('LOT-0172')?.category, 'mining-survivors');
    assert.equal(byId.get('LOT-0195')?.price?.amount, 18300);
    assert.equal(byId.get('LOT-0207')?.price?.amount, 71);
  });
});

describe('page-2', () => {
  const items = parse(loadFixture('page-2.html'), URL);

  it('reads every lot on the page', () => {
    assert.equal(items.length, 60);
  });

  it('reads the first lot fully', () => {
    assert.deepEqual(items[0], {
      id: 'LOT-0196',
      title: 'Quiet Mode Qx 16GB',
      category: 'flagship-gaming',
      price: { amount: 840.0, currency: 'USD' },
      bids: 9,
      status: 'open',
      endsAt: '2026-11-13T22:07:15Z',
    });
  });

  it('reads the last lot fully', () => {
    const last = items[59];
    assert.equal(last?.id, 'LOT-0222');
    assert.equal(last?.title, 'Tiny Tensor TT-2 16GB');
  });

  it('reads lots that appeared since page-1', () => {
    const sparrow = items.find((item) => item.id === 'LOT-0247');
    assert.deepEqual(sparrow, {
      id: 'LOT-0247',
      title: 'Sparse Model Sparrow 24GB',
      category: 'datacenter',
      price: { amount: 3100.0, currency: 'USD' },
      bids: 0,
      status: 'open',
      endsAt: '2026-11-13T22:13:30Z',
    });
  });
});

describe('broken pages', () => {
  it('throws ParseError when the page has no lots', () => {
    assert.throws(
      () => parse('<html><body><form>Sign in</form></body></html>', URL),
      (error) => error instanceof ParseError && /No auction lots/.test(error.message),
    );
  });

  it('throws ParseError naming the lot when a field is unreadable', () => {
    const html = `<html><body><ul class="lot-list">
      <li class="lot" data-lot="LOT-0001" data-category="retro">
        <h3 class="lot-title">Half the fields missing</h3>
        <span class="lot-bid">negotiable</span>
        <span class="lot-bids">3 bids</span>
        <time class="lot-ends" datetime="2026-11-13T22:00:00Z">soon</time>
      </li>
    </ul></body></html>`;
    assert.throws(
      () => parse(html, URL),
      (error) => error instanceof ParseError && /LOT-0001/.test(error.message) && /price/.test(error.message),
    );
  });
});
