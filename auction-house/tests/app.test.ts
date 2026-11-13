import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp, type CaptchaOptions } from '../src/app.ts';
import { createPassValue, isPassValid, PASS_TTL_SECONDS } from '../src/captcha.ts';
import { createSeedState } from '../src/simulation.ts';

const SECRET = 'test-secret';
const COOKIE_SECRET = 'test-cookie-secret';
const PASSING_TOKEN = 'passing-token';

// Accepts only PASSING_TOKEN, like reCAPTCHA's siteverify would for a solved challenge.
// A seeded auction floor; a fixed sequence of "random" numbers keeps it the same in every run.
function createTestApp(adminSecret: string | undefined = SECRET) {
  let seed = 0;
  const { state } = createSeedState(new Date('2026-11-13T20:00:00Z'), () => (seed = (seed * 9301 + 49297) % 233280) / 233280);
  return createApp({
    adminSecret,
    captcha: createCaptchaOptions(),
    getSnapshot: () => ({ open: [...state.open.values()], sold: [] }),
    getImageUrl: (title) => `/images/${title.length}.jpg`,
  });
}

function createCaptchaOptions(): CaptchaOptions {
  return { siteKey: 'test-site-key', cookieSecret: COOKIE_SECRET, verifyToken: async (token) => token === PASSING_TOKEN };
}

// Pass `null` to send no secret header at all.
function switchLayout(app: ReturnType<typeof createTestApp>, layout: string, secret: string | null = SECRET) {
  return app.request('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-admin-secret': secret }) },
    body: JSON.stringify({ layout }),
  });
}

describe('layout switch', () => {
  it('serves the v1 lot list until the layout is switched', async () => {
    const app = createTestApp();
    const v1 = await (await app.request('/')).text();
    assert.match(v1, /<section class="category" data-category="hand-tools">\s*<div class="category-head">\s*<h2 class="category-name">/);
    assert.match(v1, /<li class="lot" data-lot="LOT-\d{4}" data-category="hand-tools">\s*<img class="lot-image" src="\/images\/\d+\.jpg" alt="[^"]+" loading="lazy"/);

    assert.equal((await switchLayout(app, 'v2-redesign')).status, 200);
    const html = await (await app.request('/')).text();
    assert.doesNotMatch(html, /class="lot"/);
    assert.match(html, /<article class="tile" data-lot="LOT-\d{4}" data-category="[a-z-]+" data-bid="\d+\.\d{2}" data-currency="USD" data-ends="[^"]+Z">/);
  });

  it('refuses a wrong or missing secret and keeps the layout', async () => {
    const app = createTestApp();
    assert.equal((await switchLayout(app, 'v4-login', 'nope')).status, 401);
    assert.equal((await switchLayout(app, 'v4-login', null)).status, 401);
    assert.match(await (await app.request('/')).text(), /class="lot-list"/);
  });

  it('refuses every switch when no secret is configured', async () => {
    const app = createTestApp('');
    assert.equal((await switchLayout(app, 'v4-login', '')).status, 503);
  });

  it('rejects an unknown layout name', async () => {
    const app = createTestApp();
    assert.equal((await switchLayout(app, 'v9-unknown')).status, 400);
  });
});

describe('flaky layout', () => {
  it('answers 503 on every other request, starting with the first after the switch', async () => {
    const app = createTestApp();
    await switchLayout(app, 'flaky');
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await app.request('/')).status);
    }
    assert.deepEqual(statuses, [503, 200, 503, 200]);
  });
});

describe('captcha layout', () => {
  function submitToken(app: ReturnType<typeof createTestApp>, token: string) {
    return app.request('/captcha/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'g-recaptcha-response': token }).toString(),
    });
  }

  it('serves the gate instead of the lots until the visitor passes it', async () => {
    const app = createTestApp();
    await switchLayout(app, 'captcha');

    const gate = await app.request('/');
    assert.equal(gate.status, 200);
    const html = await gate.text();
    assert.match(html, /<form class="captcha-gate" method="post" action="\/captcha\/verify">/);
    assert.match(html, /data-sitekey="test-site-key"/);
    assert.doesNotMatch(html, /class="lot-list"/);

    const verified = await submitToken(app, PASSING_TOKEN);
    assert.equal(verified.status, 303);
    const cookie = verified.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.match(cookie, /^shop_pass=/);
    assert.match(await (await app.request('/', { headers: { cookie } })).text(), /class="lot-list"/);
  });

  it('refuses a token reCAPTCHA rejects and sets no cookie', async () => {
    const app = createTestApp();
    const response = await submitToken(app, 'bad-token');

    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  });

  it('accepts a pass only with a valid signature before it expires', () => {
    const now = new Date('2026-11-13T19:00:00Z');
    const pass = createPassValue(COOKIE_SECRET, now);

    assert.equal(isPassValid(pass, COOKIE_SECRET, now), true);
    assert.equal(isPassValid(pass, 'another-secret', now), false);
    assert.equal(isPassValid(pass, COOKIE_SECRET, new Date(now.getTime() + PASS_TTL_SECONDS * 1000)), false);
    assert.equal(isPassValid(undefined, COOKIE_SECRET, now), false);
  });
});
