# Self-healing scraper factory

Give it a URL and it **builds a web scraper**, checks it against the live site, and deploys it. When the site
changes and the scraper breaks, a **monitor** notices in Sentry, pauses the scraper, and the factory **heals**
it: a failing test from the exact page that broke it, a fix, an adversarial review, a calibrated go/no-go,
and a redeploy. No human in the loop unless a gate says one is needed.

Built at the AIE x MLH Hackathon @ Code Summit (2026-11-13).

## The pieces

```
auction-house/  ──(Bright Data Web Unlocker)──▶  scrapers/<name>/  ──▶  Snowflake
 live demo site                                  one DigitalOcean app per scraper
 Tiger Data + WebSocket                          errors + raw page ──▶ Sentry
                                                                         │
factory/  ◀──────────────────────── monitor (Gemini) polls Sentry ◀──────┘
 create: investigate → generate → verify on the live site → Gemini gate → PR → deploy
 heal:   pause → failing test → fix → adversarial review → limits → Gemini gate → merge → redeploy → resume
```

| Folder | What it is |
|---|---|
| [`auction-house/`](auction-house/) | A live auction site: categories, bids that keep rising, lots selling, new lots appearing. State in **Tiger Data** (Postgres + TimescaleDB hypertable of bids), a simulation changing it every 2 s, server-rendered and updated live over a WebSocket. Its design can be switched on the fly (a redesign, new currency formats, a login wall, a CAPTCHA, a prompt-injection lot) to break scrapers on cue. Runs on **DigitalOcean App Platform**. |
| [`scraper-template/`](scraper-template/) | The runtime every scraper shares: fetch through **Bright Data**'s Web Unlocker, parse, write to **Snowflake**, report parser failures to **Sentry** with the raw page attached, pause and resume. The factory writes only `src/parsers/`. |
| `scrapers/<name>/` | Scrapers the factory built and deployed, one **DigitalOcean** app each. |
| [`factory/`](factory/) | The monitor, the factory and the dashboard. |

## How the factory stays honest

The point is a factory you can trust to ship without a human, so every judgement a model makes is checked by
something that isn't that model:

- **Tests first.** Heal mode saves the exact page the parser failed on and must write a test that fails
  the way production did, checked by running it, before any fix. During the fix the test is read-only.
- **Two labs.** The fixer (Kimi K3.1 Pro) and the reviewer (GLM 5.3), both on **DigitalOcean Serverless
  Inference**, come from different labs, so the reviewer doesn't share the fixer's blind spots. The reviewer
  is told to break the fix: swallowed errors, `?.` that turns a crash into wrong data, weak tests, old layouts.
- **Verified on the live site.** Create mode fetches the site again, runs the new parser, checks the output
  in code (items, unique ids, titles, prices) and has the second model read the page and compare.
- **Calibrated gates.** **Gemini Decision 1** answers typed questions with probabilities (risk, fixes the
  root cause, review clear; correct, complete, fails loudly). Code turns them into ship or don't.
- **Limits in code.** A heal may only touch `src/parsers/` and `tests/`, at most 60 lines of production
  code, no dependencies or config. The agents' tools are fenced by a permission callback: writes only under
  allowed paths, a short list of exact commands, no shell chaining, no network. Model-written code runs
  with an environment holding no secrets.
- **Untrusted data stays data.** Pages and Sentry events go through **Apify**'s prompt guard before any
  model reads them; the CAPTCHA and injection layouts exist to show the pipeline refusing correctly.
- **Circuit breaker.** A broken scraper is paused at once, so no bad data reaches Snowflake while it heals.

## Built with

DigitalOcean (App Platform, Serverless Inference, Managed Agents spike) · Gemini (Decision 1, Flash) ·
Sentry · Bright Data · Tiger Data · Snowflake · Apify prompt guard · Claude Agent SDK as the agent harness.

## Run it

Each folder has its own README with every environment variable. In short:

```bash
cd auction-house && pnpm install && pnpm start          # http://localhost:8080, in memory without TIGER_DATABASE_URL
cd factory && pnpm install && POLL_SENTRY=1 pnpm start  # dashboard on http://localhost:8083
curl -X POST localhost:8083/scrapers -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \
  -d '{"name":"auction-house","url":"https://<auction house URL>/"}'
```

[`DESIGN.md`](DESIGN.md) is the build contract the parallel agent sessions worked from; [`PLAN.md`](PLAN.md)
is how the idea evolved during the day.
