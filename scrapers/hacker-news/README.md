# hacker-news

A scraper for the [Hacker News](https://news.ycombinator.com/) front page, built by **Gemini 4 Carbon**
(`gemini-4-carbon`) with [`factory/scripts/gemini-build.ts`](../../factory/scripts/gemini-build.ts). It is an
example in the codebase only: not deployed, and the monitor doesn't watch it. Carbon wrote
`src/parsers/index.ts` and `tests/parser.test.ts`; everything else is the [scraper template](../../scraper-template/)
as it is.

## What it reads

`parse(raw, url)` returns the 30 front-page stories as `Story`: `Item` plus `rank`, `site`, `points`, `author`,
`age` (as shown, "1 hour ago"), `postedAt` (ISO, from the age element's `title`) and `comments`. Job ads show no
points, author or comments, so those stay out; any other story without them throws `ParseError`.

```json
{ "id": "50489641", "rank": 1, "title": "FAA Issues National Ground Stop",
  "url": "https://www.fly.faa.gov/adv/adv_otherdis?adv_date=11132026&advn=111", "site": "faa.gov",
  "points": 767, "author": "zulln", "age": "1 hour ago", "postedAt": "2026-11-13T21:05:53.000Z", "comments": 415 }
```

## How it was built

The factory's own builder is a Claude agent on DigitalOcean Serverless Inference, which doesn't serve Gemini, so
the script runs the factory's steps around one plain `generateContent` call. It fetched the page twice through
Bright Data (`tests/fixtures/page-1.html`, `page-2.html`), had Apify's prompt guard check it (clean), copied the
template, and sent Carbon the pages with the factory's parser contract and code style (`GENERATE_SYSTEM`), asking
for both files as JSON. Carbon answered in 203 s (28,417 prompt, 14,797 thinking and 3,899 output tokens).
`pnpm check` passed on that first answer, so neither of the two allowed repair rounds was needed.

## How it was checked

- `pnpm check`: type check and 41 tests (Carbon's 6 parser tests and the template's runtime tests) pass.
- A third fetch of the live page (`tests/fixtures/live.html`): the parser read 30 stories. The factory's checks in
  code (items, unique ids, titles) and two for this site (one item per story row, ranks 1 to 30) all passed.
- Afterwards, by hand: a regex cross-check of all 30 live stories against the raw HTML (id, rank, title, points,
  author, comments, age) found no mismatch.
- Gemini Decision 1 (the factory's create gate): **correct 0.30, complete 0.13, fails loudly 0.81**. Two answers are
  below the 0.75 threshold, so the factory would have opened a PR for a human instead of deploying. Probably the
  evidence was thin: this example has no independent verifier, and the gate saw only the first 15 items, the
  first five or so stories of the page's HTML, and "all passed" without the list of checks.

## Rebuild

```bash
cd factory && node --env-file-if-exists=.env scripts/gemini-build.ts
```

It needs `GEMINI_API_KEY` or `GEMINI_ACCESS_KEY`, fetches the page three times, and stops if `scrapers/hacker-news`
already exists.
