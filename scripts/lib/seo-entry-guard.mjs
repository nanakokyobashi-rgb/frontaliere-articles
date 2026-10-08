import '../../host/cantonSectionsBootstrap.mjs';
import { readFileSync } from 'node:fs';

import { findSeoEntryMatches } from '../../engine/shared/seo-entry.mjs';

/** Read an optional SEO source without hiding errors other than ENOENT. */
export function readSeoEntrySource(file, { missingIsEmpty = false } = {}) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (missingIsEmpty && error?.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Find an article id in every SEO source file that a writer considers live.
 *
 * The balanced lexical resolver is intentional: a plain substring search
 * would confuse an id with a longer id that merely contains it.
 */
export function findSeoEntryOccurrences(id, files, readSource = readSeoEntrySource) {
  if (!Array.isArray(files)) throw new TypeError('SEO source files must be an array');
  return files.flatMap((file) => {
    const count = findSeoEntryMatches(readSource(file), id, file).length;
    return count > 0 ? [{ file, count }] : [];
  });
}

/** Refuse a new registration when its SEO key already exists anywhere live. */
export function assertSeoEntryAbsent(id, files, readSource) {
  const occurrences = findSeoEntryOccurrences(id, files, readSource);
  if (occurrences.length === 0) return;

  const detail = occurrences.map(({ file, count }) => `${file} (${count})`).join(', ');
  throw new Error(
    `SEO entry 'blog-${id}' already exists in ${detail}; refusing to append a duplicate.`,
  );
}
