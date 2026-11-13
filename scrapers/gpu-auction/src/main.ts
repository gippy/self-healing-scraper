import { serve } from '@hono/node-server';
import * as Sentry from '@sentry/node';
import { createPageFetcher } from './brightdata.ts';
import { getConfig } from './config.ts';
import { parse } from './parsers/index.ts';
import { createSentryReporter } from './reporting.ts';
import { createScraper } from './scraper.ts';
import { createServer } from './server.ts';
import { connectSnowflake, createLogSink, createSnowflakeSink } from './snowflake.ts';

const config = getConfig(process.env);
const snowflake = config.snowflake;

const sink = snowflake
  ? createSnowflakeSink({ scraperName: config.scraperName, connect: () => connectSnowflake(snowflake) })
  : createLogSink(config.scraperName);
const scraper = createScraper({
  name: config.scraperName,
  targetUrl: config.targetUrl,
  fetchPage: createPageFetcher(config.brightData),
  parse,
  sink,
  reporter: createSentryReporter(config.scraperName),
});
const app = createServer({ scraper, release: config.release, adminSecret: config.adminSecret });

if (!config.adminSecret) {
  console.warn('ADMIN_SECRET is not set: POST /pause and POST /resume answer 503');
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `scraper ${config.scraperName} listening on http://localhost:${info.port}: ${config.targetUrl} every ${config.pollMs / 1000} s ` +
      `via ${config.brightData.isFake ? 'direct fetch (FAKE_BRIGHTDATA=1)' : 'Bright Data Web Unlocker'} -> ${sink.name}`,
  );
  scraper.start(config.pollMs);
});

// App Platform sends SIGTERM on redeploy: stop polling, send what Sentry has, close Snowflake.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    scraper.stop();
    server.close();
    void Promise.allSettled([Sentry.flush(2000), sink.close()]).then(() => process.exit(0));
  });
}
