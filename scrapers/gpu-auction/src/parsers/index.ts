import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { ParseError } from './errors.ts';
import type { Item } from './item.ts';

const LOT = {
  listing: 'li.lot',
  title: '.lot-title',
  category: 'section.category',
  categoryName: '.category-name',
  price: '.lot-bid',
  currentPrice: 'ins',
  bids: '.lot-bids',
  ends: 'time.lot-ends',
} as const;

const TILE = {
  listing: 'article.tile',
  title: '.tile__title',
  category: '.tile__category',
  bids: '.tile__bids',
  ends: '.tile__ends',
} as const;

const ID_ATTRIBUTE = 'data-lot';
const BID_ATTRIBUTE = 'data-bid';
const CURRENCY_ATTRIBUTE = 'data-currency';
const TILE_ENDS_ATTRIBUTE = 'data-ends';
const LOT_ENDS_ATTRIBUTE = 'datetime';

const LAYOUTS = [
  { selector: LOT.listing, read: readLot },
  { selector: TILE.listing, read: readTile },
];

type Listing = ReturnType<CheerioAPI>;

export function parse(raw: string, _url: string): Item[] {
  const $ = cheerio.load(raw);

  for (const layout of LAYOUTS) {
    const listings = $(layout.selector);
    if (listings.length > 0) {
      return listings.toArray().map((element) => layout.read($(element)));
    }
  }

  throw new ParseError('No auction listings found');
}

function readLot(lot: Listing): Item {
  const id = readId(lot);
  const price = lot.find(LOT.price);
  // A discounted lot keeps the old price in <del> and the current price in <ins>.
  const discountedPrice = price.find(LOT.currentPrice);
  const priceText = (discountedPrice.length > 0 ? discountedPrice : price).text().trim();
  const ends = lot.find(LOT.ends);

  return {
    id,
    title: readText(lot, LOT.title, 'title', id),
    category: readText(lot.closest(LOT.category), LOT.categoryName, 'category', id),
    price: parsePrice(priceText, id),
    bids: parseBids(readText(lot, LOT.bids, 'bids', id), id),
    status: readStatus(lot, ends.text().trim()),
    endsAt: parseEndsAt(readAttribute(ends, LOT_ENDS_ATTRIBUTE, 'end time', id), id),
  };
}

function readTile(tile: Listing): Item {
  const id = readId(tile);
  const amount = readAttribute(tile, BID_ATTRIBUTE, 'price', id);
  const currency = readAttribute(tile, CURRENCY_ATTRIBUTE, 'currency', id);
  const endsAt = readAttribute(tile, TILE_ENDS_ATTRIBUTE, 'end time', id);

  return {
    id,
    title: readText(tile, TILE.title, 'title', id),
    category: readText(tile, TILE.category, 'category', id),
    price: { amount: parseAmount(amount, id), currency: parseCurrency(currency, id) },
    bids: parseBids(readText(tile, TILE.bids, 'bids', id), id),
    status: readStatus(tile, readText(tile, TILE.ends, 'status', id)),
    endsAt: parseEndsAt(endsAt, id),
  };
}

function readId(listing: Listing): string {
  const id = listing.attr(ID_ATTRIBUTE)?.trim();
  if (!id) {
    throw new ParseError('Missing id on auction listing');
  }
  return id;
}

function readText(scope: Listing, selector: string, field: string, id: string): string {
  const value = scope.find(selector).text().trim().replace(/\s+/g, ' ');
  if (!value) {
    throw new ParseError(`Missing ${field} on ${id}`);
  }
  return value;
}

function readAttribute(element: Listing, attribute: string, field: string, id: string): string {
  const value = element.attr(attribute)?.trim();
  if (!value) {
    throw new ParseError(`Missing ${field} on ${id}`);
  }
  return value;
}

function parsePrice(raw: string, id: string): NonNullable<Item['price']> {
  const match = /^\$(\d+(?:\.\d{1,2})?)$/.exec(raw);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable price "${raw}" on ${id}`);
  }
  return { amount: parseAmount(match[1], id), currency: 'USD' };
}

function parseAmount(raw: string, id: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new ParseError(`Unreadable price amount "${raw}" on ${id}`);
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount)) {
    throw new ParseError(`Unreadable price amount "${raw}" on ${id}`);
  }
  return amount;
}

function parseCurrency(raw: string, id: string): string {
  if (!/^[A-Z]{3}$/.test(raw)) {
    throw new ParseError(`Unreadable currency "${raw}" on ${id}`);
  }
  return raw;
}

function parseBids(raw: string, id: string): number {
  const match = /^(\d+) bids?$/.exec(raw);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable bids "${raw}" on ${id}`);
  }
  return Number(match[1]);
}

function readStatus(listing: Listing, endsLabel: string): string {
  if (listing.hasClass('is-sold')) return 'sold';
  if (listing.hasClass('ending') || endsLabel === 'Closing') return 'closing';
  return 'open';
}

function parseEndsAt(raw: string, id: string): string {
  if (Number.isNaN(Date.parse(raw))) {
    throw new ParseError(`Unreadable end time "${raw}" on ${id}`);
  }
  return raw;
}
