import * as cheerio from 'cheerio';
import { ParseError } from './errors.ts';
import type { Item } from './item.ts';

export type Story = Item & {
  rank: number;
  site?: string;
  points?: number;
  author?: string;
  age: string;
  postedAt: string;
  comments?: number;
};

type Selection = ReturnType<cheerio.CheerioAPI>;

const STORY_SELECTOR = 'tr.athing';
const RANK_SELECTOR = 'span.rank';
const TITLE_LINK_SELECTOR = '.titleline > a';
const SITE_SELECTOR = '.titleline .sitestr';
const SUBTEXT_SELECTOR = 'td.subtext';
const SCORE_SELECTOR = 'span.score';
const AUTHOR_SELECTOR = 'a[href^="user?id="]';
const AGE_SELECTOR = 'span.age';
const ITEM_LINK_SELECTOR = 'a[href^="item?id="]';

function parseRank(text: string, id: string): number {
  const match = /^(\d+)\.$/.exec(text);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable rank "${text}" on story ${id}`);
  }
  return Number(match[1]);
}

function parseStoryUrl(href: string | undefined, baseUrl: string, id: string): string {
  const trimmed = href?.trim();
  if (!trimmed || !URL.canParse(trimmed, baseUrl)) {
    throw new ParseError(`Unreadable url "${href ?? ''}" on story ${id}`);
  }
  return new URL(trimmed, baseUrl).href;
}

function parsePoints(text: string, id: string): number {
  const match = /^(\d+) points?$/.exec(text);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable points "${text}" on story ${id}`);
  }
  return Number(match[1]);
}

function parseComments(text: string, id: string): number {
  if (text === 'discuss') {
    return 0;
  }
  const match = /^(\d+)\s+comments?$/.exec(text);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable comments "${text}" on story ${id}`);
  }
  return Number(match[1]);
}

function parsePostedAt(rawTitle: string | undefined, id: string): string {
  const token = rawTitle?.trim().split(/\s+/)[0];
  if (!token || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(token)) {
    throw new ParseError(`Unreadable postedAt "${rawTitle ?? ''}" on story ${id}`);
  }
  // HN writes UTC timestamps in span.age[title] without a Z suffix.
  const isoInput = /[Z+-]/.test(token.slice(19)) ? token : `${token}Z`;
  if (Number.isNaN(Date.parse(isoInput))) {
    throw new ParseError(`Unreadable postedAt "${rawTitle ?? ''}" on story ${id}`);
  }
  return new Date(isoInput).toISOString();
}

function readAge(subtext: Selection, id: string): Pick<Story, 'age' | 'postedAt'> {
  const ageElement = subtext.find(AGE_SELECTOR).first();
  const age = ageElement.text().trim();
  if (!age) {
    throw new ParseError(`Missing age on story ${id}`);
  }
  return {
    age,
    postedAt: parsePostedAt(ageElement.attr('title'), id),
  };
}

function readScoredSubtext(
  subtext: Selection,
  id: string,
): Pick<Story, 'points' | 'author' | 'age' | 'postedAt' | 'comments'> {
  const author = subtext.find(AUTHOR_SELECTOR).first().text().trim();
  if (!author) {
    throw new ParseError(`Missing author on story ${id}`);
  }
  const commentsText = subtext.find(ITEM_LINK_SELECTOR).not(`${AGE_SELECTOR} a`).last().text().trim();
  return {
    points: parsePoints(subtext.find(SCORE_SELECTOR).first().text().trim(), id),
    author,
    ...readAge(subtext, id),
    comments: parseComments(commentsText, id),
  };
}

export function parse(raw: string, url: string): Story[] {
  const $ = cheerio.load(raw);
  const rows = $(STORY_SELECTOR).toArray();
  if (rows.length === 0) {
    const pageTitle = $('title').first().text().trim();
    throw new ParseError(`No stories found: nothing matches "${STORY_SELECTOR}" (page title "${pageTitle}")`);
  }

  return rows.map((element, index) => {
    const row = $(element);
    const id = row.attr('id')?.trim();
    if (!id) {
      throw new ParseError(`Story #${index + 1} has no id`);
    }
    const titleLink = row.find(TITLE_LINK_SELECTOR).first();
    const title = titleLink.text().trim();
    if (!title) {
      throw new ParseError(`Missing title on story ${id}`);
    }
    const site = row.find(SITE_SELECTOR).first().text().trim();
    const subtext = row.next('tr').find(SUBTEXT_SELECTOR).first();
    if (subtext.length === 0) {
      throw new ParseError(`Missing subtext on story ${id}`);
    }
    const hasScore = subtext.find(SCORE_SELECTOR).length > 0;
    const subtextFields = hasScore ? readScoredSubtext(subtext, id) : readAge(subtext, id);

    return {
      id,
      rank: parseRank(row.find(RANK_SELECTOR).first().text().trim(), id),
      title,
      url: parseStoryUrl(titleLink.attr('href'), url, id),
      ...(site ? { site } : {}),
      ...subtextFields,
    };
  });
}
