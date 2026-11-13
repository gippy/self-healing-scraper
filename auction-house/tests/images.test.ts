import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { CATEGORIES, getCatalogItems, getItemSlug } from '../src/catalog.ts';
import { createImageUrlGetter, readImage } from '../src/images.ts';

function createImagesDir(files: string[]): string {
  const dir = `${mkdtempSync(`${tmpdir()}/auction-images-`)}/`;
  for (const file of files) {
    writeFileSync(`${dir}${file}`, 'image bytes');
  }
  return dir;
}

describe('product images', () => {
  it('gives every catalog item its own image file name', () => {
    const slugs = getCatalogItems().map((item) => getItemSlug(item.title));
    assert.equal(new Set(slugs).size, slugs.length);
    assert.ok(slugs.every((slug) => /^[a-z0-9-]+$/.test(slug)));
    assert.ok(slugs.length >= CATEGORIES.length * 15);
  });

  it('points a lot at its photo, or at the placeholder when the photo is missing', () => {
    const getImageUrl = createImageUrlGetter(createImagesDir(['vintage-no-4-smoothing-plane.jpg']));

    assert.equal(getImageUrl('Vintage No. 4 Smoothing Plane'), '/images/vintage-no-4-smoothing-plane.jpg');
    assert.equal(getImageUrl('Bog Oak Offcuts'), '/images/placeholder.svg');
  });

  it('serves only plain image names from the images folder', async () => {
    const dir = createImagesDir(['bog-oak-offcuts.jpg']);

    assert.equal((await readImage('bog-oak-offcuts.jpg', dir))?.contentType, 'image/jpeg');
    assert.equal(await readImage('../package.json', dir), undefined);
    assert.equal(await readImage('missing.jpg', dir), undefined);
  });
});
