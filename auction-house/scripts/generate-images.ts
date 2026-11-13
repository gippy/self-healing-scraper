// Generates one product photo per catalog item with Gemini's image model and saves it as
// public/images/<IMAGE_FOLDER>/<item-slug>.jpg (512 px, JPEG). Existing images are skipped.
//
// Usage: GEMINI_API_KEY=... node scripts/generate-images.ts
// - GEMINI_ACCESS_KEY works instead of GEMINI_API_KEY.
// - GEMINI_IMAGE_MODEL overrides the model; LIMIT=3 generates only the first three missing images.
// - Resizing uses macOS `sips`; elsewhere the image is saved as Gemini returned it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCatalogItems, getItemSlug, IMAGE_FOLDER, type CatalogItem } from '../src/catalog.ts';

const API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const PRICE_PER_IMAGE_USD = 0.0336;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const IMAGES_DIR = fileURLToPath(new URL(`../public/images/${IMAGE_FOLDER}/`, import.meta.url));

const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_ACCESS_KEY;
const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1';
const limit = Number(process.env.LIMIT ?? Number.POSITIVE_INFINITY);
let isStopped = false;

function getPrompt(item: CatalogItem): string {
  return (
    `Studio product photograph for an online auction listing of a computer graphics card or accelerator board: ${item.title}. ${item.description} ` +
    'One piece of hardware, shown whole in a three-quarter view, centered on a seamless dark charcoal background with soft rim light. ' +
    'Realistic, sharp, clean. No text, no logos, no brand names, no labels, no stickers, no people, no hands.'
  );
}

type FoundImage = { data: string; mimeType: string };

// Finds the first base64 image anywhere in the response, whatever the exact response shape is.
function findImage(value: unknown): FoundImage | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findImage(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const mimeType = record.mime_type ?? record.mimeType;
    if (typeof record.data === 'string' && record.data.length > 1000 && (typeof mimeType !== 'string' || mimeType.startsWith('image/'))) {
      return { data: record.data, mimeType: typeof mimeType === 'string' ? mimeType : 'image/png' };
    }
    for (const entry of Object.values(record)) {
      const found = findImage(entry);
      if (found) return found;
    }
  }
  return undefined;
}

async function requestImage(item: CatalogItem): Promise<FoundImage> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey ?? '', 'content-type': 'application/json', 'Api-Revision': API_REVISION },
      body: JSON.stringify({ model, input: getPrompt(item), response_format: { type: 'image', aspect_ratio: '1:1', image_size: '1K' } }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (response.ok) {
      const image = findImage(JSON.parse(text));
      if (!image) throw new Error(`no image in the response: ${text.slice(0, 300)}`);
      return image;
    }
    // Quota and billing errors stop the whole run instead of retrying.
    if (response.status === 403 || /quota|billing|RESOURCE_EXHAUSTED/i.test(text)) {
      isStopped = true;
      throw new Error(`stopping, quota or billing: HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    if ((response.status !== 429 && response.status < 500) || attempt >= MAX_ATTEMPTS) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
  }
}

function saveImage(slug: string, image: FoundImage): void {
  const target = `${IMAGES_DIR}${slug}.jpg`;
  const extension = image.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  const original = `${IMAGES_DIR}${slug}.original.${extension}`;
  writeFileSync(original, Buffer.from(image.data, 'base64'));
  try {
    execFileSync('sips', ['-Z', '512', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', original, '--out', target], { stdio: 'ignore' });
    rmSync(original);
  } catch {
    writeFileSync(target, Buffer.from(image.data, 'base64'));
    rmSync(original);
    console.warn(`  ${slug}: saved without resizing (sips is not available)`);
  }
}

if (!apiKey) {
  console.error('Set GEMINI_API_KEY or GEMINI_ACCESS_KEY.');
  process.exit(1);
}
mkdirSync(IMAGES_DIR, { recursive: true });
const missing = getCatalogItems()
  .filter((item) => !existsSync(`${IMAGES_DIR}${getItemSlug(item.title)}.jpg`))
  .slice(0, limit);
console.log(`${missing.length} images to generate with ${model}`);

let generated = 0;
const failures: string[] = [];
const queue = [...missing];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let item = queue.shift(); item && !isStopped; item = queue.shift()) {
      const slug = getItemSlug(item.title);
      try {
        saveImage(slug, await requestImage(item));
        generated += 1;
        console.log(`  ok ${slug}`);
      } catch (error) {
        failures.push(slug);
        console.error(`  failed ${slug}: ${String(error)}`);
      }
    }
  }),
);

console.log(`generated ${generated}, failed ${failures.length}; about $${(generated * PRICE_PER_IMAGE_USD).toFixed(2)} at $${PRICE_PER_IMAGE_USD} per 1K image`);
process.exitCode = failures.length > 0 ? 1 : 0;
