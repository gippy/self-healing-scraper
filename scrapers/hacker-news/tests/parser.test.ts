import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseError } from '../src/parsers/errors.ts';
import { parse } from '../src/parsers/index.ts';
import { listFixtures, loadFixture } from './helpers/fixtures.ts';

const PAGE_URL = 'https://news.ycombinator.com/';

describe('hacker-news parser', () => {
  it('parses every saved fixture without errors', () => {
    const fixtures = listFixtures();
    assert.ok(fixtures.length >= 2);
    for (const name of fixtures) {
      const stories = parse(loadFixture(name), PAGE_URL);
      assert.equal(stories.length, 30);
      assert.deepEqual(
        stories.map((story) => story.rank),
        Array.from({ length: 30 }, (_, index) => index + 1),
      );
    }
  });

  it('reads stories and job ads from page-1.html', () => {
    const stories = parse(loadFixture('page-1.html'), PAGE_URL);
    assert.equal(stories.length, 30);

    assert.deepEqual(stories[0], {
      id: '50489641',
      rank: 1,
      title: 'FAA Issues National Ground Stop',
      url: 'https://www.fly.faa.gov/adv/adv_otherdis?adv_date=11132026&advn=111',
      site: 'faa.gov',
      points: 748,
      author: 'zulln',
      age: '1 hour ago',
      postedAt: '2026-11-13T21:05:53.000Z',
      comments: 399,
    });

    assert.deepEqual(stories[8], {
      id: '50489589',
      rank: 9,
      title: 'Autonomous (YC F25) is hiring MTS to build AI agents that manage your wealth',
      url: 'https://atg.science/careers',
      site: 'atg.science',
      age: '1 hour ago',
      postedAt: '2026-11-13T21:01:11.000Z',
    });

    assert.deepEqual(stories[29], {
      id: '50486521',
      rank: 30,
      title: 'Concurrent Shell Command Queues',
      url: 'https://emmer.dev/blog/concurrent-shell-command-queues/',
      site: 'emmer.dev',
      points: 21,
      author: 'speckx',
      age: '5 hours ago',
      postedAt: '2026-11-13T17:13:01.000Z',
      comments: 12,
    });
  });

  it('reads stories and decoded titles from page-2.html', () => {
    const stories = parse(loadFixture('page-2.html'), PAGE_URL);
    assert.equal(stories.length, 30);

    assert.deepEqual(stories[0], {
      id: '50489641',
      rank: 1,
      title: 'FAA Issues National Ground Stop',
      url: 'https://www.fly.faa.gov/adv/adv_otherdis?adv_date=11132026&advn=111',
      site: 'faa.gov',
      points: 748,
      author: 'zulln',
      age: '1 hour ago',
      postedAt: '2026-11-13T21:05:53.000Z',
      comments: 399,
    });

    assert.deepEqual(stories[16], {
      id: '50486748',
      rank: 17,
      title: "AI unlocks Gödel's notebooks, said to contain hundreds of proved theorems",
      url: 'https://www.theguardian.com/science/2026/nov/13/kurt-godel-notebooks-ai-helps-unlock-hidden-discoveries-man-who-transformed-maths',
      site: 'theguardian.com',
      points: 274,
      author: 'bookofjoe',
      age: '5 hours ago',
      postedAt: '2026-11-13T17:30:10.000Z',
      comments: 82,
    });

    assert.deepEqual(stories[29], {
      id: '50486521',
      rank: 30,
      title: 'Concurrent Shell Command Queues',
      url: 'https://emmer.dev/blog/concurrent-shell-command-queues/',
      site: 'emmer.dev',
      points: 21,
      author: 'speckx',
      age: '5 hours ago',
      postedAt: '2026-11-13T17:13:01.000Z',
      comments: 12,
    });
  });

  it('resolves relative URLs for on-site posts and maps discuss to 0 comments', () => {
    const html = `
      <table>
        <tr class="athing submission" id="50491000">
          <td class="title"><span class="rank">1.</span></td>
          <td class="title"><span class="titleline"><a href="item?id=50491000">Ask HN: Favorite CLI tools?</a></span></td>
        </tr>
        <tr>
          <td colspan="2"></td>
          <td class="subtext">
            <span class="subline">
              <span class="score" id="score_50491000">1 point</span> by <a href="user?id=alice">alice</a>
              <span class="age" title="2026-11-13T22:30:00"><a href="item?id=50491000">1 minute ago</a></span>
              | <a href="hide?id=50491000&amp;goto=news">hide</a>
              | <a href="item?id=50491000">discuss</a>
            </span>
          </td>
        </tr>
      </table>
    `;
    assert.deepEqual(parse(html, PAGE_URL), [
      {
        id: '50491000',
        rank: 1,
        title: 'Ask HN: Favorite CLI tools?',
        url: 'https://news.ycombinator.com/item?id=50491000',
        points: 1,
        author: 'alice',
        age: '1 minute ago',
        postedAt: '2026-11-13T22:30:00.000Z',
        comments: 0,
      },
    ]);
  });

  it('throws ParseError when the page has no stories', () => {
    assert.throws(() => parse('<html><body><form>Sign in</form></body></html>', PAGE_URL), ParseError);
  });

  it('throws ParseError when a scored story lacks author or comments', () => {
    const missingCommentsHtml = `
      <table>
        <tr class="athing submission" id="50491001">
          <td class="title"><span class="rank">1.</span></td>
          <td class="title"><span class="titleline"><a href="https://example.com">Example</a></span></td>
        </tr>
        <tr>
          <td class="subtext">
            <span class="score">10 points</span> by <a href="user?id=bob">bob</a>
            <span class="age" title="2026-11-13T22:30:00"><a href="item?id=50491001">5 minutes ago</a></span>
          </td>
        </tr>
      </table>
    `;
    assert.throws(() => parse(missingCommentsHtml, PAGE_URL), ParseError);
  });
});
