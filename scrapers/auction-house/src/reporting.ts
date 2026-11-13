import * as Sentry from '@sentry/node';
import { UpstreamError } from './brightdata.ts';

/** Everything the scraper tells Sentry and the console. */
export type Reporter = {
  /** The parser threw (or returned nothing usable) on `raw`, the exact page it got. */
  parseError(error: unknown, raw: string, url: string): void;
  /** The first fetch failed and the retry succeeded. */
  upstreamRecovered(error: Error): void;
  /** The fetch failed on the retry too. */
  upstreamFailed(error: unknown): void;
  /** Writing the items to Snowflake failed; the poll itself worked. */
  storageError(error: unknown): void;
  polled(itemCount: number, durationMs: number, sink: string): void;
  paused(reason: string, issue: string | undefined): void;
  resumed(): void;
};

export function getMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Replaces the volatile parts of an error message, so one broken layout is one Sentry issue and not one per lot:
 * id-like tokens (`LOT-0042`) become `<id>`, quoted strings `"…"`, numbers `<n>`.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[A-Z]{2,}-\d+\b/g, '<id>')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+([.,]\d+)?/g, '<n>');
}

/** `[scraper, error name, normalized message]` for parser failures (the event keeps the full message). */
export function getParseFingerprint(scraperName: string, error: unknown): string[] {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return [scraperName, name, normalizeMessage(message)];
}

/** `[scraper, 'UpstreamError', status]`; `status` is the HTTP code, `timeout` or `network`. */
export function getUpstreamFingerprint(scraperName: string, error: unknown): string[] {
  return [scraperName, 'UpstreamError', error instanceof UpstreamError ? String(error.status) : normalizeMessage(getMessage(error))];
}

/**
 * Reports to Sentry and the console. Every event carries `scraper` (and `source`, the same name, for the monitor
 * built before scrapers existed). Sentry calls do nothing when `Sentry.init` did not run (no `SENTRY_DSN`).
 */
export function createSentryReporter(scraperName: string): Reporter {
  const prefix = `[${scraperName}]`;

  function withScraperScope(callback: (scope: Sentry.Scope) => void): void {
    Sentry.withScope((scope) => {
      scope.setTag('scraper', scraperName);
      scope.setTag('source', scraperName);
      callback(scope);
    });
  }

  return {
    parseError(error, raw, url) {
      console.error(`${prefix} parser failed: ${getMessage(error)}`);
      withScraperScope((scope) => {
        scope.setTag('parser', 'index');
        scope.setContext('page', { url, bytes: Buffer.byteLength(raw) });
        // One issue per kind of failure: a login wall and a redesign stay apart, lots with changing ids do not split.
        scope.setFingerprint(getParseFingerprint(scraperName, error));
        scope.addAttachment({ filename: 'raw.html', data: raw, contentType: 'text/html' });
        Sentry.captureException(error);
      });
      Sentry.logger.error(Sentry.logger.fmt`${scraperName}: parser failed: ${getMessage(error)}`, { scraper: scraperName });
    },

    upstreamRecovered(error) {
      console.warn(`${prefix} retry succeeded after: ${getMessage(error)}`);
      withScraperScope((scope) => {
        scope.setLevel('warning');
        scope.setFingerprint(getUpstreamFingerprint(scraperName, error));
        Sentry.captureException(error);
      });
    },

    upstreamFailed(error) {
      console.error(`${prefix} fetch failed: ${getMessage(error)}`);
      withScraperScope((scope) => {
        scope.setFingerprint(getUpstreamFingerprint(scraperName, error));
        Sentry.captureException(error);
      });
    },

    storageError(error) {
      console.error(`${prefix} writing to Snowflake failed: ${getMessage(error)}`);
      withScraperScope((scope) => {
        scope.setTag('component', 'snowflake');
        Sentry.captureException(error);
      });
    },

    polled(itemCount, durationMs, sink) {
      console.log(`${prefix} ${itemCount} items in ${durationMs} ms -> ${sink}`);
      Sentry.logger.info(Sentry.logger.fmt`${scraperName}: ${itemCount} items in ${durationMs} ms`, {
        scraper: scraperName,
        items: itemCount,
        ms: durationMs,
        sink,
      });
    },

    paused(reason, issue) {
      console.warn(`${prefix} paused${issue ? ` for ${issue}` : ''}: ${reason}`);
      Sentry.logger.warn(Sentry.logger.fmt`${scraperName}: paused: ${reason}`, { scraper: scraperName, issue: issue ?? '' });
    },

    resumed() {
      console.log(`${prefix} resumed`);
      Sentry.logger.info(Sentry.logger.fmt`${scraperName}: resumed`, { scraper: scraperName });
    },
  };
}
