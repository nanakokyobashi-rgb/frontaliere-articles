/**
 * Linear reader for static `blog.article.<id>.<field>` string properties.
 *
 * The corpus contains very large literals and a few historical modules whose
 * properties are separated only by a newline. A lazy RegExp with a
 * backreference has pathological backtracking on those values and can keep a
 * CI guard alive until the job timeout. This scanner consumes each quote and
 * escape once, including when a malformed literal is rejected, preserves raw
 * value offsets for repair tools, and keeps the old delimiter requirement so
 * malformed adjacent properties are not admitted by the guard.
 */

const ARTICLE_KEY_PREFIX = 'blog.article.';

function isSupportedQuote(quote, allowTemplateLiterals) {
  return quote === "'" || quote === '"' || (allowTemplateLiterals && quote === '`');
}

function readRawStringLiteralResult(source, start, { allowTemplateLiterals = true } = {}) {
  const text = String(source ?? '');
  const quote = text[start];
  if (!isSupportedQuote(quote, allowTemplateLiterals)) return { literal: null, next: start + 1 };
  const allowsPhysicalLineTerminators = quote === '`';
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') {
      if (text[cursor + 1] === '\r' && text[cursor + 2] === '\n') cursor += 2;
      else cursor += 1;
      continue;
    }
    if (!allowsPhysicalLineTerminators && (text[cursor] === '\r' || text[cursor] === '\n')) {
      return {
        literal: null,
        next: text[cursor] === '\r' && text[cursor + 1] === '\n' ? cursor + 2 : cursor + 1,
      };
    }
    if (text[cursor] === quote) {
      return {
        literal: {
          quote,
          rawValue: text.slice(start + 1, cursor),
          rawStart: start + 1,
          rawEnd: cursor,
          end: cursor + 1,
        },
        next: cursor + 1,
      };
    }
  }
  return { literal: null, next: text.length };
}

/**
 * Read one static string/template literal without backtracking.
 *
 * Single- and double-quoted TypeScript literals cannot contain a physical
 * line terminator. Template literals can, because the corpus uses them for
 * long Markdown bodies. A backslash escapes the following code unit (or a
 * CRLF pair), so an escaped line continuation is not mistaken for the end of
 * a quoted literal.
 */
export function readRawStringLiteral(source, start, options = {}) {
  return readRawStringLiteralResult(source, start, options).literal;
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

function isIdentifierStart(character) {
  return /[$A-Z_a-z]/u.test(character);
}

function isIdentifierPart(character) {
  return /[$0-9A-Z_a-z]/u.test(character);
}

/**
 * Scan simple object properties whose values are static string/template
 * literals. The optional allow-list keeps callers from treating unrelated
 * object properties as data. Both the property walk and literal walk are
 * linear and skip comments/strings instead of searching through their text.
 */
export function scanStaticStringProperties(source, allowedNames = null, { includeTemplateLiterals = false } = {}) {
  const text = String(source ?? '');
  const allowed = allowedNames ? new Set(allowedNames) : null;
  const readLiteral = (start) => readRawStringLiteralResult(text, start, {
    allowTemplateLiterals: includeTemplateLiterals,
  });
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

    const literalResult = readLiteral(cursor);
    const literal = literalResult.literal;
    if (literal) {
      cursor = literal.end;
      continue;
    }
    if (isSupportedQuote(text[cursor], includeTemplateLiterals)) {
      cursor = literalResult.next;
      continue;
    }

    if (!isIdentifierStart(text[cursor])) {
      cursor += 1;
      continue;
    }

    const nameStart = cursor;
    cursor += 1;
    while (cursor < text.length && isIdentifierPart(text[cursor])) cursor += 1;
    const name = text.slice(nameStart, cursor);
    const colon = skipTrivia(text, cursor);
    if (text[colon] !== ':' || (allowed && !allowed.has(name))) continue;

    const valueStart = skipTrivia(text, colon + 1);
    const valueResult = readLiteral(valueStart);
    const valueLiteral = valueResult.literal;
    if (!valueLiteral) {
      if (isSupportedQuote(text[valueStart], includeTemplateLiterals)) {
        cursor = valueResult.next;
      }
      continue;
    }
    entries.push({
      name,
      rawValue: valueLiteral.rawValue,
      quote: valueLiteral.quote,
      valueStart: valueLiteral.rawStart,
      valueEnd: valueLiteral.rawEnd,
      end: valueLiteral.end,
    });
    cursor = valueLiteral.end;
  }

  return entries;
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
export function scanStaticArticleFieldEntries(source, { includeTemplateLiterals = false } = {}) {
  const text = String(source ?? '');
  const readLiteral = (start) => readRawStringLiteralResult(text, start, {
    allowTemplateLiterals: includeTemplateLiterals,
  });
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

    const keyResult = readLiteral(cursor);
    const keyLiteral = keyResult.literal;
    if (!keyLiteral) {
      if (isSupportedQuote(text[cursor], includeTemplateLiterals)) {
        cursor = keyResult.next;
        continue;
      }
      cursor += 1;
      continue;
    }

    const field = articleFieldFromKey(keyLiteral.rawValue);
    if (field) {
      const colon = skipTrivia(text, keyLiteral.end);
      if (text[colon] === ':') {
        const valueStart = skipTrivia(text, colon + 1);
        const valueResult = readLiteral(valueStart);
        const valueLiteral = valueResult.literal;
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
        if (isSupportedQuote(text[valueStart], includeTemplateLiterals)) {
          cursor = valueResult.next;
          continue;
        }
      }
    }

    cursor = keyLiteral.end;
  }

  return entries;
}
