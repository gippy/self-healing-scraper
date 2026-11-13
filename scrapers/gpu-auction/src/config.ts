import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Empty values (for example `SENTRY_DSN=` in a .env file) count as unset.
const optionalString = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  SCRAPER_NAME: optionalString,
  TARGET_URL: optionalString,
  POLL_SECONDS: z.coerce.number().positive().default(30),
  ADMIN_SECRET: optionalString,
  BRIGHTDATA_API_KEY: optionalString,
  BRIGHTDATA_UNLOCKER_ZONE: optionalString,
  FAKE_BRIGHTDATA: optionalString,
  SENTRY_RELEASE: optionalString,
  SNOWFLAKE_ACCOUNT: optionalString,
  SNOWFLAKE_USER: optionalString,
  SNOWFLAKE_PRIVATE_KEY: optionalString,
  SNOWFLAKE_PRIVATE_KEY_PATH: optionalString,
  SNOWFLAKE_WAREHOUSE: optionalString,
  SNOWFLAKE_DATABASE: optionalString,
  SNOWFLAKE_SCHEMA: optionalString,
  SNOWFLAKE_ROLE: optionalString,
});

export type BrightDataConfig = { isFake: true } | { isFake: false; apiKey: string; zone: string };

/** Key-pair sign-in (`SNOWFLAKE_JWT`) for a `TYPE = SERVICE` user: no password, no MFA. */
export type SnowflakeConfig = {
  account: string;
  username: string;
  /** Unencrypted PKCS#8 PEM. */
  privateKey: string;
  warehouse: string;
  database: string;
  schema: string;
  role: string | undefined;
};

export type Config = {
  port: number;
  scraperName: string;
  targetUrl: string;
  pollMs: number;
  adminSecret: string | undefined;
  release: string | undefined;
  brightData: BrightDataConfig;
  /** Undefined when Snowflake is not configured: items are only logged. */
  snowflake: SnowflakeConfig | undefined;
};

const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----';

/**
 * The private key from `SNOWFLAKE_PRIVATE_KEY` (PEM contents; App Platform values are one line, so literal `\n`
 * counts as a newline) or else the file at `SNOWFLAKE_PRIVATE_KEY_PATH`. Undefined when neither is set.
 */
function readPrivateKey(parsed: z.infer<typeof envSchema>): string | undefined {
  let key: string;
  if (parsed.SNOWFLAKE_PRIVATE_KEY) {
    key = parsed.SNOWFLAKE_PRIVATE_KEY.replaceAll('\\n', '\n');
  } else if (parsed.SNOWFLAKE_PRIVATE_KEY_PATH) {
    try {
      key = readFileSync(parsed.SNOWFLAKE_PRIVATE_KEY_PATH, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read SNOWFLAKE_PRIVATE_KEY_PATH ${parsed.SNOWFLAKE_PRIVATE_KEY_PATH}: ${String(error)}`);
    }
  } else {
    return undefined;
  }
  key = key.trim();
  if (!key.startsWith(PKCS8_HEADER)) {
    throw new Error(
      `The Snowflake private key must be an unencrypted PKCS#8 PEM starting with ${PKCS8_HEADER} ` +
        '(openssl pkcs8 -topk8 -nocrypt converts other formats)',
    );
  }
  return `${key}\n`;
}

/** Reads the scraper's config from the environment and fails with a readable message when something is missing. */
export function getConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.parse(env);
  const missing: string[] = [];
  if (!parsed.SCRAPER_NAME) missing.push('SCRAPER_NAME');
  if (!parsed.TARGET_URL) missing.push('TARGET_URL');

  const isFake = parsed.FAKE_BRIGHTDATA === '1';
  if (!isFake) {
    if (!parsed.BRIGHTDATA_API_KEY) missing.push('BRIGHTDATA_API_KEY (or FAKE_BRIGHTDATA=1)');
    if (!parsed.BRIGHTDATA_UNLOCKER_ZONE) missing.push('BRIGHTDATA_UNLOCKER_ZONE (or FAKE_BRIGHTDATA=1)');
  }

  // Snowflake is all or nothing: a half-configured Snowflake is a deploy mistake, not "log only".
  let snowflake: SnowflakeConfig | undefined;
  const privateKey = readPrivateKey(parsed);
  const snowflakeValues = {
    SNOWFLAKE_ACCOUNT: parsed.SNOWFLAKE_ACCOUNT,
    SNOWFLAKE_USER: parsed.SNOWFLAKE_USER,
    SNOWFLAKE_WAREHOUSE: parsed.SNOWFLAKE_WAREHOUSE,
    SNOWFLAKE_DATABASE: parsed.SNOWFLAKE_DATABASE,
    SNOWFLAKE_SCHEMA: parsed.SNOWFLAKE_SCHEMA,
  };
  if (Object.values(snowflakeValues).some(Boolean) || privateKey) {
    for (const [name, value] of Object.entries(snowflakeValues)) {
      if (!value) missing.push(name);
    }
    if (!privateKey) missing.push('SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PRIVATE_KEY_PATH');
    if (privateKey) {
      snowflake = {
        account: parsed.SNOWFLAKE_ACCOUNT ?? '',
        username: parsed.SNOWFLAKE_USER ?? '',
        privateKey,
        warehouse: parsed.SNOWFLAKE_WAREHOUSE ?? '',
        database: parsed.SNOWFLAKE_DATABASE ?? '',
        schema: parsed.SNOWFLAKE_SCHEMA ?? '',
        role: parsed.SNOWFLAKE_ROLE,
      };
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  return {
    port: parsed.PORT,
    scraperName: parsed.SCRAPER_NAME ?? '',
    targetUrl: parsed.TARGET_URL ?? '',
    pollMs: parsed.POLL_SECONDS * 1000,
    adminSecret: parsed.ADMIN_SECRET,
    release: parsed.SENTRY_RELEASE,
    brightData: isFake
      ? { isFake: true }
      : { isFake: false, apiKey: parsed.BRIGHTDATA_API_KEY ?? '', zone: parsed.BRIGHTDATA_UNLOCKER_ZONE ?? '' },
    snowflake,
  };
}
