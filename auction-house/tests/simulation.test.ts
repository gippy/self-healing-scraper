import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CATEGORIES } from '../src/catalog.ts';
import { createSeedState, getBidIncrement, runTick, TARGET_OPEN_LOTS, type Random } from '../src/simulation.ts';

const NOW = new Date('2026-11-13T20:00:00Z');

// The same "random" sequence in every run.
function createRandom(): Random {
  let seed = 7;
  return () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
}

describe('auction simulation', () => {
  it('seeds a full floor spread over every category', () => {
    const { state } = createSeedState(NOW, createRandom());

    assert.equal(state.open.size, TARGET_OPEN_LOTS);
    const categories = new Set([...state.open.values()].map((lot) => lot.category));
    assert.equal(categories.size, CATEGORIES.length);
  });

  it('sells lots past their end time at the current bid and refills the floor', () => {
    const random = createRandom();
    const { state } = createSeedState(NOW, random);
    const ending = [...state.open.values()].sort((a, b) => a.endsAt.localeCompare(b.endsAt))[0]!;

    const { changes } = runTick(state, new Date(ending.endsAt), random);

    const sold = changes.find((change) => change.type === 'sold' && change.lotId === ending.id);
    assert.ok(sold);
    assert.equal(sold.lot.soldPrice, ending.currentBid);
    assert.equal(state.sold[0]?.id, ending.id);
    assert.equal(state.open.has(ending.id), false);
    assert.ok(changes.some((change) => change.type === 'new'));
    assert.equal(state.open.size, TARGET_OPEN_LOTS);
  });

  it('raises a bid by whole increments and records it', () => {
    const random = createRandom();
    const { state } = createSeedState(NOW, random);
    const before = new Map([...state.open.values()].map((lot) => [lot.id, { bid: lot.currentBid, count: lot.bidCount }]));

    const { changes, bids } = runTick(state, NOW, random);

    assert.ok(bids.length >= 1);
    for (const change of changes.filter((candidate) => candidate.type === 'lot')) {
      const previous = before.get(change.lot.id)!;
      const raise = change.lot.currentBid - previous.bid;
      assert.ok(change.lot.bidCount > previous.count);
      assert.ok(raise >= getBidIncrement(previous.bid));
    }
  });
});
