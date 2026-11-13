import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';

import { triageRoutes, verifySignature, type StartIssue } from '../../src/triage/http.ts';

const SECRET = 'test-client-secret';
const BODY = readFileSync(new URL('../fixtures/sentry-issue-created.json', import.meta.url), 'utf8');
const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');

test('accepts the hex HMAC-SHA256 of the raw body', () => {
    assert.equal(verifySignature(BODY, sign(BODY), SECRET), true);
    assert.equal(verifySignature(Buffer.from(BODY), sign(BODY).toUpperCase(), SECRET), true);
});

test('rejects a wrong secret, a changed body and malformed signatures', () => {
    assert.equal(verifySignature(BODY, sign(BODY, 'other-secret'), SECRET), false);
    assert.equal(verifySignature(`${BODY} `, sign(BODY), SECRET), false);
    // Re-serialized JSON is not the raw body.
    assert.equal(verifySignature(JSON.stringify(JSON.parse(BODY)), sign(BODY), SECRET), false);
    assert.equal(verifySignature(BODY, undefined, SECRET), false);
    assert.equal(verifySignature(BODY, '', SECRET), false);
    assert.equal(verifySignature(BODY, sign(BODY).slice(0, 63), SECRET), false);
    assert.equal(verifySignature(BODY, 'z'.repeat(64), SECRET), false);
    assert.equal(verifySignature(BODY, sign(BODY), ''), false);
});

let started: Array<{ issue: unknown; origin: string }>;
const startIssue: StartIssue = (issue, origin) => {
    started.push({ issue, origin });
    return true;
};

beforeEach(() => {
    started = [];
    process.env.SENTRY_CLIENT_SECRET = SECRET;
    process.env.ADMIN_SECRET = 'test-admin';
});

const post = (body: string, headers: Record<string, string>) =>
    triageRoutes(startIssue).request('/sentry/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });

test('a signed issue.created starts the pipeline with the issue from the payload', async () => {
    const response = await post(BODY, { 'Sentry-Hook-Resource': 'issue', 'Sentry-Hook-Signature': sign(BODY) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: '4517290001', started: true });
    assert.equal(started.length, 1);
    assert.equal(started[0]!.origin, 'webhook');
    assert.deepEqual(started[0]!.issue, {
        id: '4517290001',
        shortId: 'SELFHEAL-FEED-1',
        title: 'ParseError: no .lot elements found',
        permalink: 'https://selfheal.sentry.io/issues/4517290001/',
        projectSlug: 'scrapers',
        level: 'error',
        culprit: 'parse(src/parsers/index)',
        count: '1',
        userCount: 0,
        firstSeen: '2026-11-13T19:02:11.000000+00:00',
    });
});

test('a bad signature is 401 and starts nothing', async () => {
    const response = await post(BODY, { 'Sentry-Hook-Resource': 'issue', 'Sentry-Hook-Signature': sign(BODY, 'wrong') });
    assert.equal(response.status, 401);
    assert.equal(started.length, 0);
});

test('other resources and actions are acknowledged and ignored', async () => {
    const other = await post(BODY, { 'Sentry-Hook-Resource': 'event_alert', 'Sentry-Hook-Signature': sign(BODY) });
    assert.equal(other.status, 200);
    const resolved = BODY.replace('"action": "created"', '"action": "resolved"');
    const action = await post(resolved, { 'Sentry-Hook-Resource': 'issue', 'Sentry-Hook-Signature': sign(resolved) });
    assert.equal(action.status, 200);
    assert.deepEqual(await action.json(), { ignored: 'action resolved' });
    assert.equal(started.length, 0);
});

test('a signed but malformed payload is 400', async () => {
    const body = '{"action":"created","data":{"issue":{"id":1}}}';
    const response = await post(body, { 'Sentry-Hook-Resource': 'issue', 'Sentry-Hook-Signature': sign(body) });
    assert.equal(response.status, 400);
    assert.equal(started.length, 0);
});

test('without a client secret the webhook refuses everything', async () => {
    delete process.env.SENTRY_CLIENT_SECRET;
    const response = await post(BODY, { 'Sentry-Hook-Resource': 'issue', 'Sentry-Hook-Signature': sign(BODY, '') });
    assert.equal(response.status, 503);
    assert.equal(started.length, 0);
});

test('POST /issues/:id/run needs the admin secret', async () => {
    const app = triageRoutes(startIssue);
    const denied = await app.request('/issues/4517290001/run', { method: 'POST', headers: { 'x-admin-secret': 'nope' } });
    assert.equal(denied.status, 403);
    const missing = await app.request('/issues/4517290001/run', { method: 'POST' });
    assert.equal(missing.status, 403);
    const ok = await app.request('/issues/4517290001/run', { method: 'POST', headers: { 'x-admin-secret': 'test-admin' } });
    assert.equal(ok.status, 202);
    assert.deepEqual(started, [{ issue: { id: '4517290001' }, origin: 'manual' }]);
});
