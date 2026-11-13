import { readdirSync, readFileSync } from 'node:fs';

const FIXTURES_DIR = new URL('../fixtures/', import.meta.url);

/** Reads `tests/fixtures/<name>` as UTF-8, the way the scraper gets a page: `loadFixture('category-v1.html')`. */
export function loadFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES_DIR), 'utf8');
}

/** The names of all fixtures, for tests that run every saved page through the parser. */
export function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR).filter((name) => !name.startsWith('.'));
}
