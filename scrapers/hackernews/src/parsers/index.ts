import * as cheerio from 'cheerio';
import { ParseError } from './errors.ts';
import type { Item } from './item.ts';

export type ArticleItem = Item & {
  rank: number;
  url: string;
  site?: string;
  points?: number;
  author?: string;
  commentsCount?: number;
  publishedAt: string;
};

const SUBMISSION_SELECTOR = 'tr.athing.submission';
const RANK_SELECTOR = 'span.rank';
const TITLE_LINK_SELECTOR = 'span.titleline > a';
const SITE_SELECTOR = 'span.sitestr';
const SUBTEXT_SELECTOR = 'td.subtext';
const SUBLINE_SELECTOR = 'span.subline';
const SCORE_SELECTOR = 'span.score';
const AUTHOR_SELECTOR = 'a[href^="user?id="]';
const AGE_SELECTOR = 'span.age';
const COMMENTS_LINK_SELECTOR = 'a[href^="item?id="]';

function parseRank(text: string, id: string): number {
  const match = /^(\d+)\.$/.exec(text);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable rank "${text}" on ${id}`);
  }
  return Number(match[1]);
}

function parseArticleUrl(href: string | undefined, baseUrl: string, id: string): string {
  if (!href || !URL.canParse(href, baseUrl)) {
    throw new ParseError(`Unreadable url "${href ?? ''}" on ${id}`);
  }
  return new URL(href, baseUrl).href;
}

function parsePublishedAt(ageTitle: string | undefined, id: string): string {
  /* HN age title stores a UTC timestamp without a trailing Z. */
  if (!ageTitle || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(ageTitle)) {
    throw new ParseError(`Unreadable timestamp "${ageTitle ?? ''}" on ${id}`);
  }
  const timestamp = Date.parse(`${ageTitle}Z`);
  if (Number.isNaN(timestamp)) {
    throw new ParseError(`Unreadable timestamp "${ageTitle}" on ${id}`);
  }
  return new Date(timestamp).toISOString();
}

function parsePoints(text: string, id: string): number {
  const match = /^(\d+) points?$/.exec(text);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable points "${text}" on ${id}`);
  }
  return Number(match[1]);
}

function parseCommentsCount(text: string, id: string): number {
  if (text === 'discuss') {
    return 0;
  }
  const match = /^(\d+)\s+comments?$/.exec(text);
  if (!match?.[1]) {
    throw new ParseError(`Unreadable comment count "${text}" on ${id}`);
  }
  return Number(match[1]);
}

export function parse(raw: string, url: string): ArticleItem[] {
  const $ = cheerio.load(raw);
  const submissions = $(SUBMISSION_SELECTOR).toArray();
  if (submissions.length === 0) {
    const pageTitle = $('title').first().text().trim();
    throw new ParseError(`No submissions found: nothing matches "${SUBMISSION_SELECTOR}" (page title "${pageTitle}")`);
  }

  return submissions.map((element, index) => {
    const row = $(element);
    const id = row.attr('id')?.trim();
    if (!id) {
      throw new ParseError(`Submission #${index + 1} has no id`);
    }

    const rank = parseRank(row.find(RANK_SELECTOR).first().text().trim(), id);
    const titleLink = row.find(TITLE_LINK_SELECTOR).first();
    const title = titleLink.text().trim();
    if (!title) {
      throw new ParseError(`Submission ${id} has no title`);
    }

    const articleUrl = parseArticleUrl(titleLink.attr('href')?.trim(), url, id);
    const site = row.find(SITE_SELECTOR).first().text().trim();

    const subtext = row.next('tr').find(SUBTEXT_SELECTOR).first();
    if (subtext.length === 0) {
      throw new ParseError(`Submission ${id} has no subtext row`);
    }

    const publishedAt = parsePublishedAt(subtext.find(AGE_SELECTOR).first().attr('title')?.trim(), id);
    const subline = subtext.find(SUBLINE_SELECTOR).first();

    /* YC job posts only carry an age in td.subtext without a span.subline. */
    if (subline.length === 0) {
      return {
        id,
        rank,
        title,
        url: articleUrl,
        ...(site ? { site } : {}),
        publishedAt,
      };
    }

    const author = subline.find(AUTHOR_SELECTOR).first().text().trim();
    if (!author) {
      throw new ParseError(`Submission ${id} has no author`);
    }

    /* Direct child selector skips the age permalink nested inside span.age. */
    const commentsText = subline.children(COMMENTS_LINK_SELECTOR).last().text().trim();

    return {
      id,
      rank,
      title,
      url: articleUrl,
      ...(site ? { site } : {}),
      points: parsePoints(subline.find(SCORE_SELECTOR).first().text().trim(), id),
      author,
      commentsCount: parseCommentsCount(commentsText, id),
      publishedAt,
    };
  });
}
