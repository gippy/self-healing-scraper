import { CATALOG, CATEGORIES } from './catalog.ts';

export type Lot = {
  id: string;
  category: string;
  title: string;
  description: string;
  startingBid: number;
  currentBid: number;
  currency: string;
  bidCount: number;
  status: 'open' | 'sold';
  endsAt: string;
  createdAt: string;
  soldAt?: string;
  soldPrice?: number;
};

export type Bid = { time: string; lotId: string; amount: number };

/** What changed in one tick; broadcast to WebSocket clients as is. */
export type Change = { type: 'lot'; lot: Lot } | { type: 'sold'; lotId: string; lot: Lot } | { type: 'new'; lot: Lot };

export type AuctionState = {
  /** Open lots by id. */
  open: Map<string, Lot>;
  /** Recently sold lots, newest first. */
  sold: Lot[];
  nextLotNumber: number;
};

export type Random = () => number;

export const TICK_MS = 2000;
export const TARGET_OPEN_LOTS = 60;
const MAX_NEW_LOTS_PER_TICK = 6;
const RECENTLY_SOLD_SIZE = 12;
const MAX_BIDS_PER_TICK = 3;

export function formatLotId(lotNumber: number): string {
  return `LOT-${String(lotNumber).padStart(4, '0')}`;
}

/** The smallest raise for a bid at this amount, like a real auction house's increment table. */
export function getBidIncrement(amount: number): number {
  if (amount < 50) return 1;
  if (amount < 250) return 5;
  if (amount < 1000) return 10;
  return 25;
}

function pick<T>(items: T[], random: Random): T {
  return items[Math.floor(random() * items.length)] as T;
}

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

// New lots go to the category with the fewest open lots, so every category stays full.
function getEmptiestCategory(state: AuctionState, random: Random): string {
  const counts = new Map(CATEGORIES.map((category) => [category.slug, 0]));
  for (const lot of state.open.values()) {
    counts.set(lot.category, (counts.get(lot.category) ?? 0) + 1);
  }
  const fewest = Math.min(...counts.values());
  return pick(
    [...counts].filter(([, count]) => count === fewest).map(([slug]) => slug),
    random,
  );
}

/** Creates an open lot from the catalog, preferring an item that is not on sale yet. */
export function createLot(state: AuctionState, now: Date, random: Random, endsInMinutes: { min: number; max: number }): Lot {
  const category = getEmptiestCategory(state, random);
  const openTitles = new Set([...state.open.values()].map((lot) => lot.title));
  const items = CATALOG[category] ?? [];
  const fresh = items.filter((item) => !openTitles.has(item.title));
  const item = pick(fresh.length > 0 ? fresh : items, random);
  const id = formatLotId(state.nextLotNumber);
  state.nextLotNumber += 1;
  return {
    id,
    category,
    title: item.title,
    description: item.description,
    startingBid: item.startingBid,
    currentBid: item.startingBid,
    currency: 'USD',
    bidCount: 0,
    status: 'open',
    endsAt: addMinutes(now, endsInMinutes.min + random() * (endsInMinutes.max - endsInMinutes.min)),
    createdAt: now.toISOString(),
  };
}

function placeBid(lot: Lot, now: Date, random: Random): Bid {
  const raises = 1 + Math.floor(random() * 3);
  lot.currentBid = Math.round((lot.currentBid + raises * getBidIncrement(lot.currentBid)) * 100) / 100;
  lot.bidCount += 1;
  return { time: now.toISOString(), lotId: lot.id, amount: lot.currentBid };
}

/** A full auction floor with some bids already placed, for a fresh start. */
export function createSeedState(now: Date, random: Random, firstLotNumber = 1): { state: AuctionState; bids: Bid[] } {
  const state: AuctionState = { open: new Map(), sold: [], nextLotNumber: firstLotNumber };
  const bids: Bid[] = [];
  while (state.open.size < TARGET_OPEN_LOTS) {
    const lot = createLot(state, now, random, { min: 1, max: 15 });
    const seedBids = Math.floor(random() * 9);
    for (let i = 0; i < seedBids; i += 1) {
      bids.push(placeBid(lot, now, random));
    }
    state.open.set(lot.id, lot);
  }
  return { state, bids };
}

/**
 * Advances the auction by one tick and returns what changed:
 * - lots past their end time are sold at their current bid;
 * - one to three open lots get a bid;
 * - new lots appear until about 60 are open again.
 */
export function runTick(state: AuctionState, now: Date, random: Random): { changes: Change[]; bids: Bid[] } {
  const changes: Change[] = [];
  const bids: Bid[] = [];

  for (const lot of [...state.open.values()]) {
    if (new Date(lot.endsAt) <= now) {
      lot.status = 'sold';
      lot.soldAt = now.toISOString();
      lot.soldPrice = lot.currentBid;
      state.open.delete(lot.id);
      state.sold.unshift(lot);
      changes.push({ type: 'sold', lotId: lot.id, lot });
    }
  }
  state.sold.length = Math.min(state.sold.length, RECENTLY_SOLD_SIZE);

  const open = [...state.open.values()];
  const bidCount = Math.min(open.length, 1 + Math.floor(random() * MAX_BIDS_PER_TICK));
  for (let i = 0; i < bidCount; i += 1) {
    const lot = pick(open, random);
    bids.push(placeBid(lot, now, random));
    changes.push({ type: 'lot', lot });
  }

  for (let added = 0; state.open.size < TARGET_OPEN_LOTS && added < MAX_NEW_LOTS_PER_TICK; added += 1) {
    const lot = createLot(state, now, random, { min: 4, max: 15 });
    state.open.set(lot.id, lot);
    changes.push({ type: 'new', lot });
  }

  return { changes, bids };
}
