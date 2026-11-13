import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { toIssueInfo, type IssueInfo } from '../sentry.ts';
import type { Origin } from './pipeline.ts';

// POST /sentry/webhook and POST /issues/:id/run.

export type StartIssue = (issue: IssueInfo | { id: string }, origin: Origin) => boolean;

// Sentry-Hook-Signature: hex HMAC-SHA256 of the raw body, keyed with the integration's Client Secret.
export function verifySignature(rawBody: Uint8Array | string, signature: string | undefined, secret: string): boolean {
    if (!signature || !secret || !/^[0-9a-f]{64}$/i.test(signature.trim())) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    const given = Buffer.from(signature.trim(), 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

export function sameSecret(given: string | undefined, expected: string | undefined): boolean {
    if (!given || !expected) return false;
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

const webhookSchema = z.object({
    action: z.string(),
    data: z.object({ issue: z.unknown() }).optional(),
});

export function triageRoutes(startIssue: StartIssue): Hono {
    const app = new Hono();

    app.post('/sentry/webhook', async (c) => {
        const secret = process.env.SENTRY_CLIENT_SECRET;
        if (!secret) return c.text('SENTRY_CLIENT_SECRET is not set', 503);
        const raw = new Uint8Array(await c.req.arrayBuffer());
        if (!verifySignature(raw, c.req.header('sentry-hook-signature'), secret)) return c.text('bad signature', 401);

        const resource = c.req.header('sentry-hook-resource');
        if (resource !== 'issue') return c.json({ ignored: `resource ${resource ?? '(none)'}` });

        let payload: z.infer<typeof webhookSchema>;
        let issue: IssueInfo;
        try {
            payload = webhookSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')));
            if (payload.action !== 'created') return c.json({ ignored: `action ${payload.action}` });
            issue = toIssueInfo(payload.data?.issue);
        } catch {
            return c.text('unexpected payload', 400);
        }
        // Answer at once (Sentry wants < 1 s); the pipeline runs in the background.
        const started = startIssue(issue, 'webhook');
        return c.json({ accepted: issue.id, started });
    });

    app.post('/issues/:id/run', (c) => {
        if (!process.env.ADMIN_SECRET) return c.text('ADMIN_SECRET is not set', 503);
        if (!sameSecret(c.req.header('x-admin-secret'), process.env.ADMIN_SECRET)) return c.text('forbidden', 403);
        const id = c.req.param('id');
        if (!/^[\w-]{1,64}$/.test(id)) return c.text('bad issue id', 400);
        const started = startIssue({ id }, 'manual');
        return c.json({ issueId: id, started }, started ? 202 : 409);
    });

    return app;
}
