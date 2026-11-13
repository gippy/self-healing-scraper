import { load } from 'cheerio';
import { ParseError } from './errors.ts';
import type { Item } from './item.ts';

const CURRENCY_CODES: Record<string, string> = {
  $: 'USD',
  US$: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
};
const PRICE_PATTERN = /^(US\$|[$€£¥]|USD|EUR|GBP|JPY)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/;
const BIDS_PATTERN = /^(\d{1,3}(?:,\d{3})+|\d+)\s+bids?$/i;
const COUNTDOWN_PATTERN = /^Ends in \d+(?:h|m|s)(?: \d+(?:m|s))?$/;

function cleanText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function requiredText(value: string | undefined, field: string, id: string): string {
  const text = cleanText(value);
  if (!text) throw new ParseError(`Missing ${field} on ${id}`);
  return text;
}

function parsePrice(value: string, id: string): NonNullable<Item['price']> {
  const match = PRICE_PATTERN.exec(value);
  if (!match) throw new ParseError(`Unreadable price "${value}" on ${id}`);

  const symbolOrCode = match[1];
  const numericAmount = match[2];
  if (symbolOrCode === undefined || numericAmount === undefined) {
    throw new ParseError(`Unreadable price "${value}" on ${id}`);
  }

  const amount = Number(numericAmount.replaceAll(',', ''));
  if (!Number.isFinite(amount)) throw new ParseError(`Unreadable price "${value}" on ${id}`);

  return { amount, currency: CURRENCY_CODES[symbolOrCode] ?? symbolOrCode };
}

function parseBids(value: string, id: string): number {
  const match = BIDS_PATTERN.exec(value);
  if (!match?.[1]) throw new ParseError(`Unreadable bid count "${value}" on ${id}`);

  const bids = Number(match[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(bids)) throw new ParseError(`Unreadable bid count "${value}" on ${id}`);
  return bids;
}

function parseEndTime(value: string, id: string): string {
  // An explicit offset keeps parsing independent of the machine's timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ParseError(`Unreadable end time "${value}" on ${id}`);
  }
  if (Number.isNaN(Date.parse(value))) throw new ParseError(`Unreadable end time "${value}" on ${id}`);
  return value;
}

function parseStatus(value: string, classes: string, id: string): string {
  if (/(?:^|\s)is-sold(?:\s|$)/.test(classes)) return 'sold';
  if (/(?:^|\s)ending(?:\s|$)/.test(classes)) return 'ending';
  if (value === 'Closing') return 'closing';
  if (COUNTDOWN_PATTERN.test(value)) return 'open';
  throw new ParseError(`Unreadable status "${value}" on ${id}`);
}

/** Reads every open-lot card from the auction index (or one of its category pages). */
export function parse(raw: string, url: string): Item[] {
  const $ = load(raw);
  // Select every listing child in either layout, so a broken card cannot disappear silently.
  const listings = $('main .lot-list > li, main.auction-grid > *').toArray();
  if (listings.length === 0) throw new ParseError(`No auction listings found at ${url}`);

  const seenIds = new Set<string>();
  return listings.map((listing) => {
    const lot = $(listing);
    const id = requiredText(lot.attr('data-lot'), 'id', 'auction lot');
    if (seenIds.has(id)) throw new ParseError(`Duplicate listing id "${id}"`);
    seenIds.add(id);

    const isTile = lot.hasClass('tile');
    const titleSelector = isTile ? '.tile__title' : '.lot-title';
    const bidsSelector = isTile ? '.tile__bids' : '.lot-bids';
    const title = requiredText(lot.find(titleSelector).first().text(), 'title', id);
    const category = requiredText(lot.attr('data-category'), 'category', id);
    const price = isTile
      ? parsePrice(
          `${requiredText(lot.attr('data-currency'), 'currency', id)} ${requiredText(lot.attr('data-bid'), 'price', id)}`,
          id,
        )
      : parsePrice(requiredText(lot.find('.lot-bid').first().text(), 'price', id), id);
    const bids = parseBids(requiredText(lot.find(bidsSelector).first().text(), 'bid count', id), id);

    const endElement = lot.find(isTile ? '.tile__ends' : 'time.lot-ends').first();
    const status = parseStatus(requiredText(endElement.text(), 'status', id), lot.attr('class') ?? '', id);
    const endTime = isTile ? lot.attr('data-ends') : endElement.attr('datetime');
    const endsAt = parseEndTime(requiredText(endTime, 'end time', id), id);

    return { id, title, category, price, bids, status, endsAt };
  });
}
