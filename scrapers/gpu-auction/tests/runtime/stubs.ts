import type { Reporter } from '../../src/reporting.ts';
import type { ItemSink } from '../../src/snowflake.ts';
import type { Item } from '../../src/parsers/item.ts';

export const TARGET_URL = 'https://auction.example/';

export const ITEMS: Item[] = [
  {
    id: 'LOT-0001',
    title: 'Vintage Rubber Duck Debugger',
    category: 'office',
    price: { amount: 24, currency: 'USD' },
    bids: 7,
    status: 'open',
    endsAt: '2026-11-13T22:00:00.000Z',
  },
  { id: 'LOT-0002', title: 'Signed Off-by-One Socks' },
];

/** Records every reporter call as `[method, ...args]`. */
export function createRecordingReporter() {
  const calls: Array<[keyof Reporter, ...unknown[]]> = [];
  const record =
    (name: keyof Reporter) =>
    (...args: unknown[]) =>
      void calls.push([name, ...args]);
  const reporter: Reporter = {
    parseError: record('parseError'),
    upstreamRecovered: record('upstreamRecovered'),
    upstreamFailed: record('upstreamFailed'),
    storageError: record('storageError'),
    polled: record('polled'),
    paused: record('paused'),
    resumed: record('resumed'),
  };
  return { calls, reporter };
}

/** Keeps every batch written; throws `failWith` when set. */
export function createMemorySink() {
  const batches: Array<{ items: Item[]; scrapedAt: string }> = [];
  const sink: ItemSink & { failWith?: Error } = {
    name: 'memory',
    async write(items, scrapedAt) {
      if (sink.failWith) throw sink.failWith;
      batches.push({ items, scrapedAt });
    },
    async close() {},
  };
  return { batches, sink };
}
