import pg from 'pg';
import { CATEGORIES } from './catalog.ts';
import { createSeedState, type AuctionState, type Bid, type Change, type Lot, type Random } from './simulation.ts';

/** Where the auction state lives between restarts. */
export type Store = {
  /** Returns the saved auction, seeding a fresh one when there is none. */
  load(now: Date, random: Random): Promise<AuctionState>;
  save(changes: Change[], bids: Bid[]): Promise<void>;
  close(): Promise<void>;
};

const RECENTLY_SOLD_SIZE = 12;

/** Keeps nothing: every start seeds a fresh auction. */
export function createMemoryStore(): Store {
  return {
    load: async (now, random) => createSeedState(now, random).state,
    save: async () => undefined,
    close: async () => undefined,
  };
}

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS categories (slug text PRIMARY KEY, name text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lots (
    id text PRIMARY KEY,
    category text NOT NULL REFERENCES categories (slug),
    title text NOT NULL,
    description text NOT NULL,
    starting_bid numeric NOT NULL,
    current_bid numeric NOT NULL,
    currency text NOT NULL DEFAULT 'USD',
    bid_count int NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sold')),
    ends_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sold_at timestamptz,
    sold_price numeric
  )`,
  `CREATE INDEX IF NOT EXISTS lots_status_sold_at_idx ON lots (status, sold_at DESC)`,
  `CREATE TABLE IF NOT EXISTS bids (time timestamptz NOT NULL, lot_id text NOT NULL, amount numeric NOT NULL)`,
];

export const CREATE_BIDS_HYPERTABLE = `SELECT create_hypertable('bids', by_range('time'), if_not_exists => TRUE)`;

const LOT_COLUMNS = 'id, category, title, description, starting_bid, current_bid, currency, bid_count, status, ends_at, created_at, sold_at, sold_price';

const UPSERT_LOT = `INSERT INTO lots (${LOT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  ON CONFLICT (id) DO UPDATE SET current_bid = EXCLUDED.current_bid, bid_count = EXCLUDED.bid_count,
    status = EXCLUDED.status, sold_at = EXCLUDED.sold_at, sold_price = EXCLUDED.sold_price`;

function getLotValues(lot: Lot): unknown[] {
  return [
    lot.id,
    lot.category,
    lot.title,
    lot.description,
    lot.startingBid,
    lot.currentBid,
    lot.currency,
    lot.bidCount,
    lot.status,
    lot.endsAt,
    lot.createdAt,
    lot.soldAt ?? null,
    lot.soldPrice ?? null,
  ];
}

function toIso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

export function getLotFromRow(row: Record<string, unknown>): Lot {
  const lot: Lot = {
    id: String(row.id),
    category: String(row.category),
    title: String(row.title),
    description: String(row.description),
    startingBid: Number(row.starting_bid),
    currentBid: Number(row.current_bid),
    currency: String(row.currency),
    bidCount: Number(row.bid_count),
    status: row.status === 'sold' ? 'sold' : 'open',
    endsAt: toIso(row.ends_at),
    createdAt: toIso(row.created_at),
  };
  if (row.sold_at !== null && row.sold_at !== undefined) lot.soldAt = toIso(row.sold_at);
  if (row.sold_price !== null && row.sold_price !== undefined) lot.soldPrice = Number(row.sold_price);
  return lot;
}

/** Collects every lot a tick touched once, in its latest state. */
function getTouchedLots(changes: Change[]): Lot[] {
  return [...new Map(changes.map((change) => [change.lot.id, change.lot])).values()];
}

/**
 * Keeps the auction in Postgres (Tiger Data). Creates the tables when missing and seeds them when no lot is open.
 * `bids` becomes a TimescaleDB hypertable; on plain Postgres it stays a normal table.
 */
export async function createPostgresStore(databaseUrl: string): Promise<Store> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

  async function saveBatch(lots: Lot[], bids: Bid[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const lot of lots) {
        await client.query(UPSERT_LOT, getLotValues(lot));
      }
      if (bids.length > 0) {
        const placeholders = bids.map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`);
        await client.query(
          `INSERT INTO bids (time, lot_id, amount) VALUES ${placeholders.join(', ')}`,
          bids.flatMap((bid) => [bid.time, bid.lotId, bid.amount]),
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async load(now, random) {
      for (const statement of SCHEMA_STATEMENTS) {
        await pool.query(statement);
      }
      try {
        await pool.query(CREATE_BIDS_HYPERTABLE);
      } catch (error) {
        console.warn(`bids stays a plain table, TimescaleDB is not available: ${String(error)}`);
      }
      for (const category of CATEGORIES) {
        await pool.query('INSERT INTO categories (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name', [
          category.slug,
          category.name,
        ]);
      }

      const openRows = (await pool.query(`SELECT ${LOT_COLUMNS} FROM lots WHERE status = 'open' ORDER BY id`)).rows;
      const maxRow = (await pool.query(`SELECT max(substring(id from 5)::int) AS max FROM lots`)).rows[0] as { max: number | null };
      if (openRows.length === 0) {
        const seed = createSeedState(now, random, (maxRow.max ?? 0) + 1);
        await saveBatch([...seed.state.open.values()], seed.bids);
        console.log(`seeded ${seed.state.open.size} lots`);
        return seed.state;
      }

      const soldRows = (
        await pool.query(`SELECT ${LOT_COLUMNS} FROM lots WHERE status = 'sold' ORDER BY sold_at DESC LIMIT ${RECENTLY_SOLD_SIZE}`)
      ).rows;
      return {
        open: new Map(openRows.map((row) => [String(row.id), getLotFromRow(row)])),
        sold: soldRows.map(getLotFromRow),
        nextLotNumber: (maxRow.max ?? 0) + 1,
      };
    },

    save: (changes, bids) => saveBatch(getTouchedLots(changes), bids),

    close: () => pool.end(),
  };
}
