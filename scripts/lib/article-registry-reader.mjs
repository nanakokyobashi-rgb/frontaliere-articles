/**
 * article-registry-reader.mjs — read article registry rows without lexical
 * matches.
 *
 * The registry is TypeScript source, not JSON: the three Node-side readers
 * cannot import it. A regex that stops at the first `}` therefore mistakes a
 * nested object (or text that only looks like a property) for the end of the
 * article row. Keep the balanced-object and top-level-property rules here so
 * every reader observes the same record.
 */

import { matchingDelimiter } from './ts-literals.mjs';

const OPEN_DELIMITERS = new Set(['{', '[', '(']);
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

function skipQuoted(src, start, limit = src.length) {
  const quote = src[start];
  for (let i = start + 1; i < limit; i += 1) {
    if (src[i] === '\\') {
      i += 1;
      continue;
    }
    if (src[i] === quote) return i + 1;
  }
  return limit;
}

function skipComment(src, start, limit = src.length) {
  if (src[start] !== '/') return start;
  if (src[start + 1] === '/') {
    const end = src.indexOf('\n', start + 2);
    return end < 0 ? limit : end;
  }
  if (src[start + 1] === '*') {
    const end = src.indexOf('*/', start + 2);
    return end < 0 ? limit : Math.min(end + 2, limit);
  }
  return start;
}

function skipTrivia(src, start, limit) {
  let i = start;
  while (i < limit) {
    if (/\s/u.test(src[i])) {
      i += 1;
      continue;
    }
    const afterComment = skipComment(src, i, limit);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    break;
  }
  return i;
}

function readKey(src, start, limit) {
  const first = src[start];
  if (IDENTIFIER_START.test(first || '')) {
    let end = start + 1;
    while (end < limit && IDENTIFIER_PART.test(src[end])) end += 1;
    return { key: src.slice(start, end), end };
  }
  if (first === "'" || first === '"') {
    const end = skipQuoted(src, start, limit);
    if (end <= limit && src[end - 1] === first) {
      return { key: src.slice(start + 1, end - 1), end };
    }
  }
  return null;
}

/** Find the comma that terminates one property value at this object depth. */
function valueEnd(src, start, limit) {
  let i = start;
  while (i < limit) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(src, i, limit);
      continue;
    }
    const afterComment = skipComment(src, i, limit);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (OPEN_DELIMITERS.has(ch)) {
      const close = matchingDelimiter(src, i);
      if (close < 0 || close >= limit) return limit;
      i = close + 1;
      continue;
    }
    if (ch === ',') return i;
    i += 1;
  }
  return limit;
}

function topLevelProperties(src, open, close) {
  const entries = [];
  let i = open + 1;
  while (i < close) {
    i = skipTrivia(src, i, close);
    if (i >= close) break;
    if (src[i] === ',') {
      i += 1;
      continue;
    }

    const keyInfo = readKey(src, i, close);
    if (!keyInfo) {
      i = valueEnd(src, i, close);
      if (src[i] === ',') i += 1;
      continue;
    }
    i = skipTrivia(src, keyInfo.end, close);
    if (src[i] !== ':') {
      // A method or a TypeScript member is not a data property. Move to the
      // next top-level comma instead of inspecting its nested body.
      i = valueEnd(src, i, close);
      if (src[i] === ',') i += 1;
      continue;
    }

    const valueStart = skipTrivia(src, i + 1, close);
    const valueStop = valueEnd(src, valueStart, close);
    const raw = src.slice(valueStart, valueStop).trim();
    entries.push({ key: keyInfo.key, raw, valueStart, valueEnd: valueStop });
    i = valueStop;
    if (src[i] === ',') i += 1;
  }
  return entries;
}

function stringBody(raw) {
  const value = String(raw ?? '').trim();
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value.at(-1) !== quote) return null;
  // Preserve the historical readers' literal-body semantics. Registry ids and
  // paths contain no escapes; not decoding here avoids changing values merely
  // because the reader moved from a regex to a scanner.
  return value.slice(1, -1);
}

/**
 * Find article rows whose first top-level property is the string `id` field.
 * Objects are returned in source order; nested objects are never considered
 * once their containing article row has been recognized.
 *
 * @param {string} src TypeScript source containing registry object literals
 * @returns {{ id: string, entries: { key: string, raw: string, valueStart: number, valueEnd: number }[], properties: Map<string, { key: string, raw: string, valueStart: number, valueEnd: number }>, start: number, end: number }[]}
 */
export function scanTopLevelArticleRecords(src) {
  const text = String(src ?? '');
  const records = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(text, i);
      continue;
    }
    const afterComment = skipComment(text, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (ch !== '{') {
      i += 1;
      continue;
    }

    const close = matchingDelimiter(text, i);
    if (close < 0) throw new Error(`article registry: object at ${i} is not balanced`);
    const entries = topLevelProperties(text, i, close);
    const first = entries[0];
    const id = first?.key === 'id' ? stringBody(first.raw) : null;
    if (id !== null) {
      const properties = new Map();
      for (const entry of entries) {
        if (!properties.has(entry.key)) properties.set(entry.key, entry);
      }
      records.push({ id, entries, properties, start: i, end: close + 1 });
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return records;
}

/** Read one top-level string-valued property from a scanned article row. */
export function readTopLevelString(record, key) {
  return stringBody(record?.properties?.get(key)?.raw);
}

/** Read the raw source text of one top-level property from a scanned row. */
export function readTopLevelRaw(record, key) {
  return record?.properties?.get(key)?.raw ?? null;
}

/** Read one top-level boolean property from a scanned article row. */
export function readTopLevelBoolean(record, key) {
  return /^true\b/u.test(String(record?.properties?.get(key)?.raw ?? '').trim());
}
