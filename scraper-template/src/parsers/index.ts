import { ParseError } from './errors.ts';
import type { Item } from './item.ts';

/**
 * Reads the items from one fetched page. `raw` is the page exactly as fetched, `url` is the page's URL.
 *
 * The factory replaces this file with a parser for the target site. Rules:
 * - pure: no network, no clock, no environment, no global state;
 * - throw `ParseError` with a message that names what is missing, never return partial or empty data;
 * - only this file (plus helpers under `src/parsers/`) and the tests change; the runtime stays as it is.
 */
export function parse(raw: string, url: string): Item[] {
  void raw;
  void url;
  throw new ParseError('not implemented');
}
