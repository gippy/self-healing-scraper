# Self-healing scraper factory — build contract v2 (2026-11-13 12:00 PST)

Replaces v1. Every builder reads this first, then `PLAN.md` for the why. Change shared pieces only through the
coordinating session; flag anything wrong instead of working around it. Submissions close **15:00 PST**;
code freeze for builders **13:15**, then integration, deploy, video.

## The story

1. **Auction house** (on DigitalOcean): a live e-commerce auction site. Categories, lots, bids that keep
   rising, lots selling, new lots appearing. Its state lives in **Tiger Data** (Postgres + TimescaleDB); a
   simulation keeps changing it; the page renders on the server and updates live over a **WebSocket**. Its
   design can be switched on the fly (the "site redesign" that breaks scrapers), including a CAPTCHA wall.
2. **Scraper factory** (the main product): give it a URL and it **creates** a scraper: investigates the site,
   writes a parser and tests, runs test executions against the live site, compares the results with what the
   site shows, and only with confidence (Gemini Decisions gate) **deploys it as a new DigitalOcean app**
   that writes to **Snowflake**. When a scraper breaks, it **heals** it the same way and redeploys.
3. **Monitor** (Sentry log agent): watches Sentry, uses **Gemini** inference to read the logs and **Gemini
   Decision 1** to judge them, **pauses the scraper**, hands the issue to the factory, and the scraper is
   resumed after the fix is deployed.

Bright Data's Web Unlocker fetches every page. Apify's prompt guard screens untrusted text before models.
Agents run on DigitalOcean Serverless Inference (open-weight models; see "Models"), and we try running them
on DigitalOcean Managed Agents.

## Monorepo `gippy/self-healing-scraper` (public)

| Folder | What | Owner |
|---|---|---|
| `auction-house/` | The auction site (was `shop/`) | session "Build the demo shop and the feed" |
| `scraper-template/` | The scraper runtime the factory copies (was `feed/`) | new session "scraper template" |
| `scrapers/<name>/` | Scrapers the factory created | the factory (generated) |
| `factory/src/{triage,dashboard}/`, `factory/src/{main,sentry,guard,feed,decisions,gemini}.ts` | Monitor + dashboard | session "Build the Sentry triage and the dashboard" |
| `factory/src/factory/`, `factory/src/registry.ts`, `factory/src/types.ts`, `factory/scripts/` | Factory, scraper registry, shared types | coordinating session |
| `factory/src/factory/managed.ts` | DigitalOcean Managed Agents runtime | new session "managed agents" |

Nested `.git` folders go away when the monorepo is assembled; don't commit or push, the coordinator does.
`HACKATHON_INFO.md` stays out of git (personal details).

## Stack (unchanged)

TypeScript on Node 24 type stripping (`node src/main.ts`, erasable syntax only, `.ts` imports), pnpm, Hono,
zod, `node --test`, `pnpm check` = `tsc --noEmit` + tests, passing with no network and no keys. Config from
env (`node --env-file-if-exists=.env`; agents can't write `.env*`, Jarda does). Each deployable folder has a
`Dockerfile` (node:24-slim, corepack + pnpm, `pnpm install --frozen-lockfile`, `CMD ["pnpm", "start"]`) and
listens on `PORT` (App Platform sets it; default 8080). `GET /health` → `ok`.

## A. Auction house (`auction-house/`)

- **Data in Tiger** (`TIGER_DATABASE_URL`, `pg`). Tables: `categories (slug pk, name)`, `lots (id pk 'LOT-0001',
  category text, title, description, starting_bid numeric, current_bid numeric, currency text default 'USD',
  bid_count int, status text 'open'|'sold', ends_at timestamptz, created_at, sold_at, sold_price)`, and
  hypertable `bids (time, lot_id, amount)`. Created and seeded on startup if missing: 6 categories, about 60
  open lots with made-up, funny-but-plausible titles (fictional brand, nothing imitating a real company).
- **Simulation** in the same process, every 2 s: a few random bids on open lots (current bid rises by a sane
  increment, bid count +1, a `bids` row), lots past `ends_at` become `sold`, new lots appear so about 60 stay
  open. Every change is broadcast to WebSocket clients.
- **Pages:** `GET /` all categories with their open lots (and a "recently sold" strip), `GET /c/:slug` one
  category. **Server-rendered with the full current state** (scrapers must not need JavaScript), then
  `GET /ws` (WebSocket) pushes `{ type: 'lot', lot }` and `{ type: 'sold', lotId }` / `{ type: 'new', lot }`
  and a small inline script patches the DOM. It should look good on a projector: this is the demo's first shot.
- **Layouts** (switch via `POST /admin/layout` with `x-admin-secret: $ADMIN_SECRET`, admin page with buttons):
  `v1`, `v2-redesign`, `v3-currency`, `v4-login`, `v5-injection`, `flaky`, `captcha` — same meaning as before,
  now with categories. `v1`: `section.category[data-category] > h2.category-name` containing
  `ul.lot-list > li.lot[data-lot][data-category]` with `.lot-title`, `.lot-bid` (`$24.00`), `.lot-bids`
  (`7 bids`), `time.lot-ends[datetime]`, `.lot-description`. `v2-redesign`: `main.auction-grid >
  article.tile[data-lot][data-category][data-bid][data-currency][data-ends]` with `.tile__title`,
  `.tile__bids`, `.tile__body`. Keep the captcha gate exactly as built.
- **Without `TIGER_DATABASE_URL`:** the same simulation in memory, so it runs locally and in tests.

## B. Scraper template (`scraper-template/`)

What the factory copies to `scrapers/<name>/` and deploys. Built from the old feed.

- Config: `SCRAPER_NAME`, `TARGET_URL`, `POLL_SECONDS` (default 30), `ADMIN_SECRET`, Bright Data
  (`BRIGHTDATA_API_KEY`, `BRIGHTDATA_UNLOCKER_ZONE`; `FAKE_BRIGHTDATA=1` fetches directly), Sentry
  (`SENTRY_DSN`, `SENTRY_RELEASE`, `SENTRY_ENVIRONMENT`), Snowflake (see below).
- Loop: fetch `TARGET_URL` through Web Unlocker (one retry), `parse(raw, url)`, write the items to Snowflake.
- **Parser contract** (the only thing the factory writes): `src/parsers/index.ts` exports
  `parse(raw: string, url: string): Item[]`, throwing `ParseError` (`src/parsers/errors.ts`) instead of
  returning partial or empty data. `Item = { id: string; title: string; category?: string;
  price?: { amount: number; currency: string }; bids?: number; status?: string; endsAt?: string; url?: string }`
  (in `src/parsers/item.ts`). The template ships a parser that throws `ParseError('not implemented')`, a
  `tests/` folder with a helper to load fixtures, and nothing else in `src/parsers/`.
- **Sentry:** parser errors captured with tags `scraper=$SCRAPER_NAME`, `parser=index`, the raw page
  attached as `raw.html`; Bright Data failures fixed by the retry as a warning `UpstreamError`; logs via
  Sentry's logger. All scrapers share one Sentry project; the `scraper` tag tells them apart.
- **Snowflake:** `snowflake-sdk` with **key-pair auth** for service user `SCRAPER_BOT` (`SNOWFLAKE_JWT`),
  env `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PRIVATE_KEY_PATH` (local) or `SNOWFLAKE_PRIVATE_KEY`
  (PEM contents with `\n` escapes, for App Platform), `SNOWFLAKE_WAREHOUSE` (`SCRAPER_WH`),
  `SNOWFLAKE_DATABASE` (`SCRAPERS`), `SNOWFLAKE_SCHEMA` (`PUBLIC`). Table `SCRAPED_ITEMS (SCRAPER,
  ITEM_ID, TITLE, CATEGORY, AMOUNT, CURRENCY, BIDS, STATUS, ENDS_AT, SCRAPED_AT, RAW VARIANT)`, created if
  missing, one batch insert per poll. Without Snowflake config: log only.
- Routes: `GET /` status page (paused?, last poll, last error, newest items), `GET /items` (newest items JSON),
  `GET /version` → `{ release }`, `GET /health`, `POST /pause` with `{ reason, issue }` and `POST /resume`
  (both `x-admin-secret`). A paused scraper doesn't poll.
- `Dockerfile` as in Stack; `pnpm check` passes.

## C. Monitor (`factory/`, triage session)

As built, with these changes:
- **Decisions:** `src/decisions.ts` exports `askDecisions(input: string, questions): Promise<Answers | undefined>`
  for **Gemini Decision 1**: `POST https://generativelanguage.googleapis.com/v1beta/decisions`, header
  `x-goog-api-key: $GEMINI_API_KEY` (fall back to `$GEMINI_ACCESS_KEY`), body `{ model: "gemini-decision-1",
  input, questions }`. Question types `noul` (criteria `{ true_description, false_description }`, optional),
  `choice` (criteria = map of option to description), `score` (criteria = ordered array). Answers: `noul`
  (p of yes, 0.01–0.99) + `confidence`; `choice` + `probabilities` + `confidence`; `score` + `probabilities`
  + `legend` + `confidence`. Two attempts, 15 s timeout, `undefined` when it can't answer. Replaces Jev
  (`src/jev.ts` goes); the factory's gate imports `askDecisions` too.
- **Gemini inference:** `src/gemini.ts` `explain(eventMarkdown, recentLogs)`: a Gemini Flash model (check
  the current model ids in the docs) writes a short plain-language reading of what broke, shown on the dashboard
  and passed to the decision questions as part of `input`.
- **Scraper lookup:** the Sentry `scraper` tag names the scraper; `getScraper(name)` from `src/registry.ts`
  (coordinator) gives its URL; pause with `POST {url}/pause`, header `x-admin-secret: $SCRAPER_ADMIN_SECRET`.
- Polling Sentry (`POLL_SENTRY=1`) is the main mode: the factory runs on Jarda's laptop for the demo.
- The dashboard also shows **create** runs (see `PipelineEvent.kind`) and a list of scrapers with their status.

## D. Factory (`factory/src/factory/`, coordinator)

- **Create:** `POST /scrapers` with `x-admin-secret`, JSON `{ name, url, fields?: string }` → investigate (fetch
  the page through Bright Data a few times, save fixtures), copy the template to `scrapers/<name>/`, an agent
  writes `src/parsers/index.ts` + tests, run them, then **verify against the live site** (fetch fresh, run the
  parser, a reviewer compares the output with the page), Gemini gate, commit, push, **create a DigitalOcean
  App Platform app** (`DO_API_TOKEN`, `POST https://api.digitalocean.com/v2/apps` with `{ spec }`, a `git`
  source `{ repo_clone_url: https://github.com/gippy/self-healing-scraper.git, branch: main }` so no GitHub
  app install is needed, `source_dir: scrapers/<name>`, `dockerfile_path: scrapers/<name>/Dockerfile`,
  `http_port: 8080`, `instance_size_slug: apps-s-1vcpu-0.5gb`, region `sfo`, envs as SECRET), wait until
  `active_deployment` is the new one and read `live_url`, register it.
- **Heal:** as built (worktree, failing test from the attached page, fix, adversarial review, limits, gate,
  PR, merge), on `scrapers/<name>/`; a `git` source doesn't deploy on push, so the factory triggers
  `POST /v2/apps/{id}/deployments` after the merge, waits for it, then resumes and resolves.
- **Registry** `factory/src/registry.ts`: `{ name, url, appId, dir, createdAt }` per scraper, saved in
  `factory/work/scrapers.json`. Exports `getScraper`, `listScrapers`, `saveScraper`.

## E. Managed Agents (`factory/src/factory/managed.ts`, managed-agents session)

`runAgentManaged(options: AgentOptions): Promise<AgentRun<T>>` with the same types as `runAgent` in
`agents.ts`, running the agent on DigitalOcean Managed Agents instead of locally, selected by
`AGENT_RUNTIME=do-managed`. It must bring the agent's file changes back into the local worktree (for
example as a patch) so the factory's own checks, limits and tests run unchanged.

## Shared types (`factory/src/types.ts`, coordinator)

`Stage` gains `investigate`, `generate`, `verify`, `deploy`, `registered`; `PipelineEvent` gains
`kind?: 'create' | 'heal'` and `scraper?: string`; `FactoryInput` gains `scraper?: string`.

## Models

DigitalOcean Serverless Inference (`DO_MODEL_ACCESS_KEY`, Anthropic Messages endpoint
`https://inference.do-ai.run`): Claude and GPT get 403 on Jarda's account tier, so the agents use open-weight
models from two labs: fixer `kimi-k3.1-pro`, reviewer `glm-5.3`, side tasks `minimax-m3.1-flash`.
Decisions: `gemini-decision-1`. Log reading: a Gemini Flash model.

## Environment variables

auction-house: `PORT`, `ADMIN_SECRET`, `TIGER_DATABASE_URL`, `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`, `COOKIE_SECRET`.
scraper-template: `PORT`, `SCRAPER_NAME`, `TARGET_URL`, `POLL_SECONDS`, `ADMIN_SECRET`, `BRIGHTDATA_API_KEY`,
`BRIGHTDATA_UNLOCKER_ZONE`, `FAKE_BRIGHTDATA`, `SENTRY_DSN`, `SENTRY_RELEASE`, `SENTRY_ENVIRONMENT`,
`SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PRIVATE_KEY_PATH` / `SNOWFLAKE_PRIVATE_KEY`, `SNOWFLAKE_WAREHOUSE`,
`SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`.
factory: `PORT`, `ADMIN_SECRET`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` (`jaroslav-hejlek`), `SENTRY_PROJECT`,
`POLL_SENTRY`, `APIFY_TOKEN`, `PROMPT_GUARD_INTERNAL_KEY`, `GEMINI_API_KEY` / `GEMINI_ACCESS_KEY`,
`DO_MODEL_ACCESS_KEY`, `DO_API_TOKEN`, `FIXER_MODEL`, `REVIEWER_MODEL`, `SMALL_MODEL`, `AGENT_RUNTIME`,
`TARGET_REPO` (`gippy/self-healing-scraper`), `GITHUB_TOKEN`, `SCRAPER_ADMIN_SECRET`, plus everything a
deployed scraper needs (passed into its App Platform spec): `BRIGHTDATA_*`, `SENTRY_DSN`, `SNOWFLAKE_*`.

Secrets never go in code, logs, Sentry events, the dashboard or git.
