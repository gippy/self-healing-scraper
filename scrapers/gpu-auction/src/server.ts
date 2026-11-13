import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { renderStatusPage } from './page.ts';
import type { Scraper } from './scraper.ts';

// Lenient on purpose: a pause from the monitor must not fail on a missing field.
const pauseRequestSchema = z.object({ reason: z.string().optional(), issue: z.string().optional() });

function isSecretValid(given: string | undefined, expected: string): boolean {
  const givenBytes = Buffer.from(given ?? '');
  const expectedBytes = Buffer.from(expected);
  return givenBytes.length === expectedBytes.length && timingSafeEqual(givenBytes, expectedBytes);
}

export function createServer(options: { scraper: Scraper; release: string | undefined; adminSecret: string | undefined }) {
  const { scraper } = options;
  const app = new Hono();

  // Returns a response when the request may not use the admin routes.
  function getAdminRejection(c: Context): Response | undefined {
    if (!options.adminSecret) {
      return c.text('Admin routes are disabled: ADMIN_SECRET is not set', 503);
    }
    if (!isSecretValid(c.req.header('x-admin-secret'), options.adminSecret)) {
      return c.text('Wrong or missing x-admin-secret', 401);
    }
    return undefined;
  }

  app.get('/', (c) => c.html(renderStatusPage(scraper.getStatus(), scraper.getItems(), options.release)));

  app.get('/status', (c) => c.json(scraper.getStatus()));

  app.get('/items', (c) => c.json(scraper.getItems()));

  app.post('/pause', async (c) => {
    const rejection = getAdminRejection(c);
    if (rejection) {
      return rejection;
    }
    const text = await c.req.text();
    let body: unknown = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.text('Body must be JSON {"reason"?: string, "issue"?: string}', 400);
      }
    }
    const parsed = pauseRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.text('Body must be JSON {"reason"?: string, "issue"?: string}', 400);
    }
    scraper.pause(parsed.data.reason || 'Paused by the factory', parsed.data.issue || undefined);
    return c.json(scraper.getStatus());
  });

  app.post('/resume', (c) => {
    const rejection = getAdminRejection(c);
    if (rejection) {
      return rejection;
    }
    scraper.resume();
    return c.json(scraper.getStatus());
  });

  app.get('/version', (c) => c.json({ release: options.release ?? null }));

  app.get('/health', (c) => c.text('ok'));

  return app;
}
