import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getItemSlug } from './catalog.ts';

export const IMAGES_DIR = fileURLToPath(new URL('../public/images/', import.meta.url));
const PLACEHOLDER_URL = '/images/placeholder.svg';
const IMAGE_FILE_PATTERN = /^[a-z0-9-]+\.(jpg|svg)$/;
const CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', svg: 'image/svg+xml' };

export type ImageUrlGetter = (title: string) => string;

/** Maps a lot title to its product photo, or to a neutral placeholder when the photo was never generated. */
export function createImageUrlGetter(imagesDir: string = IMAGES_DIR): ImageUrlGetter {
  const available = new Set(existsSync(imagesDir) ? readdirSync(imagesDir) : []);
  return (title) => {
    const file = `${getItemSlug(title)}.jpg`;
    return available.has(file) ? `/images/${file}` : PLACEHOLDER_URL;
  };
}

/** Reads an image from `public/images`; file names other than plain `slug.jpg` or `slug.svg` are refused. */
export async function readImage(file: string, imagesDir: string = IMAGES_DIR): Promise<{ body: Buffer; contentType: string } | undefined> {
  const extension = IMAGE_FILE_PATTERN.exec(file)?.[1];
  if (!extension) {
    return undefined;
  }
  try {
    return { body: await readFile(`${imagesDir}${file}`), contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream' };
  } catch {
    return undefined;
  }
}
