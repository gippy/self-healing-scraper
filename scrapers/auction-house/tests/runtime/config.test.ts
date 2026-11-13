import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getConfig } from '../../src/config.ts';

const BASE = { SCRAPER_NAME: 'auction-house', TARGET_URL: 'https://auction.example/', FAKE_BRIGHTDATA: '1' };
const SNOWFLAKE = {
  SNOWFLAKE_ACCOUNT: 'myorg-myaccount',
  SNOWFLAKE_USER: 'SCRAPER_BOT',
  SNOWFLAKE_WAREHOUSE: 'SCRAPER_WH',
  SNOWFLAKE_DATABASE: 'SCRAPERS',
  SNOWFLAKE_SCHEMA: 'PUBLIC',
};
// Not a real key: the config only checks the PKCS#8 framing.
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';

describe('config', () => {
  it('uses the defaults and runs without Snowflake', () => {
    const config = getConfig(BASE);
    assert.equal(config.port, 8080);
    assert.equal(config.pollMs, 30_000);
    assert.deepEqual(config.brightData, { isFake: true });
    assert.equal(config.snowflake, undefined);
  });

  it('names every missing variable', () => {
    assert.throws(() => getConfig({}), /SCRAPER_NAME, TARGET_URL, BRIGHTDATA_API_KEY .*BRIGHTDATA_UNLOCKER_ZONE/);
  });

  it('reads the Bright Data key and zone', () => {
    const config = getConfig({ ...BASE, FAKE_BRIGHTDATA: '', BRIGHTDATA_API_KEY: 'key', BRIGHTDATA_UNLOCKER_ZONE: 'unlocker' });
    assert.deepEqual(config.brightData, { isFake: false, apiKey: 'key', zone: 'unlocker' });
  });

  it('reads the private key from SNOWFLAKE_PRIVATE_KEY with literal \\n as newlines', () => {
    const config = getConfig({ ...BASE, ...SNOWFLAKE, SNOWFLAKE_ROLE: 'SCRAPER_ROLE', SNOWFLAKE_PRIVATE_KEY: PEM.replaceAll('\n', '\\n') });
    assert.deepEqual(config.snowflake, {
      account: 'myorg-myaccount',
      username: 'SCRAPER_BOT',
      privateKey: PEM,
      warehouse: 'SCRAPER_WH',
      database: 'SCRAPERS',
      schema: 'PUBLIC',
      role: 'SCRAPER_ROLE',
    });
  });

  it('reads the private key from the file at SNOWFLAKE_PRIVATE_KEY_PATH', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'scraper-config-')), 'rsa_key.p8');
    writeFileSync(path, PEM);
    assert.equal(getConfig({ ...BASE, ...SNOWFLAKE, SNOWFLAKE_PRIVATE_KEY_PATH: path }).snowflake?.privateKey, PEM);
    assert.throws(() => getConfig({ ...BASE, ...SNOWFLAKE, SNOWFLAKE_PRIVATE_KEY_PATH: `${path}.missing` }), /Cannot read SNOWFLAKE_PRIVATE_KEY_PATH/);
  });

  it('refuses a key that is not unencrypted PKCS#8', () => {
    const pkcs1 = PEM.replaceAll('PRIVATE KEY', 'RSA PRIVATE KEY');
    assert.throws(() => getConfig({ ...BASE, ...SNOWFLAKE, SNOWFLAKE_PRIVATE_KEY: pkcs1 }), /unencrypted PKCS#8/);
  });

  it('refuses a half-configured Snowflake', () => {
    assert.throws(() => getConfig({ ...BASE, SNOWFLAKE_ACCOUNT: 'myorg-myaccount', SNOWFLAKE_PRIVATE_KEY: PEM }), /SNOWFLAKE_USER.*SNOWFLAKE_SCHEMA/);
    assert.throws(() => getConfig({ ...BASE, ...SNOWFLAKE }), /SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PRIVATE_KEY_PATH/);
  });
});
