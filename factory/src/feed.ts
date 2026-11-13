import { z } from 'zod';

import { getScraper, listScrapers, type Scraper } from './registry.ts';

// The scrapers' circuit breaker and status. A scraper is found by name in the registry (src/registry.ts);
// triage pauses it with `POST {url}/pause` `{ reason, issue }`, the factory resumes it with `POST {url}/resume`,
// both with `x-admin-secret: $SCRAPER_ADMIN_SECRET`. Under FAKE_EXTERNALS=1 nothing goes over the network and
// an unregistered scraper gets a stand-in entry, so local replays run end to end.

export type BreakerResult = { ok: boolean; error?: string; url?: string };

export type ScraperStatus = {
    name: string;
    url: string;
    targetUrl?: string;
    // Reachable at all (GET {url}/items answered).
    up: boolean;
    // From the scraper itself when it says so, otherwise undefined.
    paused?: boolean;
    items?: number;
    error?: string;
};

const fake = () => process.env.FAKE_EXTERNALS === '1';

function fakeScraper(name: string): Scraper {
    return {
        name,
        url: `https://${name}.scraper.example`,
        dir: `scrapers/${name}`,
        targetUrl: 'https://auction-house.example/',
        createdAt: new Date(0).toISOString(),
    };
}

export async function findScraper(name: string): Promise<Scraper | undefined> {
    const scraper = await getScraper(name).catch(() => undefined);
    return scraper ?? (fake() ? fakeScraper(name) : undefined);
}

async function call(name: string, action: 'pause' | 'resume', body: unknown): Promise<BreakerResult> {
    const scraper = await findScraper(name);
    if (!scraper) return { ok: false, error: `scraper "${name}" is not in the registry` };
    if (fake()) {
        console.log(`[scraper:fake] ${action} ${name} (${scraper.url})`);
        return { ok: true, url: scraper.url };
    }
    const secret = process.env.SCRAPER_ADMIN_SECRET;
    if (!secret) return { ok: false, error: 'SCRAPER_ADMIN_SECRET is not set', url: scraper.url };
    try {
        const response = await fetch(new URL(action, scraper.url.endsWith('/') ? scraper.url : `${scraper.url}/`), {
            method: 'POST',
            headers: { 'x-admin-secret': secret, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return { ok: false, error: `the scraper answered HTTP ${response.status}`, url: scraper.url };
        return { ok: true, url: scraper.url };
    } catch (error) {
        return { ok: false, error: (error as Error).message, url: scraper.url };
    }
}

export function pauseScraper(name: string, reason: string, issue: string): Promise<BreakerResult> {
    return call(name, 'pause', { reason, issue });
}

export function resumeScraper(name: string): Promise<BreakerResult> {
    return call(name, 'resume', {});
}

// `GET {url}/items`: an array of items, or an object that may carry `items` and `paused`.
const itemsSchema = z.union([
    z.array(z.unknown()),
    z.looseObject({ items: z.array(z.unknown()).optional(), paused: z.boolean().optional() }),
]);

async function checkScraper(scraper: Scraper): Promise<ScraperStatus> {
    const base: ScraperStatus = { name: scraper.name, url: scraper.url, targetUrl: scraper.targetUrl, up: false };
    if (fake()) return { ...base, up: true };
    try {
        const response = await fetch(new URL('items', scraper.url.endsWith('/') ? scraper.url : `${scraper.url}/`), {
            signal: AbortSignal.timeout(4_000),
        });
        if (!response.ok) return { ...base, error: `HTTP ${response.status}` };
        const parsed = itemsSchema.safeParse(await response.json());
        if (!parsed.success) return { ...base, up: true, error: 'unexpected /items answer' };
        if (Array.isArray(parsed.data)) return { ...base, up: true, items: parsed.data.length };
        return { ...base, up: true, items: parsed.data.items?.length, paused: parsed.data.paused };
    } catch (error) {
        return { ...base, error: (error as Error).name === 'TimeoutError' ? 'no answer in 4 s' : (error as Error).message };
    }
}

let cache: { at: number; statuses: ScraperStatus[] } | undefined;

// Every registered scraper with its status; checked at most every 10 s. Failures are reported, never thrown.
export async function scraperStatuses(maxAgeMs = 10_000): Promise<ScraperStatus[]> {
    if (cache && Date.now() - cache.at < maxAgeMs) return cache.statuses;
    let scrapers: Scraper[];
    try {
        scrapers = await listScrapers();
    } catch (error) {
        return [{ name: 'registry', url: '', up: false, error: `could not read the registry: ${(error as Error).message}` }];
    }
    const statuses = await Promise.all(scrapers.map(checkScraper));
    cache = { at: Date.now(), statuses };
    return statuses;
}
