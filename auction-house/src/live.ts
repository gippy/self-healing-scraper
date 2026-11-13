import { runTick, TICK_MS, type AuctionState, type Change, type Lot, type Random } from './simulation.ts';
import type { Store } from './store.ts';

export type AuctionSnapshot = { open: Lot[]; sold: Lot[] };

export type Auction = Awaited<ReturnType<typeof startAuction>>;

/**
 * Loads the auction from the store, then advances it every tick.
 * Each change goes to the subscribers first and to the store right after; a failed save is logged, not retried.
 */
export async function startAuction(options: { store: Store; random?: Random; now?: () => Date }) {
  const random = options.random ?? Math.random;
  const getNow = options.now ?? (() => new Date());
  const state: AuctionState = await options.store.load(getNow(), random);
  const listeners = new Set<(change: Change) => void>();
  let timer: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    const { changes, bids } = runTick(state, getNow(), random);
    for (const change of changes) {
      for (const listener of listeners) {
        listener(change);
      }
    }
    await options.store.save(changes, bids).catch((error) => console.error(`saving the auction failed: ${String(error)}`));
  }

  return {
    tick,

    startTicking(): void {
      const run = async () => {
        await tick();
        timer = setTimeout(run, TICK_MS);
      };
      timer = setTimeout(run, TICK_MS);
    },

    stopTicking(): void {
      clearTimeout(timer);
    },

    /** Open lots ending soonest first, and recently sold lots newest first. */
    getSnapshot(): AuctionSnapshot {
      return {
        open: [...state.open.values()].sort((a, b) => a.endsAt.localeCompare(b.endsAt)),
        sold: [...state.sold],
      };
    },

    subscribe(listener: (change: Change) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
