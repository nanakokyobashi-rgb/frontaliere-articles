/**
 * Pure removal of one article's entries from a generated SEO source.
 *
 * SEO chunks are JavaScript object literals and a duplicate key is possible
 * after a partial/replayed generator run. The caller must be able to prepare
 * the complete new source before writing any other surface; keeping this
 * transformation pure makes that transaction boundary explicit and testable.
 */

import { matchingDelimiter } from './ts-literals.mjs';

/**
 * Remove every `'blog-<id>': { ... },` block from `source`.
 *
 * @param {string} source
 * @param {string} id
 * @param {string} [file='SEO source'] used in diagnostics
 * @returns {{ changed: boolean, src: string, removed: number }}
 */
export function removeSeoEntriesFromSource(source, id, file = 'SEO source') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${file}: article id must be a non-empty string`);
  }

  const needle = `'blog-${id}': {`;
  let src = String(source);
  let removed = 0;

  while (true) {
    const at = src.indexOf(needle);
    if (at === -1) break;
    const open = at + needle.length - 1;
    const close = matchingDelimiter(src, open);
    if (close === -1) throw new Error(`${file}: graffe sbilanciate attorno a blog-${id}`);

    let start = at;
    while (start > 0 && (src[start - 1] === ' ' || src[start - 1] === '\t')) start -= 1;
    let end = close + 1;
    if (src[end] === ',') end += 1;
    if (src[end] === '\n') end += 1;
    src = src.slice(0, start) + src.slice(end);
    removed += 1;
  }

  const remaining = src.split(needle).length - 1;
  if (remaining !== 0) {
    throw new Error(`${file}: restano ${remaining} voci SEO per blog-${id} dopo la rimozione`);
  }
  return { changed: removed > 0, src, removed };
}
