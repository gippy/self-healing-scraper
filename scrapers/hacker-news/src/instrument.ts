import * as Sentry from '@sentry/node';

// Loaded with `node --import` so Sentry starts before the app. Without SENTRY_DSN, Sentry stays off.
// All scrapers share one Sentry project; the `scraper` tag (and `source`, the same value) tells them apart.
if (process.env.SENTRY_DSN) {
  const scraper = process.env.SCRAPER_NAME?.trim() || undefined;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE || undefined,
    environment: process.env.SENTRY_ENVIRONMENT || undefined,
    // Sentry 11 sends `Sentry.logger` logs without an opt-in (the old `enableLogs` option is gone).
    ...(scraper ? { initialScope: { tags: { scraper, source: scraper } } } : {}),
  });
}
