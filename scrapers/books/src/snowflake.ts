import type { Bind } from 'snowflake-sdk';
import type { SnowflakeConfig } from './config.ts';
import type { Item } from './parsers/item.ts';

/** Where a poll's items go. */
export type ItemSink = {
  name: string;
  write(items: Item[], scrapedAt: string): Promise<void>;
  close(): Promise<void>;
};

/** The two things the sink needs from a Snowflake connection; tests pass a fake. */
export type SqlRunner = {
  execute(sqlText: string, binds: Bind[]): Promise<void>;
  close(): Promise<void>;
};

export const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS SCRAPED_ITEMS (
  SCRAPER STRING NOT NULL,
  ITEM_ID STRING NOT NULL,
  TITLE STRING,
  CATEGORY STRING,
  AMOUNT NUMBER(38, 4),
  CURRENCY STRING,
  BIDS NUMBER(38, 0),
  STATUS STRING,
  ENDS_AT TIMESTAMP_TZ,
  SCRAPED_AT TIMESTAMP_TZ NOT NULL,
  RAW VARIANT
)`;

const COLUMNS = 'SCRAPER, ITEM_ID, TITLE, CATEGORY, AMOUNT, CURRENCY, BIDS, STATUS, ENDS_AT, SCRAPED_AT, RAW';
const ROW_PLACEHOLDERS = `(${Array.from({ length: 11 }, () => '?').join(', ')})`;
// Keeps one statement's bind count well under Snowflake's limits.
const ROWS_PER_STATEMENT = 500;

/**
 * One INSERT for a batch of items. VARIANT and timestamps cannot be bound directly, so the rows go through a
 * VALUES list and are converted in the SELECT.
 */
export function buildInsert(scraper: string, items: Item[], scrapedAt: string): { sqlText: string; binds: Bind[] } {
  const binds: Bind[] = items.flatMap((item) => [
    scraper,
    item.id,
    item.title,
    item.category ?? null,
    item.price?.amount ?? null,
    item.price?.currency ?? null,
    item.bids ?? null,
    item.status ?? null,
    item.endsAt ?? null,
    scrapedAt,
    JSON.stringify(item),
  ]);
  const sqlText = `INSERT INTO SCRAPED_ITEMS (${COLUMNS})
SELECT column1, column2, column3, column4, column5, column6, column7, column8,
  TRY_TO_TIMESTAMP_TZ(column9::VARCHAR), TO_TIMESTAMP_TZ(column10), PARSE_JSON(column11)
FROM VALUES ${items.map(() => ROW_PLACEHOLDERS).join(', ')}`;
  return { sqlText, binds };
}

/**
 * Writes each poll's items to `SCRAPED_ITEMS`, creating the table on first use. Connects lazily and reconnects
 * on the next poll after any failure.
 */
export function createSnowflakeSink(options: { scraperName: string; connect: () => Promise<SqlRunner> }): ItemSink {
  let runner: Promise<SqlRunner> | undefined;

  async function getRunner(): Promise<SqlRunner> {
    runner ??= (async () => {
      const connected = await options.connect();
      await connected.execute(CREATE_TABLE_SQL, []);
      return connected;
    })();
    try {
      return await runner;
    } catch (error) {
      runner = undefined;
      throw error;
    }
  }

  return {
    name: 'snowflake',

    async write(items, scrapedAt) {
      const connected = await getRunner();
      try {
        for (let start = 0; start < items.length; start += ROWS_PER_STATEMENT) {
          const { sqlText, binds } = buildInsert(options.scraperName, items.slice(start, start + ROWS_PER_STATEMENT), scrapedAt);
          await connected.execute(sqlText, binds);
        }
      } catch (error) {
        runner = undefined;
        await connected.close().catch(() => undefined);
        throw error;
      }
    },

    async close() {
      const current = runner;
      runner = undefined;
      await (await current?.catch(() => undefined))?.close().catch(() => undefined);
    },
  };
}

/** Connects with `snowflake-sdk`, loaded only when Snowflake is configured. */
export async function connectSnowflake(config: SnowflakeConfig): Promise<SqlRunner> {
  const snowflake = (await import('snowflake-sdk')).default;
  snowflake.configure({ logLevel: 'ERROR' });

  const connection = snowflake.createConnection({
    account: config.account,
    username: config.username,
    warehouse: config.warehouse,
    database: config.database,
    schema: config.schema,
    ...(config.role ? { role: config.role } : {}),
    authenticator: 'SNOWFLAKE_JWT',
    privateKey: config.privateKey,
    clientSessionKeepAlive: true,
  });
  await connection.connectAsync();

  return {
    execute: (sqlText, binds) =>
      new Promise((resolve, reject) => {
        connection.execute({
          sqlText,
          binds,
          complete: (error) => (error ? reject(error) : resolve()),
        });
      }),
    close: () =>
      new Promise((resolve) => {
        connection.destroy(() => resolve());
      }),
  };
}

/** Used without Snowflake config: the items are only logged. */
export function createLogSink(scraperName: string): ItemSink {
  return {
    name: 'log',
    async write(items) {
      console.log(`[${scraperName}] Snowflake is not configured: ${items.length} items logged, not stored`);
    },
    async close() {},
  };
}
