import { readFileSync } from 'node:fs';

import { findSeoEntryMatches } from '../../engine/shared/seo-entry.mjs';

/**
 * Find an article id in every SEO source file that a writer considers live.
 *
 * The balanced lexical resolver is intentional: a plain substring search
 * would confuse an id with a longer id that merely contains it.
 */
export function findSeoEntryOccurrences(id, files, readSource = (file) => readFileSync(file, 'utf8')) {
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
