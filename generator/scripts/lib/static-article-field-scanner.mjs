/**
 * Linear reader for static `blog.article.<id>.<field>` string properties.
 *
 * The corpus contains very large literals and a few historical modules whose
 * properties are separated only by a newline. A lazy RegExp with a
 * backreference has pathological backtracking on those values and can keep a
 * CI guard alive until the job timeout. This scanner consumes each quote and
 * escape once, preserves raw value offsets for repair tools, and keeps the old
 * delimiter requirement so malformed adjacent properties are not admitted by
 * the guard.
 */

const ARTICLE_KEY_PREFIX = 'blog.article.';

function readRawStringLiteral(source, start) {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') return null;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) {
      return {
        quote,
        rawValue: source.slice(start + 1, cursor),
        rawStart: start + 1,
        rawEnd: cursor,
        end: cursor + 1,
      };
    }
  }
  return null;
}

function skipTrivia(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === '/' && source[cursor + 1] === '/') {
      const end = source.indexOf('\n', cursor + 2);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function articleFieldFromKey(key) {
  if (!key.startsWith(ARTICLE_KEY_PREFIX)) return null;
  const rest = key.slice(ARTICLE_KEY_PREFIX.length);
  const separator = rest.lastIndexOf('.');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    articleId: rest.slice(0, separator),
    field: rest.slice(separator + 1),
  };
}

/**
 * @returns {Array<{
 *   articleId: string,
 *   field: string,
 *   rawValue: string,
 *   quote: string,
 *   keyStart: number,
 *   valueStart: number,
 *   valueEnd: number,
 *   end: number,
 * }>}
 */
export function scanStaticArticleFieldEntries(source) {
  const text = String(source ?? '');
  const entries = [];
  let cursor = 0;

  while (cursor < text.length) {
    if (text[cursor] === '/' && text[cursor + 1] === '/') {
      const end = text.indexOf('\n', cursor + 2);
      cursor = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text[cursor] === '/' && text[cursor + 1] === '*') {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }

    const keyLiteral = readRawStringLiteral(text, cursor);
    if (!keyLiteral) {
      cursor += 1;
      continue;
    }

    const field = articleFieldFromKey(keyLiteral.rawValue);
    if (field) {
      const colon = skipTrivia(text, keyLiteral.end);
      if (text[colon] === ':') {
        const valueStart = skipTrivia(text, colon + 1);
        const valueLiteral = readRawStringLiteral(text, valueStart);
        if (valueLiteral) {
          const delimiter = skipTrivia(text, valueLiteral.end);
          if (text[delimiter] === ',' || text[delimiter] === '}') {
            entries.push({
              ...field,
              rawValue: valueLiteral.rawValue,
              quote: valueLiteral.quote,
              keyStart: cursor,
              valueStart: valueLiteral.rawStart,
              valueEnd: valueLiteral.rawEnd,
              end: valueLiteral.end,
            });
          }
          cursor = valueLiteral.end;
          continue;
        }
      }
    }

    cursor = keyLiteral.end;
  }

  return entries;
}
