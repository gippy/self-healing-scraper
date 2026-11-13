import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { listScrapers } from '../registry.ts';
import type { Emit } from '../types.ts';
import { createScraper, isValidScraperName } from './create.ts';

const createSchema = z.object({
    name: z.string().refine(isValidScraperName, 'a name of 3–24 lowercase letters, digits and dashes'),
    url: z.url(),
    fields: z.string().max(1_000).optional(),
});

function isAdmin(header: string | undefined): boolean {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || !header) return false;
    const given = Buffer.from(header);
    const expected = Buffer.from(secret);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

// `POST /scrapers` starts building a scraper (the factory's create mode); progress goes to the dashboard.
export function factoryRoutes(emit: Emit): Hono {
    const app = new Hono();
    app.get('/scrapers', async (c) => c.json(await listScrapers()));
    app.post('/scrapers', async (c) => {
        if (!isAdmin(c.req.header('x-admin-secret'))) return c.json({ error: 'forbidden' }, 403);
        const parsed = createSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) return c.json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') }, 400);
        void createScraper(parsed.data, emit).catch((error: unknown) => console.error('Create run failed', error));
        return c.json({ started: parsed.data.name }, 202);
    });
    return app;
}
