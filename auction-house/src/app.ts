import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { renderAdmin } from './admin.ts';
import { createPassValue, isPassValid, PASS_COOKIE, PASS_TTL_SECONDS } from './captcha.ts';
import { CATEGORIES, type Category } from './catalog.ts';
import { LAYOUTS, renderCaptchaGate, renderLayout, type Layout } from './layouts.ts';
import { readImage, type ImageUrlGetter } from './images.ts';
import type { AuctionSnapshot } from './live.ts';

const layoutRequestSchema = z.object({ layout: z.enum(LAYOUTS) });

function isSecretValid(given: string | undefined, expected: string): boolean {
  const givenBytes = Buffer.from(given ?? '');
  const expectedBytes = Buffer.from(expected);
  return givenBytes.length === expectedBytes.length && timingSafeEqual(givenBytes, expectedBytes);
}

export type CaptchaOptions = {
  siteKey: string;
  /** Signs the `shop_pass` cookie. */
  cookieSecret: string;
  /** Asks reCAPTCHA whether a token from the gate is valid. */
  verifyToken: (token: string) => Promise<boolean>;
};

/**
 * Creates the auction house server. The layout lives in memory and starts at `v1`.
 * Without `adminSecret`, layout switching is refused.
 */
export function createApp(options: {
  adminSecret: string | undefined;
  captcha: CaptchaOptions;
  getSnapshot: () => AuctionSnapshot;
  getImageUrl: ImageUrlGetter;
}) {
  let layout: Layout = 'v1';
  let flakyRequestCount = 0;
  const app = new Hono();

  function renderLots(c: Context, category?: Category): Response {
    c.header('cache-control', 'no-store');
    if (layout === 'flaky') {
      flakyRequestCount += 1;
      if (flakyRequestCount % 2 === 1) {
        return c.text('Service temporarily unavailable', 503);
      }
    }
    const now = new Date();
    if (layout === 'captcha' && !isPassValid(getCookie(c, PASS_COOKIE), options.captcha.cookieSecret, now)) {
      return c.html(renderCaptchaGate(options.captcha.siteKey));
    }
    const { open, sold } = options.getSnapshot();
    return c.html(renderLayout(layout, { open, sold, now, getImageUrl: options.getImageUrl, ...(category ? { category } : {}) }));
  }

  app.get('/', (c) => renderLots(c));

  app.get('/c/:slug', (c) => {
    const category = CATEGORIES.find((candidate) => candidate.slug === c.req.param('slug'));
    return category ? renderLots(c, category) : c.text('No such category', 404);
  });

  app.get('/images/*', async (c) => {
    const image = await readImage(c.req.path.slice('/images/'.length));
    if (!image) {
      return c.text('Not found', 404);
    }
    c.header('content-type', image.contentType);
    c.header('cache-control', 'public, max-age=86400');
    return c.body(new Uint8Array(image.body));
  });

  app.post('/captcha/verify', async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = body['g-recaptcha-response'];
    if (typeof token !== 'string' || !token || !(await options.captcha.verifyToken(token))) {
      return c.html(renderCaptchaGate(options.captcha.siteKey, 'The check did not pass. Please try again.'), 403);
    }
    setCookie(c, PASS_COOKIE, createPassValue(options.captcha.cookieSecret, new Date()), {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
      maxAge: PASS_TTL_SECONDS,
    });
    return c.redirect('/', 303);
  });

  app.get('/admin', (c) => {
    c.header('cache-control', 'no-store');
    return c.html(renderAdmin(layout));
  });

  app.post('/admin/layout', async (c) => {
    if (!options.adminSecret) {
      return c.text('Layout switching is disabled: ADMIN_SECRET is not set', 503);
    }
    if (!isSecretValid(c.req.header('x-admin-secret'), options.adminSecret)) {
      return c.text('Wrong or missing x-admin-secret', 401);
    }
    const parsed = layoutRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.text(`Body must be {"layout": one of ${LAYOUTS.join(', ')}}`, 400);
    }
    layout = parsed.data.layout;
    flakyRequestCount = 0;
    console.log(`layout switched to ${layout}`);
    return c.json({ layout });
  });

  app.get('/health', (c) => c.text('ok'));

  return app;
}
