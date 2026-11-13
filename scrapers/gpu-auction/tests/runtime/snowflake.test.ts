import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Bind } from 'snowflake-sdk';
import { CREATE_TABLE_SQL, buildInsert, createSnowflakeSink, type SqlRunner } from '../../src/snowflake.ts';
import { ITEMS } from './stubs.ts';

const SCRAPED_AT = '2026-11-13T20:00:00.000Z';

function createFakeConnection(options: { failOn?: RegExp } = {}) {
  const statements: Array<{ sqlText: string; binds: Bind[] }> = [];
  let connects = 0;
  let closes = 0;
  const connect = async (): Promise<SqlRunner> => {
    connects += 1;
    return {
      async execute(sqlText, binds) {
        statements.push({ sqlText, binds });
        if (options.failOn?.test(sqlText)) throw new Error('SQL compilation error');
      },
      async close() {
        closes += 1;
      },
    };
  };
  return { statements, connect, getConnects: () => connects, getCloses: () => closes };
}

describe('Snowflake sink', () => {
  it('creates the table once and inserts one batch per poll', async () => {
    const fake = createFakeConnection();
    const sink = createSnowflakeSink({ scraperName: 'auction-house', connect: fake.connect });

    await sink.write(ITEMS, SCRAPED_AT);
    await sink.write(ITEMS, SCRAPED_AT);

    assert.equal(fake.getConnects(), 1);
    assert.deepEqual(
      fake.statements.map((statement) => statement.sqlText.split('\n')[0]),
      ['CREATE TABLE IF NOT EXISTS SCRAPED_ITEMS (', 'INSERT INTO SCRAPED_ITEMS (SCRAPER, ITEM_ID, TITLE, CATEGORY, AMOUNT, CURRENCY, BIDS, STATUS, ENDS_AT, SCRAPED_AT, RAW)', 'INSERT INTO SCRAPED_ITEMS (SCRAPER, ITEM_ID, TITLE, CATEGORY, AMOUNT, CURRENCY, BIDS, STATUS, ENDS_AT, SCRAPED_AT, RAW)'],
    );
    assert.match(CREATE_TABLE_SQL, /RAW VARIANT/);
  });

  it('binds every column, with null for what the item leaves out and the item as JSON for RAW', () => {
    const { sqlText, binds } = buildInsert('auction-house', ITEMS, SCRAPED_AT);

    assert.equal((sqlText.match(/\?/g) ?? []).length, 22);
    assert.match(sqlText, /PARSE_JSON\(column11\)/);
    assert.deepEqual(binds.slice(0, 11), [
      'auction-house',
      'LOT-0001',
      'Vintage Rubber Duck Debugger',
      'office',
      24,
      'USD',
      7,
      'open',
      '2026-11-13T22:00:00.000Z',
      SCRAPED_AT,
      JSON.stringify(ITEMS[0]),
    ]);
    assert.deepEqual(binds.slice(11), [
      'auction-house',
      'LOT-0002',
      'Signed Off-by-One Socks',
      null,
      null,
      null,
      null,
      null,
      null,
      SCRAPED_AT,
      JSON.stringify(ITEMS[1]),
    ]);
  });

  it('reconnects on the next write after a failed insert', async () => {
    const fake = createFakeConnection({ failOn: /^INSERT/ });
    const sink = createSnowflakeSink({ scraperName: 'auction-house', connect: fake.connect });

    await assert.rejects(sink.write(ITEMS, SCRAPED_AT), /SQL compilation error/);
    await assert.rejects(sink.write(ITEMS, SCRAPED_AT), /SQL compilation error/);

    assert.equal(fake.getConnects(), 2);
    assert.equal(fake.getCloses(), 2);
  });
});
