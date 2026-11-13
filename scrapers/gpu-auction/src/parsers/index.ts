import * as cheerio from 'cheerio';
import { ParseError } from './errors.ts';
import type { Item } from './item.ts';

const LOT_SELECTOR = 'li.lot';
const TITLE_SELECTOR = '.lot-title';
const PRICE_SELECTOR = '.lot-bid';
const BIDS_SELECTOR = '.lot-bids';
const ENDS_SELECTOR = 'time.lot-ends';
const TILE_SELECTOR = 'article.tile';
const TILE_TITLE_SELECTOR = '.tile__title';
const TILE_BIDS_SELECTOR = '.tile__bids';
const ID_ATTRIBUTE = 'data-lot';
const CATEGORY_ATTRIBUTE = 'data-category';
const DATETIME_ATTRIBUTE = 'datetime';
const BID_ATTRIBUTE = 'data-bid';
const CURRENCY_ATTRIBUTE = 'data-currency';
const ENDS_ATTRIBUTE = 'data-ends';

type Listing = ReturnType<cheerio.CheerioAPI>;
type ReadListing = ($listing: Listing, url: string) => Item;

const LAYOUTS: { selector: string; read: ReadListing }[] = [
  { selector: LOT_SELECTOR, read: readLot },
  { selector: TILE_SELECTOR, read: readTile },
];

/**
 * Reads the open auction lots from one fetched page. `raw` is the page exactly as fetched,
 * `url` is the page's URL. Throws `ParseError` when the page has no lots or a lot is missing a field.
 */
export function parse(raw: string, url: string): Item[] {
  const $ = cheerio.load(raw);
  const layout = LAYOUTS.find(({ selector }) => $(selector).length > 0);
  if (!layout) {
    throw new ParseError(`No auction lots found on ${url}`);
  }
  return $(layout.selector).toArray().map((element) => layout.read($(element), url));
}

/** Reads one `li.lot` row. */
function readLot($lot: Listing, url: string): Item {
  const id = $lot.attr(ID_ATTRIBUTE);
  if (!id) {
    throw new ParseError(`A lot on ${url} is missing its ${ID_ATTRIBUTE} id`);
  }
  // Discounted lots show the current price in <ins>, the old one struck out in <del>.
  const bid = $lot.find(PRICE_SELECTOR);
  return {
    id,
    title: required($lot.find(TITLE_SELECTOR).text(), 'title', id),
    category: required($lot.attr(CATEGORY_ATTRIBUTE), 'category', id),
    price: parsePrice((bid.find('ins').text() || bid.text()).trim(), id),
    bids: parseBids($lot.find(BIDS_SELECTOR).text().trim(), id),
    status: readStatus($lot.hasClass('is-sold'), $lot.hasClass('ending')),
    endsAt: parseEndTime($lot.find(ENDS_SELECTOR).attr(DATETIME_ATTRIBUTE), id),
  };
}

/** Reads one `article.tile` card: the price lives in data-bid, the end time in data-ends. */
function readTile($tile: Listing, url: string): Item {
  const id = $tile.attr(ID_ATTRIBUTE);
  if (!id) {
    throw new ParseError(`A lot on ${url} is missing its ${ID_ATTRIBUTE} id`);
  }
  return {
    id,
    title: required($tile.find(TILE_TITLE_SELECTOR).text(), 'title', id),
    category: required($tile.attr(CATEGORY_ATTRIBUTE), 'category', id),
    price: parseTilePrice($tile.attr(BID_ATTRIBUTE), $tile.attr(CURRENCY_ATTRIBUTE), id),
    bids: parseBids($tile.find(TILE_BIDS_SELECTOR).text().trim(), id),
    status: readStatus($tile.hasClass('is-sold'), $tile.hasClass('ending')),
    endsAt: parseEndTime($tile.attr(ENDS_ATTRIBUTE), id),
  };
}

/** Trims a text/attribute value and throws with a message naming the field when it is empty. */
function required(value: string | undefined, field: string, id: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    throw new ParseError(`Missing ${field} on lot ${id}`);
  }
  return trimmed;
}

function parsePrice(text: string, id: string): Item['price'] {
  const match = /^\$(\d+(?:\.\d{1,2})?)$/.exec(required(text, 'price', id));
  if (!match) {
    throw new ParseError(`Unreadable price "${text}" on lot ${id}`);
  }
  return { amount: Number(match[1]), currency: 'USD' };
}

function parseTilePrice(amount: string | undefined, currency: string | undefined, id: string): Item['price'] {
  const value = Number(required(amount, 'price', id));
  if (!Number.isFinite(value)) {
    throw new ParseError(`Unreadable price "${amount}" on lot ${id}`);
  }
  return { amount: value, currency: required(currency, 'currency', id) };
}

function parseBids(text: string, id: string): number {
  const match = /^(\d+) bids?$/.exec(required(text, 'bid count', id));
  if (!match) {
    throw new ParseError(`Unreadable bid count "${text}" on lot ${id}`);
  }
  return Number(match[1]);
}

function readStatus(sold: boolean, ending: boolean): string {
  if (sold) return 'sold';
  if (ending) return 'ending';
  return 'open';
}

function parseEndTime(datetime: string | undefined, id: string): string {
  const value = datetime ?? '';
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new ParseError(`Unreadable end time "${value}" on lot ${id}`);
  }
  return value;
}
