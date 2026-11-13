import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getItemSlug, IMAGE_FOLDER } from './catalog.ts';

/** `public/images`: the placeholder at the top, each catalog's photos in its own folder. */
export const IMAGES_DIR = fileURLToPath(new URL('../public/images/', import.meta.url));
const PLACEHOLDER_URL = '/images/placeholder.svg';
const IMAGE_PATH_PATTERN = /^(?:[a-z0-9-]+\/)?[a-z0-9-]+\.(jpg|svg)$/;
const CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', svg: 'image/svg+xml' };

export type ImageUrlGetter = (title: string) => string;

/** Maps a lot title to its product photo in the catalog's folder, or to a placeholder when the photo was never generated. */
export function createImageUrlGetter(imagesDir: string = IMAGES_DIR, folder: string = IMAGE_FOLDER): ImageUrlGetter {
  const folderDir = `${imagesDir}${folder}/`;
  const available = new Set(existsSync(folderDir) ? readdirSync(folderDir) : []);
  return (title) => {
    const file = `${getItemSlug(title)}.jpg`;
    return available.has(file) ? `/images/${folder}/${file}` : PLACEHOLDER_URL;
  };
}

/** Reads an image below `public/images`; only `name.jpg`, `name.svg` or `folder/name.jpg` paths are served. */
export async function readImage(path: string, imagesDir: string = IMAGES_DIR): Promise<{ body: Buffer; contentType: string } | undefined> {
  const extension = IMAGE_PATH_PATTERN.exec(path)?.[1];
  if (!extension) {
    return undefined;
  }
  try {
    return { body: await readFile(`${imagesDir}${path}`), contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream' };
  } catch {
    return undefined;
  }
}
