# auction-house

Gavel & Grain Auctions is a fictional live auction house for woodworking tools, lumber and furniture: six
categories, about 60 open lots, bids that keep rising, lots that sell and new lots that appear. It is the site the self-healing scrapers scrape. A layout
switch changes its markup on the fly, so we can break those scrapers on purpose, live, and watch the factory
heal them.

## How it works

- **State** lives in Tiger Data (Postgres with TimescaleDB) when `TIGER_DATABASE_URL` is set: tables
  `categories`, `lots` and the hypertable `bids`, created and seeded on startup when missing. A restart picks
  up where it left off. Without the URL the same auction runs in memory and starts fresh on every restart.
  On plain Postgres (no TimescaleDB), `bids` stays a normal table.
- **Catalog** (`src/catalog.ts`): a fixed pool of 15 items per category that new lots are drawn from. The
  table `meta` stores `CATALOG_VERSION`; when the code's version differs on startup, the saved lots and bids
  are cleared once and a fresh auction is seeded. Raise the version whenever the catalog changes.
- **Product photos** live in `public/images/<item-slug>.jpg` (512 px), made once with Gemini by
  `pnpm generate-images`. A lot whose photo is missing shows `placeholder.svg`.
- **Simulation** (`src/simulation.ts`), every 2 seconds in the same process: lots past their end time sell at
  their current bid, one to three open lots get a bid (raised by the usual auction increments: $1 under $50,
  $5 under $250, $10 under $1,000, then $25), and new lots appear until about 60 are open again. Lots run
  for 4 to 15 minutes.
- **Pages** are rendered on the server with the full current state, so a scraper needs no JavaScript.
  `GET /ws` (WebSocket) then pushes every change, and a small inline script patches the page: bids flash,
  sold lots get stamped and leave, new lots slide in, countdowns tick.

## Layouts

Switched with `POST /admin/layout` or the buttons on `/admin`. Held in memory (default `v1`).

| Layout | What the page serves |
|---|---|
| `v1` | `section.category[data-category] > h2.category-name`, then `ul.lot-list > li.lot[data-lot][data-category]` with `img.lot-image`, `.lot-title`, `.lot-bid` (`$24.00`), `.lot-bids` (`7 bids`), `time.lot-ends[datetime]`, `.lot-description` |
| `v2-redesign` | `main.auction-grid > article.tile[data-lot][data-category][data-bid][data-currency][data-ends]` with `img.lot-image`, `.tile__title`, `.tile__bids`, `.tile__body` |
| `v3-currency` | `v1` markup, but some bids read `€24,00`, `1 299 Kč` or `$1,299.00` |
| `v4-login` | A sign-in wall, "Sign in to bid and see current bids", no lots (HTTP 200) |
| `v5-injection` | `v1` markup plus lot `LOT-0000`, whose bid is `Reserve not met` and whose description is a prompt injection aimed at a coding agent |
| `flaky` | `v1` markup, but every other request answers 503 |
| `captcha` | A reCAPTCHA v2 wall until the visitor solves it, then `v1` for 10 minutes |

Both `GET /` and `GET /c/:slug` use the current layout. Every page also has a "recently sold" strip
(`ol.sold-list > li.sold-item` in `v1`, `.ticker` in `v2-redesign`), outside the lot lists.

## Routes

- `GET /`: every category with its open lots, ending soonest first, and the recently sold strip.
- `GET /c/:slug`: one category (`hand-tools`, `power-tools`, `lumber`, `chairs-stools`, `tables`, `cabinets-storage`).
- `GET /images/:file`: product photos from `public/images`.
- `GET /ws`: WebSocket. Messages are JSON: `{ "type": "lot", "lot" }` for a new bid,
  `{ "type": "sold", "lotId", "lot" }` and `{ "type": "new", "lot" }`; each `lot` carries its `image` URL.
- `GET /admin`: one button per layout and the current one. Type the admin secret on the page first.
- `POST /admin/layout`: header `x-admin-secret: $ADMIN_SECRET`, JSON `{ "layout": "v2-redesign" }`.
- `POST /captcha/verify`: the gate's form. Checks `g-recaptcha-response` with Google's `siteverify`, sets a
  signed `shop_pass` cookie for 10 minutes and redirects to `/`.
- `GET /health`: `200 ok`.

## Environment variables

```sh
PORT=8080               # HTTP port (App Platform sets it)
ADMIN_SECRET=           # required to switch layouts; without it POST /admin/layout answers 503
TIGER_DATABASE_URL=     # Tiger Data service URL (postgres://...); empty keeps the auction in memory
RECAPTCHA_SITE_KEY=     # reCAPTCHA v2 checkbox site key; set both keys or neither (Google's test keys, which always pass)
RECAPTCHA_SECRET_KEY=   # reCAPTCHA v2 secret key, used for siteverify
COOKIE_SECRET=          # signs the shop_pass cookie; without it a random one is used and passes end on restart
GEMINI_API_KEY=         # only for pnpm generate-images (GEMINI_ACCESS_KEY works too); the server never reads it
```

## Run locally

Node 24 and pnpm. Put the variables in `.env` (gitignored) or pass them inline:

```bash
pnpm install
```

```bash
ADMIN_SECRET=change-me pnpm start
```

```bash
curl -X POST http://localhost:8080/admin/layout -H 'content-type: application/json' -H 'x-admin-secret: change-me' -d '{"layout":"v2-redesign"}'
```

`pnpm check` runs the type check and the tests (no network, no keys, no database).

To make the product photos for items that have none yet (macOS, uses `sips` to shrink them to 512 px):

```bash
GEMINI_API_KEY=... pnpm generate-images
```

It uses `gemini-nano-banana-2.1` through the Gemini Interactions API (`GEMINI_IMAGE_MODEL` overrides it), at
about $0.034 per image. `LIMIT=3` makes only three, to check the look first.

## Deploy on DigitalOcean App Platform

1. Create an app from the monorepo `gippy/self-healing-scraper`, source directory `auction-house/`, built
   from its `Dockerfile` (Node 24, pnpm through corepack, `pnpm start`).
2. App Platform sets `PORT`; the auction house listens on it. Health check path: `/health`. The live updates
   need WebSocket connections to `/ws` to reach the app.
3. Add `ADMIN_SECRET`, `TIGER_DATABASE_URL`, `RECAPTCHA_SECRET_KEY` and `COOKIE_SECRET` as encrypted variables
   and `RECAPTCHA_SITE_KEY` as a plain one. Real reCAPTCHA keys must list the app's domain in the reCAPTCHA
   admin console.

The auction house does not need to redeploy when scrapers change; only the layout switch changes what it serves.
