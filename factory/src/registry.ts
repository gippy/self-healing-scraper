import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// The scrapers the factory created: where each one's code lives and where it runs.
export type Scraper = {
    name: string;
    // The deployed app's public URL (pause, resume, version, items).
    url: string;
    // The DigitalOcean App Platform app id.
    appId?: string;
    // Its folder in the monorepo, e.g. `scrapers/auction-house`.
    dir: string;
    targetUrl: string;
    createdAt: string;
};

const path = () => resolve(process.env.FACTORY_WORK_DIR || 'work', 'scrapers.json');

async function load(): Promise<Scraper[]> {
    if (!existsSync(path())) return [];
    return JSON.parse(await readFile(path(), 'utf8')) as Scraper[];
}

export async function listScrapers(): Promise<Scraper[]> {
    return load();
}

export async function getScraper(name: string): Promise<Scraper | undefined> {
    return (await load()).find((scraper) => scraper.name === name);
}

export async function saveScraper(scraper: Scraper): Promise<void> {
    const scrapers = (await load()).filter((existing) => existing.name !== scraper.name);
    await mkdir(dirname(path()), { recursive: true });
    await writeFile(path(), `${JSON.stringify([...scrapers, scraper], null, 2)}\n`);
}
