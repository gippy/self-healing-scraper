import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { describe, it } from 'node:test';
import { CATEGORIES, getCatalogItems, getItemSlug } from '../src/catalog.ts';
import { createImageUrlGetter, readImage } from '../src/images.ts';

// Creates a temporary images folder; `files` may include a subfolder, like `gpu/name.jpg`.
function createImagesDir(files: string[]): string {
  const dir = `${mkdtempSync(`${tmpdir()}/auction-images-`)}/`;
  for (const file of files) {
    mkdirSync(dirname(`${dir}${file}`), { recursive: true });
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
    const getImageUrl = createImageUrlGetter(createImagesDir(['gpu/thermal-throttle-tx-9000-24gb.jpg']), 'gpu');

    assert.equal(getImageUrl('Thermal Throttle TX-9000 24GB'), '/images/gpu/thermal-throttle-tx-9000-24gb.jpg');
    assert.equal(getImageUrl('Kiosk Card K-2 2GB'), '/images/placeholder.svg');
  });

  it('serves only plain image paths from the images folder', async () => {
    const dir = createImagesDir(['placeholder.svg', 'gpu/kiosk-card-k-2-2gb.jpg']);

    assert.equal((await readImage('gpu/kiosk-card-k-2-2gb.jpg', dir))?.contentType, 'image/jpeg');
    assert.equal((await readImage('placeholder.svg', dir))?.contentType, 'image/svg+xml');
    assert.equal(await readImage('../package.json', dir), undefined);
    assert.equal(await readImage('gpu/../../package.json', dir), undefined);
    assert.equal(await readImage('missing.jpg', dir), undefined);
  });
});
