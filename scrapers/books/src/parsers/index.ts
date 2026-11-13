import * as cheerio from 'cheerio';
import { ParseError } from './errors.ts';
import type { Item } from './item.ts';

export interface BookItem extends Item {
  price: { amount: number; currency: string };
  status: string;
  url: string;
  rating: number;
  imageUrl: string;
}

const PRODUCT_POD_SELECTOR = 'ol.row > li article.product_pod';
const TITLE_LINK_SELECTOR = 'h3 > a';
const PRICE_SELECTOR = '.product_price .price_color';
const AVAILABILITY_SELECTOR = '.product_price .availability';
const RATING_SELECTOR = 'p.star-rating';
const IMAGE_SELECTOR = '.image_container img';

const HREF_ATTR = 'href';
const TITLE_ATTR = 'title';
const CLASS_ATTR = 'class';
const SRC_ATTR = 'src';

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  '£': 'GBP',
  $: 'USD',
  '€': 'EUR',
};

const RATING_BY_WORD: Record<string, number> = {
  One: 1,
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
};

type Layout = {
  selector: string;
  readListings: ($: cheerio.CheerioAPI, baseUrl: string) => BookItem[];
};

function parseBookId(href: string, index: number): string {
  const match = /_(\d+)\/index\.html$/.exec(href);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable book id in href "${href}" on listing #${index + 1}`);
  }
  return match[1];
}

function resolveUrl(rawUrl: string | undefined, baseUrl: string, field: string, id: string): string {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    throw new ParseError(`Missing ${field} on book ${id}`);
  }
  if (!URL.canParse(trimmed, baseUrl)) {
    throw new ParseError(`Unreadable ${field} "${trimmed}" on book ${id}`);
  }
  return new URL(trimmed, baseUrl).href;
}

function parsePrice(text: string, id: string): { amount: number; currency: string } {
  const match = /^([£$€])(\d+\.\d{2})$/.exec(text);
  const symbol = match?.[1];
  const digits = match?.[2];
  const currency = symbol ? CURRENCY_BY_SYMBOL[symbol] : undefined;
  if (!currency || !digits) {
    throw new ParseError(`Unreadable price "${text}" on book ${id}`);
  }
  return { amount: Number(digits), currency };
}

// Star count is stored as a word class on p.star-rating (e.g. "star-rating Three").
function parseRating(classAttr: string | undefined, id: string): number {
  const words = (classAttr ?? '').split(/\s+/).filter((word) => word !== '' && word !== 'star-rating');
  const word = words.length === 1 ? words[0] : undefined;
  const rating = word ? RATING_BY_WORD[word] : undefined;
  if (rating === undefined) {
    throw new ParseError(`Unreadable rating "${classAttr ?? ''}" on book ${id}`);
  }
  return rating;
}

function readProductPods($: cheerio.CheerioAPI, baseUrl: string): BookItem[] {
  return $(PRODUCT_POD_SELECTOR)
    .toArray()
    .map((element, index) => {
      const pod = $(element);
      const titleLink = pod.find(TITLE_LINK_SELECTOR).first();
      const href = titleLink.attr(HREF_ATTR)?.trim();
      if (!href) {
        throw new ParseError(`Missing product href on listing #${index + 1}`);
      }

      const id = parseBookId(href, index);
      // Link text is truncated with "..."; the full title is in the title attribute.
      const title = titleLink.attr(TITLE_ATTR)?.trim();
      if (!title) {
        throw new ParseError(`Missing title on book ${id}`);
      }

      const status = pod.find(AVAILABILITY_SELECTOR).first().text().trim();
      if (!status) {
        throw new ParseError(`Missing availability status on book ${id}`);
      }

      return {
        id,
        title,
        price: parsePrice(pod.find(PRICE_SELECTOR).first().text().trim(), id),
        status,
        rating: parseRating(pod.find(RATING_SELECTOR).first().attr(CLASS_ATTR), id),
        url: resolveUrl(href, baseUrl, 'product url', id),
        imageUrl: resolveUrl(pod.find(IMAGE_SELECTOR).first().attr(SRC_ATTR), baseUrl, 'image src', id),
      };
    });
}

const LAYOUTS: Layout[] = [
  { selector: PRODUCT_POD_SELECTOR, readListings: readProductPods },
];

export function parse(raw: string, url: string): BookItem[] {
  const $ = cheerio.load(raw);
  const layout = LAYOUTS.find((candidate) => $(candidate.selector).length > 0);
  if (!layout) {
    const pageTitle = $('title').first().text().trim();
    throw new ParseError(`No book listings found on page "${pageTitle}"`);
  }
  return layout.readListings($, url);
}
