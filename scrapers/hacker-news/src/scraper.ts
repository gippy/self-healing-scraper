import { z } from 'zod';
import type { PageFetcher } from './brightdata.ts';
import { ParseError } from './parsers/errors.ts';
import type { Item } from './parsers/item.ts';
import { getMessage, type Reporter } from './reporting.ts';
import type { ItemSink } from './snowflake.ts';

export type Parse = (raw: string, url: string) => Item[];

// The runtime checks the parser's output, so a generated parser cannot slip bad rows into Snowflake.
const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().optional(),
  price: z.object({ amount: z.number().finite(), currency: z.string().min(1) }).optional(),
  bids: z.number().int().nonnegative().optional(),
  status: z.string().optional(),
  endsAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'not a date').optional(),
  url: z.string().optional(),
});

export type ScraperStatus = {
  scraper: string;
  targetUrl: string;
  paused: boolean;
  reason?: string;
  issue?: string;
  pausedAt?: string;
  lastPoll?: { at: string; ok: boolean; items: number; ms: number };
  lastOkAt?: string;
  lastError?: { at: string; message: string };
  /** When the items served by `GET /items` were scraped. */
  scrapedAt?: string;
  itemCount: number;
  sink: string;
};

export type Scraper = ReturnType<typeof createScraper>;

/** Checks what the parser returned; throws `ParseError` naming the first problem. */
export function checkItems(items: unknown): Item[] {
  if (!Array.isArray(items)) {
    throw new ParseError('Parser returned no list of items');
  }
  if (items.length === 0) {
    throw new ParseError('Parser returned no items');
  }
  return items.map((item, index) => {
    const result = itemSchema.safeParse(item);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new ParseError(`Item #${index + 1} is invalid: ${issue?.path.join('.') || 'item'} ${issue?.message ?? ''}`.trim());
    }
    return item as Item;
  });
}

/**
 * The poll loop: fetch the target page, parse it, write the items. Failures are reported, never thrown.
 * A paused scraper does not poll until it is resumed.
 */
export function createScraper(options: {
  name: string;
  targetUrl: string;
  fetchPage: PageFetcher;
  parse: Parse;
  sink: ItemSink;
  reporter: Reporter;
}) {
  const { reporter } = options;
  let items: Item[] = [];
  let scrapedAt: string | undefined;
  let pause: { reason: string; issue?: string; at: string } | undefined;
  let lastPoll: ScraperStatus['lastPoll'];
  let lastOkAt: string | undefined;
  let lastError: ScraperStatus['lastError'];
  let isPolling = false;
  let timer: NodeJS.Timeout | undefined;

  function finish(at: string, startedAt: number, itemCount: number, error?: unknown): void {
    lastPoll = { at, ok: error === undefined, items: itemCount, ms: Math.round(performance.now() - startedAt) };
    if (error === undefined) {
      lastOkAt = at;
    } else {
      lastError = { at, message: getMessage(error) };
    }
  }

  async function poll(): Promise<void> {
    const at = new Date().toISOString();
    const startedAt = performance.now();

    let raw: string;
    try {
      const result = await options.fetchPage(options.targetUrl);
      if (result.recoveredFrom) {
        reporter.upstreamRecovered(result.recoveredFrom);
      }
      raw = result.body;
    } catch (error) {
      reporter.upstreamFailed(error);
      finish(at, startedAt, 0, error);
      return;
    }

    let parsed: Item[];
    try {
      parsed = checkItems(options.parse(raw, options.targetUrl));
    } catch (error) {
      reporter.parseError(error, raw, options.targetUrl);
      finish(at, startedAt, 0, error);
      return;
    }

    items = parsed;
    scrapedAt = at;
    finish(at, startedAt, parsed.length);
    reporter.polled(parsed.length, lastPoll?.ms ?? 0, options.sink.name);

    try {
      await options.sink.write(parsed, at);
    } catch (error) {
      reporter.storageError(error);
      lastError = { at, message: `Snowflake: ${getMessage(error)}` };
    }
  }

  /** Polls now unless the scraper is paused or a poll is running. Returns whether it polled. */
  async function pollIfRunning(): Promise<boolean> {
    if (pause || isPolling) {
      return false;
    }
    isPolling = true;
    try {
      await poll();
    } finally {
      isPolling = false;
    }
    return true;
  }

  return {
    pollIfRunning,

    /** Polls now and then every `intervalMs` (skipped while paused). */
    start(intervalMs: number): void {
      const run = async () => {
        await pollIfRunning();
        timer = setTimeout(run, intervalMs);
      };
      void run();
    },

    stop(): void {
      clearTimeout(timer);
      timer = undefined;
    },

    pause(reason: string, issue?: string): void {
      pause = { reason, at: new Date().toISOString(), ...(issue ? { issue } : {}) };
      reporter.paused(reason, issue);
    },

    /** Starts polling again, beginning with a poll right away. */
    resume(): void {
      const wasPaused = pause !== undefined;
      pause = undefined;
      if (wasPaused) {
        reporter.resumed();
      }
      void pollIfRunning();
    },

    getItems(): Item[] {
      return items;
    },

    getStatus(): ScraperStatus {
      return {
        scraper: options.name,
        targetUrl: options.targetUrl,
        paused: pause !== undefined,
        ...(pause ? { reason: pause.reason, pausedAt: pause.at, ...(pause.issue ? { issue: pause.issue } : {}) } : {}),
        ...(lastPoll ? { lastPoll } : {}),
        ...(lastOkAt ? { lastOkAt } : {}),
        ...(lastError ? { lastError } : {}),
        ...(scrapedAt ? { scrapedAt } : {}),
        itemCount: items.length,
        sink: options.sink.name,
      };
    },
  };
}
