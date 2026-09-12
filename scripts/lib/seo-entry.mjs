/**
 * Pure removal of one article's entries from a generated SEO source.
 *
 * SEO chunks are JavaScript object literals and a duplicate key is possible
 * after a partial/replayed generator run. The caller must be able to prepare
 * the complete new source before writing any other surface; keeping this
 * transformation pure makes that transaction boundary explicit and testable.
 */

import { matchingDelimiter } from './ts-literals.mjs';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Return the end of a quoted JavaScript string, or `-1` when it is malformed.
 * Newlines are not valid in the two ordinary string forms; template literals
 * have their own scanner below.
 */
function quotedEnd(src, start, quote) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === quote) return i;
    if (src[i] === '\n' || src[i] === '\r') return -1;
  }
  return -1;
}

/**
 * Find the closing backtick, including `${...}` expressions and nested
 * literals. The whole template is masked: an entry-looking line emitted as
 * template text is not an entry in the SEO object, even when its interpolation
 * contains JavaScript code.
 */
function templateEnd(src, start) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === '`') return i;
    if (src[i] !== '$' || src[i + 1] !== '{') continue;

    let depth = 1;
    for (i += 2; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '\\') { i += 1; continue; }
      if (ch === "'" || ch === '"') {
        const end = quotedEnd(src, i, ch);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '`') {
        const end = templateEnd(src, i);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i + 2);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}' && --depth === 0) break;
    }
    if (depth !== 0) return -1;
  }
  return -1;
}

function isRealSeoKey(src, start, end) {
  let lineStart = start;
  while (lineStart > 0 && src[lineStart - 1] !== '\n' && src[lineStart - 1] !== '\r') {
    lineStart -= 1;
  }
  if (!/^[\t ]*$/.test(src.slice(lineStart, start))) return false;
  const key = src.slice(start + 1, end);
  return /^blog-[^'\\\r\n]+$/.test(key) && src.startsWith(': {', end + 1);
}

/**
 * Mask comments and literal contents without changing UTF-16 offsets.
 * Canonical single-quoted SEO keys are the one string form deliberately kept
 * visible, so callers can locate real entries while every key-shaped phrase in
 * comments, ordinary strings, or template text remains invisible.
 */
export function maskSeoSource(source) {
  const src = String(source);
  const masked = new Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    masked[i] = src[i] === '\n' || src[i] === '\r' ? src[i] : ' ';
  }

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i + 2);
      i = end === -1 ? src.length - 1 : end - 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = (end === -1 ? src.length : end + 2) - 1;
      continue;
    }
    if (ch === '`') {
      const end = templateEnd(src, i);
      i = (end === -1 ? src.length : end + 1) - 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = quotedEnd(src, i, ch);
      const stop = end === -1 ? src.length - 1 : end;
      if (ch === "'" && end !== -1 && isRealSeoKey(src, i, end)) {
        for (let j = i; j <= end; j += 1) masked[j] = src[j];
      }
      i = stop;
      continue;
    }
    masked[i] = ch;
  }
  return masked.join('');
}

function locateSeoEntryMatches(source, entryRe, file) {
  const src = String(source);
  const masked = maskSeoSource(src);
  const matches = [];
  for (const match of masked.matchAll(entryRe)) {
    const keyOffset = match[0].indexOf("'blog-");
    const index = match.index + keyOffset;
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = matchingDelimiter(src, openIdx);
    if (closeIdx === -1) {
      const id = match[1] ?? 'unknown';
      throw new Error(`${file}: graffe sbilanciate attorno a blog-${id}`);
    }
    matches.push({
      id: match[1],
      index,
      lineStart: match.index,
      indent: match[0].slice(0, keyOffset),
      openIdx,
      closeIdx,
    });
  }
  return matches;
}

/**
 * Locate every real `blog-<id>` object entry, regardless of indentation.
 * Generated readers and the removal writer consume the canonical single-quote
 * `': {` syntax, so only the indentation is flexible here. The lexical mask
 * excludes comments and literals, while matchingDelimiter scopes each result
 * to its own balanced object instead of guessing from the next key.
 *
 * @param {string} source
 * @param {string} id
 * @param {string} [file='SEO source'] used in diagnostics
 * @returns {{id: string, index: number, lineStart: number, indent: string, openIdx: number, closeIdx: number}[]}
 */
export function findSeoEntryMatches(source, id, file = 'SEO source') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${file}: article id must be a non-empty string`);
  }

  const escaped = escapeRegex(id);
  const entryRe = new RegExp(`^[\\t ]*'blog-(${escaped})': \\{`, 'gm');
  return locateSeoEntryMatches(source, entryRe, file);
}

/** Locate all real SEO entries for consumers that need the whole chunk. */
export function findAllSeoEntryMatches(source, file = 'SEO source') {
  return locateSeoEntryMatches(source, /^[\t ]*'blog-([^']+)': \{/gm, file);
}

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

  let src = String(source);
  const matches = findSeoEntryMatches(src, id, file);
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const { lineStart, closeIdx } = matches[i];
    let end = closeIdx + 1;
    if (src[end] === ',') end += 1;
    if (src[end] === '\r') end += 1;
    if (src[end] === '\n') end += 1;
    src = src.slice(0, lineStart) + src.slice(end);
  }

  const remaining = findSeoEntryMatches(src, id, file).length;
  if (remaining !== 0) {
    throw new Error(`${file}: restano ${remaining} voci SEO per blog-${id} dopo la rimozione`);
  }
  return { changed: matches.length > 0, src, removed: matches.length };
}
