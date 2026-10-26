/**
 * Read the value left live by a static JavaScript/TypeScript object literal.
 *
 * Object properties are last-write-wins.  Consumers that stop at the first
 * spelling can therefore publish stale SEO metadata when a generated entry
 * temporarily contains a duplicate key.  Keep this reader dependency-light:
 * callers that only need a source block must not import corpus floors (which
 * also loads generated corpus configuration).
 */
import {
  decodeStaticStringLiteral,
  matchingDelimiter,
  readStaticStringLiteral,
  skipStaticTrivia,
} from './ts-literals.mjs';

function readSeoStringLiteralField(block, field) {
  return lastStaticPropertyValue(block, field);
}
function skipQuotedValue(block, start) {
  const quote = block[start];
  for (let cursor = start + 1; cursor < block.length; cursor += 1) {
    if (block[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (block[cursor] === quote) return cursor + 1;
  }
  return block.length;
}

function skipValue(block, start) {
  const first = block[start];
  if (first === "'" || first === '"' || first === '`') return skipQuotedValue(block, start);
  if (first === '{' || first === '[' || first === '(') {
    const close = matchingDelimiter(block, start);
    return close < 0 ? block.length : close + 1;
  }
  let cursor = start;
  while (cursor < block.length && block[cursor] !== ',' && block[cursor] !== '}') cursor += 1;
  return cursor;
}

/**
 * @param {string} block a balanced object-literal block
 * @param {string} field the top-level property to read
 * @returns {string|undefined} the final static value, if present
 */
export function lastStaticPropertyValue(block, field) {
  const objectOpen = block.indexOf('{');
  let cursor = objectOpen >= 0 ? objectOpen + 1 : block.length;
  let lastValue;

  while (cursor < block.length) {
    cursor = skipStaticTrivia(block, cursor, 'SEO entry', 'seo-field');
    if (cursor >= block.length) break;

    let key;
    let keyEnd = cursor;
    const first = block[cursor];
    if (first === "'" || first === '"' || first === '`') {
      const literal = readStaticStringLiteral(block, cursor, 'SEO entry', 'seo-field');
      key = decodeStaticStringLiteral(literal.value, literal.quote);
      keyEnd = literal.end;
    } else if (/[A-Za-z_$]/u.test(first)) {
      keyEnd += 1;
      while (/[A-Za-z0-9_$]/u.test(block[keyEnd] || '')) keyEnd += 1;
      key = block.slice(cursor, keyEnd);
    } else {
      cursor += 1;
      continue;
    }

    const colon = skipStaticTrivia(block, keyEnd, 'SEO entry', 'seo-field');
    if (block[colon] !== ':') {
      cursor = keyEnd;
      continue;
    }
    const valueStart = skipStaticTrivia(block, colon + 1, 'SEO entry', 'seo-field');
    if (key === field && ["'", '"', '`'].includes(block[valueStart])) {
      const value = readStaticStringLiteral(block, valueStart, 'SEO entry', 'seo-field');
      lastValue = decodeStaticStringLiteral(value.value, value.quote);
    }

    // `structuredData` is the one nested object whose headline/date fields
    // are consumed by the corpus readers. Re-enter it only for those fields;
    // dynamic template URLs and unrelated nested strings stay opaque.
    if (
      key === 'structuredData'
      && (field === 'headline' || field === 'datePublished')
      && block[valueStart] === '{'
    ) {
      const close = matchingDelimiter(block, valueStart);
      if (close >= 0) {
        const nested = readSeoStringLiteralField(block.slice(valueStart, close + 1), field);
        if (nested !== undefined) lastValue = nested;
      }
    }

    cursor = skipValue(block, valueStart);
  }
  return lastValue;
}
