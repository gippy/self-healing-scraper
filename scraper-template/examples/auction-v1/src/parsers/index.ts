import * as cheerio from 'cheerio';
import { ParseError } from './errors.ts';
import type { Item } from './item.ts';

// Example parser (fallback): the auction house's `v1` layout, written by hand before the factory existed.
// Copy this overlay over a scraper folder: `cp -R examples/auction-v1/. scrapers/<name>/`.

const LOT_SELECTOR = 'ul.lot-list > li.lot';

function parseBid(text: string, lot: string): { amount: number; currency: string } {
  const match = /^\$(\d+\.\d{2})$/.exec(text);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable bid "${text}" for ${lot}`);
  }
  return { amount: Number(match[1]), currency: 'USD' };
}

function parseBidCount(text: string, lot: string): number {
  const match = /^(\d+) bids?$/.exec(text);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable bid count "${text}" for ${lot}`);
  }
  return Number(match[1]);
}

function parseEndsAt(datetime: string | undefined, lot: string): string {
  if (!datetime || Number.isNaN(Date.parse(datetime))) {
    throw new ParseError(`Unreadable end time "${datetime ?? ''}" for ${lot}`);
  }
  return new Date(datetime).toISOString();
}

/** Reads the open lots of the demo auction house (`v1`: `ul.lot-list > li.lot`, grouped in `section.category`). */
export function parse(raw: string, url: string): Item[] {
  void url;
  const $ = cheerio.load(raw);
  const lots = $(LOT_SELECTOR).toArray();
  if (lots.length === 0) {
    const title = $('title').first().text().trim();
    throw new ParseError(`No lots found: nothing matches "${LOT_SELECTOR}" (page title "${title}")`);
  }

  return lots.map((element, index) => {
    const lot = $(element);
    const id = lot.attr('data-lot')?.trim();
    if (!id) {
      throw new ParseError(`Lot #${index + 1} has no data-lot`);
    }
    const title = lot.find('.lot-title').text().trim();
    if (!title) {
      throw new ParseError(`Lot ${id} has no title`);
    }
    const category = (lot.attr('data-category') ?? lot.closest('section.category').attr('data-category'))?.trim();
    return {
      id,
      title,
      ...(category ? { category } : {}),
      price: parseBid(lot.find('.lot-bid').text().trim(), id),
      bids: parseBidCount(lot.find('.lot-bids').text().trim(), id),
      status: 'open',
      endsAt: parseEndsAt(lot.find('time.lot-ends').attr('datetime'), id),
    };
  });
}
