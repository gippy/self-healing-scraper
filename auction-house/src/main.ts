import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { createApp } from './app.ts';
import { TEST_SECRET_KEY, TEST_SITE_KEY, verifyRecaptchaToken } from './captcha.ts';
import { startAuction } from './live.ts';
import { createMemoryStore, createPostgresStore } from './store.ts';

const port = Number(process.env.PORT ?? 8080);
const adminSecret = process.env.ADMIN_SECRET || undefined;
if (!adminSecret) {
  console.warn('ADMIN_SECRET is not set: POST /admin/layout will refuse every request');
}

const recaptchaSiteKey = process.env.RECAPTCHA_SITE_KEY || undefined;
const recaptchaSecretKey = process.env.RECAPTCHA_SECRET_KEY || undefined;
if (Boolean(recaptchaSiteKey) !== Boolean(recaptchaSecretKey)) {
  throw new Error('Set both RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY, or neither to use Google test keys');
}
if (!recaptchaSiteKey) {
  console.warn("reCAPTCHA keys are not set: the captcha layout uses Google's test keys, which always pass");
}
const secretKey = recaptchaSecretKey ?? TEST_SECRET_KEY;

let cookieSecret = process.env.COOKIE_SECRET || undefined;
if (!cookieSecret) {
  console.warn('COOKIE_SECRET is not set: using a random one, so shop_pass cookies end with this process');
  cookieSecret = randomBytes(32).toString('hex');
}

const databaseUrl = process.env.TIGER_DATABASE_URL || undefined;
if (!databaseUrl) {
  console.warn('TIGER_DATABASE_URL is not set: the auction lives in memory and restarts fresh');
}
const auction = await startAuction({ store: databaseUrl ? await createPostgresStore(databaseUrl) : createMemoryStore() });

const app = createApp({
  adminSecret,
  captcha: {
    siteKey: recaptchaSiteKey ?? TEST_SITE_KEY,
    cookieSecret,
    verifyToken: (token) => verifyRecaptchaToken(secretKey, token),
  },
  getSnapshot: () => auction.getSnapshot(),
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`auction house listening on http://localhost:${info.port}`);
}) as Server;

// GET /ws: every auction change goes to every connected browser as JSON.
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client, request));
});
auction.subscribe((change) => {
  const message = JSON.stringify(change);
  for (const client of sockets.clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
});
auction.startTicking();
