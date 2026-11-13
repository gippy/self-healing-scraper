import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseError } from '../src/parsers/errors.ts';
import { parse } from '../src/parsers/index.ts';
import { listFixtures, loadFixture } from './helpers/fixtures.ts';

const BASE_URL = 'https://news.ycombinator.com/';

describe('hackernews parser', () => {
  it('parses every saved fixture', () => {
    const fixtures = listFixtures();
    assert.ok(fixtures.length >= 2);
    for (const name of fixtures) {
      const items = parse(loadFixture(name), BASE_URL);
      assert.equal(items.length, 30);
    }
  });

  it('reads articles, zero-comment discussions, and job posts from page-1.html', () => {
    const items = parse(loadFixture('page-1.html'), BASE_URL);
    assert.equal(items.length, 30);

    assert.deepStrictEqual(items[0], {
      id: '50489641',
      rank: 1,
      title: 'FAA Issues National Ground Stop',
      url: 'https://www.fly.faa.gov/adv/adv_otherdis?adv_date=11132026&advn=111',
      site: 'faa.gov',
      points: 936,
      author: 'zulln',
      commentsCount: 551,
      publishedAt: '2026-11-13T21:05:53.000Z',
    });

    assert.deepStrictEqual(items[6], {
      id: '50491423',
      rank: 7,
      title: "Terminal borders that don't cost a cell",
      url: 'https://www.joshka.net/cell-borders/',
      site: 'joshka.net',
      points: 5,
      author: 'vinhnx',
      commentsCount: 0,
      publishedAt: '2026-11-13T23:06:40.000Z',
    });

    assert.deepStrictEqual(items[10], {
      id: '50489589',
      rank: 11,
      title: 'Autonomous (YC F25) is hiring MTS to build AI agents that manage your wealth',
      url: 'https://atg.science/careers',
      site: 'atg.science',
      publishedAt: '2026-11-13T21:01:11.000Z',
    });

    assert.deepStrictEqual(items[29], {
      id: '50486521',
      rank: 30,
      title: 'Concurrent Shell Command Queues',
      url: 'https://emmer.dev/blog/concurrent-shell-command-queues/',
      site: 'emmer.dev',
      points: 23,
      author: 'speckx',
      commentsCount: 14,
      publishedAt: '2026-11-13T17:13:01.000Z',
    });
  });

  it('reads articles from page-2.html', () => {
    const items = parse(loadFixture('page-2.html'), BASE_URL);
    assert.equal(items.length, 30);

    assert.deepStrictEqual(items[0], {
      id: '50489641',
      rank: 1,
      title: 'FAA Issues National Ground Stop',
      url: 'https://www.fly.faa.gov/adv/adv_otherdis?adv_date=11132026&advn=111',
      site: 'faa.gov',
      points: 936,
      author: 'zulln',
      commentsCount: 551,
      publishedAt: '2026-11-13T21:05:53.000Z',
    });

    assert.deepStrictEqual(items[29], {
      id: '50486521',
      rank: 30,
      title: 'Concurrent Shell Command Queues',
      url: 'https://emmer.dev/blog/concurrent-shell-command-queues/',
      site: 'emmer.dev',
      points: 23,
      author: 'speckx',
      commentsCount: 14,
      publishedAt: '2026-11-13T17:13:01.000Z',
    });
  });

  it('throws ParseError when the page has no submissions', () => {
    assert.throws(
      () => parse('<html><body><form>Sign in</form></body></html>', BASE_URL),
      ParseError,
    );
  });

  it('throws ParseError when a submission has unreadable metadata', () => {
    const brokenHtml = `
      <html><body><table>
        <tr class="athing submission" id="123">
          <td><span class="rank">1.</span></td>
          <td class="title"><span class="titleline"><a href="https://example.com">Broken</a></span></td>
        </tr>
        <tr><td class="subtext"><span class="subline"><span class="score">NaN</span><span class="age" title="2026-11-13T21:05:53">now</span></span></td></tr>
      </table></body></html>
    `;
    assert.throws(() => parse(brokenHtml, BASE_URL), ParseError);
  });
});
