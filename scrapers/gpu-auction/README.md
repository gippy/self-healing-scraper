# scraper-template

The runtime of one self-healing scraper. The factory creates a scraper by copying this folder to
`scrapers/<name>/` and having an agent write **only the parser** (`src/parsers/`) and its tests
(`tests/parsers/`, `tests/fixtures/`). Everything else (fetching, the poll loop, Snowflake, Sentry, the routes,
the Dockerfile) stays as it is here. Each scraper is deployed as its own DigitalOcean App Platform app
(`source_dir: scrapers/<name>`, this `Dockerfile`).

What a running scraper does, every `POLL_SECONDS`:

1. fetches `TARGET_URL` through Bright Data's Web Unlocker (`POST https://api.brightdata.com/request` with
   `{ zone, url, format: "raw" }`), retrying once on a 5xx, a timeout or a network error;
2. runs `parse(raw, url)` from `src/parsers/index.ts`;
3. writes the items to Snowflake (`SCRAPED_ITEMS`, one batch insert per poll), or only logs them when
   Snowflake is not configured.

When the parser fails, it reports to Sentry with the page attached; the monitor pauses the scraper
(`POST /pause`), the factory heals the parser and redeploys, and the scraper is resumed.

## The parser contract

The only code the factory writes:

- `src/parsers/index.ts` exports `parse(raw: string, url: string): Item[]`. Pure: no network, clock,
  environment or global state.
- It throws `ParseError` (`src/parsers/errors.ts`) with a message naming what is missing, instead of returning
  partial or empty data.
- `Item` (`src/parsers/item.ts`):
  `{ id: string; title: string; category?: string; price?: { amount: number; currency: string }; bids?: number; status?: string; endsAt?: string; url?: string }`.

The template's parser throws `ParseError('not implemented')`. The runtime also checks what the parser returns:
an empty list, or an item without `id`/`title`, a non-numeric price, negative or fractional `bids`, or an
`endsAt` that is not a date, counts as a `ParseError` and is reported with the page, like a thrown one.

Tests: `tests/helpers/fixtures.ts` has `loadFixture(name)` (reads `tests/fixtures/<name>`) and `listFixtures()`.
Parser tests go in `tests/parsers/*.test.ts`, saved pages in `tests/fixtures/`. The runtime's own tests are in
`tests/runtime/` and need no changes.

```ts
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parse } from '../../src/parsers/index.ts';
import { loadFixture } from '../helpers/fixtures.ts';

it('reads every lot', () => {
  const items = parse(loadFixture('home.html'), 'https://example.com/');
  assert.equal(items.length, 60);
});
```

`pnpm check` (type check plus `node --test "tests/**/*.test.ts"`) needs no network and no keys.

### Example parser (fallback)

`examples/auction-v1/` is a hand-written parser for the auction house's `v1` layout, with two fixtures and
tests, laid out as an overlay. It is not run by `pnpm check` here. To use it:

```bash
cp -R examples/auction-v1/. scrapers/<name>/
```

## What goes to Sentry

All scrapers share one Sentry project; the `scraper` tag tells them apart. Every event carries the tags
`scraper` and `source` (the same value, `SCRAPER_NAME`; `source` is for the monitor built before scrapers).

- Parser failure: the `ParseError` with tag `parser: index`, the page attached as `raw.html` (`text/html`,
  the exact bytes the parser got), context `page: { url, bytes }`. The event keeps the full message; the
  fingerprint is `[<scraper>, <error name>, <normalized message>]`, where the normalized message has id-like
  tokens (`LOT-0042`) replaced by `<id>`, quoted strings by `"…"` and numbers by `<n>`. So
  `Unreadable bid "€44,00" for LOT-0051` groups as `Unreadable bid "…" for <id>`: one issue per kind of
  failure, not one per lot (`normalizeMessage` in `src/reporting.ts`).
- A fetch that failed once and worked on the retry: an `UpstreamError` at level `warning`.
- A fetch that failed on the retry too: an `UpstreamError` at level `error`.
- Both `UpstreamError` cases group by `[<scraper>, 'UpstreamError', <status>]`, where status is the HTTP code,
  `timeout` or `network`.
- Sentry's default dedupe drops an event identical to the one just before it, so a parser failing on every poll
  sends one event until something else is captured in between.
- A failed Snowflake write: the exception with tag `component: snowflake`. The poll still counts as ok.
- Logs through `Sentry.logger` (attribute `scraper`): one `info` per poll (items, ms, sink), `error` on a parser
  failure, `warn` on pause, `info` on resume. Sentry 11 sends logs without an opt-in.

Without `SENTRY_DSN`, Sentry stays off and everything else runs. Sentry starts from `src/instrument.ts`
(`node --import`), before the app.

## Snowflake

Table, created on the first write when missing:

```sql
CREATE TABLE IF NOT EXISTS SCRAPED_ITEMS (
  SCRAPER STRING NOT NULL, ITEM_ID STRING NOT NULL, TITLE STRING, CATEGORY STRING,
  AMOUNT NUMBER(38, 4), CURRENCY STRING, BIDS NUMBER(38, 0), STATUS STRING,
  ENDS_AT TIMESTAMP_TZ, SCRAPED_AT TIMESTAMP_TZ NOT NULL, RAW VARIANT
)
```

One `INSERT ... SELECT ... FROM VALUES` per poll (500 rows per statement), `RAW` is the item as JSON. Every
poll appends rows, so `SCRAPED_AT` makes a time series per item. The driver is `snowflake-sdk`, loaded only
when Snowflake is configured. It connects on the first write and reconnects on the next poll after any failure.

**Sign-in: key pair only.** The scraper signs in as a `TYPE = SERVICE` user with key-pair authentication
(`authenticator: 'SNOWFLAKE_JWT'` in `snowflake-sdk`): no password, so no MFA. The key is an **unencrypted
PKCS#8 PEM** (`-----BEGIN PRIVATE KEY-----`), from one of:

- `SNOWFLAKE_PRIVATE_KEY`: the PEM contents. App Platform values are one line, so literal `\n` sequences count
  as newlines. Wins when both are set.
- `SNOWFLAKE_PRIVATE_KEY_PATH`: a path to the PEM file, for local runs. Read once at startup.

Setting up the key (Jarda's side):

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
```

```bash
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

then `ALTER USER SCRAPER_BOT SET RSA_PUBLIC_KEY = '<rsa_key.pub without the BEGIN/END lines>';`. For App
Platform, `awk 'NF {printf "%s\\n", $0}' rsa_key.p8` prints the key as one line with `\n`.

With none of the Snowflake variables set, items are only logged. A partial Snowflake config (for example an
account but no warehouse, or a key that is not PKCS#8) stops the scraper at startup with a readable message.

## Routes

- `GET /`: status page (paused or not, last poll, last error, newest items), reloads every 10 s.
- `GET /status`: the same as JSON: `{ scraper, targetUrl, paused, reason?, issue?, pausedAt?, lastPoll?: { at, ok, items, ms }, lastOkAt?, lastError?: { at, message }, scrapedAt?, itemCount, sink }`.
- `GET /items`: the items of the last successful poll, a JSON array of `Item`.
- `GET /version`: `{ "release": $SENTRY_RELEASE | null }`; the factory polls it to see its fix deployed.
- `GET /health`: `200 ok`.
- `POST /pause` with JSON `{ "reason": "...", "issue": "SCRAPERS-12" }` (both optional): stops polling.
- `POST /resume`: polls right away and then on schedule again.

Pause and resume need `x-admin-secret: $ADMIN_SECRET` (401 when wrong, 503 when the scraper has no
`ADMIN_SECRET`) and answer with the `/status` JSON. Pause state is in memory: a redeploy starts unpaused, so the
healed version polls as soon as it is live.

## Environment variables

```sh
PORT=8080                    # HTTP port (App Platform sets it)
SCRAPER_NAME=                # required; the scraper's name, Sentry `scraper` tag and SCRAPED_ITEMS.SCRAPER
TARGET_URL=                  # required; the page to scrape
POLL_SECONDS=30              # seconds between polls
ADMIN_SECRET=                # required for POST /pause and /resume; without it they answer 503
BRIGHTDATA_API_KEY=          # Bright Data API key, required unless FAKE_BRIGHTDATA=1
BRIGHTDATA_UNLOCKER_ZONE=    # Web Unlocker zone name, required unless FAKE_BRIGHTDATA=1
FAKE_BRIGHTDATA=             # 1 = fetch TARGET_URL directly (local runs, no Bright Data credit)
SENTRY_DSN=                  # Sentry project DSN; empty turns Sentry off
SENTRY_RELEASE=              # the deployed commit SHA; also served by GET /version
SENTRY_ENVIRONMENT=          # for example production or development
SNOWFLAKE_ACCOUNT=           # orgname-accountname; empty (with the rest) = log only
SNOWFLAKE_USER=              # the service user, e.g. SCRAPER_BOT
SNOWFLAKE_PRIVATE_KEY=       # unencrypted PKCS#8 PEM contents, literal \n allowed (App Platform)
SNOWFLAKE_PRIVATE_KEY_PATH=  # or a path to the PEM file (local runs)
SNOWFLAKE_WAREHOUSE=         # e.g. SCRAPER_WH
SNOWFLAKE_DATABASE=          # e.g. SCRAPERS
SNOWFLAKE_SCHEMA=            # e.g. PUBLIC; the role needs USAGE and CREATE TABLE on it
SNOWFLAKE_ROLE=              # optional, e.g. SCRAPER_ROLE; the user's default role otherwise
```

## Run locally

Node 24 and pnpm. Start the auction house on 8081 (`cd ../auction-house && PORT=8081 pnpm start`), put a parser
in place (for example the example overlay in a copy of this folder), then:

```bash
pnpm install
```

```bash
SCRAPER_NAME=auction-house TARGET_URL=http://localhost:8081/ FAKE_BRIGHTDATA=1 POLL_SECONDS=5 ADMIN_SECRET=change-me pnpm start
```

Open http://localhost:8080. Put the variables in `.env` (gitignored) to keep them.

## Deploy on DigitalOcean App Platform

The factory does this through the API; by hand it is the same:

1. A service with `source_dir: scrapers/<name>`, `dockerfile_path: scrapers/<name>/Dockerfile`,
   `deploy_on_push: true`, `http_port: 8080`, health check `/health`.
2. The variables above; `ADMIN_SECRET`, `BRIGHTDATA_API_KEY`, `SENTRY_DSN` and `SNOWFLAKE_PRIVATE_KEY` as
   encrypted (`type: SECRET`).
3. `SENTRY_RELEASE` as the bindable variable `${_self.COMMIT_HASH}` (scope `RUN_TIME`), so every deploy reports
   its commit to Sentry and on `GET /version`.

The scraper folder itself is the Docker build context: the `Dockerfile` uses only files inside it
(`package.json`, `pnpm-lock.yaml`, `src/`, `tests/`), and `.dockerignore` keeps `node_modules`, `.env*` and
`examples/` out. The image is `node:24-slim` with production dependencies only
(`pnpm install --frozen-lockfile --prod`) and runs `pnpm start`. It is about 780 MB, mostly `snowflake-sdk`'s
cloud storage dependencies.
