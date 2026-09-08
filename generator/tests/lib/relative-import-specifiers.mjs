/**
 * Extract static and dynamic JavaScript import specifiers without treating
 * comments, strings, JSDoc, or `registry.import(...)` as dependencies.
 *
 * This is deliberately a tiny lexical scanner, not a JavaScript parser: the
 * closure guards only need the string literal that follows an import token.
 * Keeping the state here makes both guards use the same prefix rules and,
 * unlike a global regex, lets the scan see every dynamic import on a line.
 */

const IDENT = /[\p{L}\p{N}_$]/u;

function isIdent(ch) {
  return Boolean(ch) && IDENT.test(ch);
}

function wordAt(src, at, word) {
  return src.startsWith(word, at)
    && src[at - 1] !== '.'
    && !isIdent(src[at - 1])
    && !isIdent(src[at + word.length]);
}

function skipQuoted(src, at, quote) {
  for (let i = at + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === quote) return i + 1;
  }
  return src.length;
}

function quotedValue(src, at) {
  const quote = src[at];
  if (quote !== "'" && quote !== '"') return null;
  let value = '';
  for (let i = at + 1; i < src.length; i += 1) {
    if (src[i] === '\\') {
      value += src[i];
      if (i + 1 < src.length) value += src[++i];
      continue;
    }
    if (src[i] === quote) return { value, end: i + 1 };
    value += src[i];
  }
  return null;
}

function skipSpace(src, at) {
  while (at < src.length && /\s/u.test(src[at])) at += 1;
  return at;
}

function staticSpecifier(src, at) {
  for (let i = at; i < src.length; i += 1) {
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i + 2);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      i = skipQuoted(src, i, src[i]) - 1;
      continue;
    }
    if (src[i] === ';') return null;
    if (wordAt(src, i, 'from')) {
      return quotedValue(src, skipSpace(src, i + 4));
    }
    if (wordAt(src, i, 'import') || wordAt(src, i, 'export')) return null;
  }
  return null;
}

export function importSpecifiers(source) {
  const src = String(source || '');
  const found = [];
  for (let i = 0; i < src.length;) {
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i + 2);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      i = skipQuoted(src, i, src[i]);
      continue;
    }

    let keyword = null;
    if (wordAt(src, i, 'import')) keyword = 'import';
    else if (wordAt(src, i, 'export')) keyword = 'export';
    if (!keyword) { i += 1; continue; }

    const next = skipSpace(src, i + keyword.length);
    if (keyword === 'import' && src[next] === '(') {
      const value = quotedValue(src, skipSpace(src, next + 1));
      if (value) found.push({ at: i, specifier: value.value });
    } else if (keyword === 'import' && (src[next] === "'" || src[next] === '"')) {
      const value = quotedValue(src, next);
      if (value) found.push({ at: i, specifier: value.value });
    } else {
      const value = staticSpecifier(src, next);
      if (value) found.push({ at: i, specifier: value.value });
    }
    i += keyword.length;
  }
  return found.sort((a, b) => a.at - b.at).map(({ specifier }) => specifier);
}
