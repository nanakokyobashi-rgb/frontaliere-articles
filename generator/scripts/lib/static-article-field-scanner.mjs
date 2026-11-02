/** Read the complete static article map using the shared source contract. */

import { parseStaticArticleTranslationEntries } from '../../../engine/shared/articleStaticSource.mjs';

/**
 * @returns {Array<{
 *   articleId: string,
 *   field: string,
 *   rawValue: string,
 *   value: string,
 *   quote: string,
 *   keyStart: number,
 *   valueStart: number,
 *   valueEnd: number,
 *   end: number,
 * }>}
 */
export function scanStaticArticleFieldEntries(source) {
  const text = String(source ?? '');
  return parseStaticArticleTranslationEntries(text, 'article-source.ts').map((entry) => ({
    articleId: entry.articleId,
    field: entry.field,
    rawValue: text.slice(entry.valueStart, entry.valueEnd),
    value: entry.value,
    quote: text[entry.valueStart - 1],
    keyStart: entry.index,
    valueStart: entry.valueStart,
    valueEnd: entry.valueEnd,
    end: entry.valueEnd + 1,
  }));
}

/** Encode a cooked string as a static TypeScript string with its source delimiter. */
export function encodeStaticArticleFieldValue(value, quote) {
  const text = String(value ?? '');
  if (quote === '`') {
    return text
      .replaceAll('\\', '\\\\')
      .replaceAll('`', '\\`')
      .replaceAll('${', '\\${');
  }
  if (quote !== "'" && quote !== '"') {
    throw new TypeError(`Unsupported TypeScript string delimiter: ${String(quote)}`);
  }
  const escapedQuote = quote === "'" ? /'/gu : /"/gu;
  return text
    .replaceAll('\\', '\\\\')
    .replace(escapedQuote, '\\$&')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}
