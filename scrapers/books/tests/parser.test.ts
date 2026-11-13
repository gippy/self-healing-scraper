import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseError } from '../src/parsers/errors.ts';
import { parse } from '../src/parsers/index.ts';
import { listFixtures, loadFixture } from './helpers/fixtures.ts';

const BASE_URL = 'https://books.toscrape.com/';

describe('books parser', () => {
  it('reads all 20 books and their details from page-1.html', () => {
    const books = parse(loadFixture('page-1.html'), BASE_URL);
    assert.equal(books.length, 20);

    assert.deepEqual(books[0], {
      id: '1000',
      title: 'A Light in the Attic',
      price: { amount: 51.77, currency: 'GBP' },
      status: 'In stock',
      rating: 3,
      url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
      imageUrl: 'https://books.toscrape.com/media/cache/2c/da/2cdad67c44b002e7ead0cc35693c0e8b.jpg',
    });

    assert.deepEqual(books[4], {
      id: '996',
      title: 'Sapiens: A Brief History of Humankind',
      price: { amount: 54.23, currency: 'GBP' },
      status: 'In stock',
      rating: 5,
      url: 'https://books.toscrape.com/catalogue/sapiens-a-brief-history-of-humankind_996/index.html',
      imageUrl: 'https://books.toscrape.com/media/cache/be/a5/bea5697f2534a2f86a3ef27b5a8c12a6.jpg',
    });

    assert.deepEqual(books[19], {
      id: '981',
      title: "It's Only the Himalayas",
      price: { amount: 45.17, currency: 'GBP' },
      status: 'In stock',
      rating: 2,
      url: 'https://books.toscrape.com/catalogue/its-only-the-himalayas_981/index.html',
      imageUrl: 'https://books.toscrape.com/media/cache/27/a5/27a53d0bb95bdd88288eaf66c9230d7e.jpg',
    });
  });

  it('reads all 20 books and their details from page-2.html', () => {
    const books = parse(loadFixture('page-2.html'), BASE_URL);
    assert.equal(books.length, 20);

    const first = books[0];
    const last = books[19];
    assert.ok(first);
    assert.ok(last);

    assert.equal(first.id, '1000');
    assert.equal(first.title, 'A Light in the Attic');
    assert.deepEqual(first.price, { amount: 51.77, currency: 'GBP' });
    assert.equal(first.rating, 3);
    assert.equal(first.status, 'In stock');

    assert.equal(last.id, '981');
    assert.equal(last.title, "It's Only the Himalayas");
    assert.deepEqual(last.price, { amount: 45.17, currency: 'GBP' });
    assert.equal(last.rating, 2);
    assert.equal(last.status, 'In stock');
  });

  it('parses every saved fixture without error', () => {
    const fixtures = listFixtures();
    assert.ok(fixtures.length >= 2);
    for (const fixture of fixtures) {
      const books = parse(loadFixture(fixture), BASE_URL);
      assert.ok(books.length > 0);
    }
  });

  it('throws ParseError when the page has no book listings', () => {
    assert.throws(
      () => parse('<html><body><form>Sign in</form></body></html>', BASE_URL),
      ParseError,
    );
  });

  it('throws ParseError when a book listing has an unreadable price or rating', () => {
    const brokenPriceHtml = `
      <ol class="row">
        <li>
          <article class="product_pod">
            <div class="image_container"><img src="media/cover.jpg"></div>
            <p class="star-rating Three"></p>
            <h3><a href="catalogue/sample_1000/index.html" title="Sample">Sample</a></h3>
            <div class="product_price">
              <p class="price_color">free</p>
              <p class="instock availability">In stock</p>
            </div>
          </article>
        </li>
      </ol>`;
    assert.throws(() => parse(brokenPriceHtml, BASE_URL), ParseError);

    const brokenRatingHtml = brokenPriceHtml
      .replace('free', '£12.00')
      .replace('star-rating Three', 'star-rating Unknown');
    assert.throws(() => parse(brokenRatingHtml, BASE_URL), ParseError);
  });
});
