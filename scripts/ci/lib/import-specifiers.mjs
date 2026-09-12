/**
 * Estrae gli specificatori importati da sorgenti JavaScript senza trattare
 * commenti, stringhe, segmenti testuali dei template o registry.import(...)
 * come dipendenze. Le espressioni `${...}` dei template restano invece codice
 * e vengono percorse.
 *
 * Il modulo e' volutamente un piccolo scanner lessicale, non un parser: i
 * guard devono sapere quali file seguire senza eseguire il grafo dei moduli.
 * La scelta e' fail-open: se un literal non si puo' distinguere con certezza
 * dal codice, il suo testo non conta come specificatore; le interpolazioni
 * `${...}` restano invece codice e vengono percorse. Tutti i consumer del
 * ciclo usano questa sorgente unica (#1029, #1033).
 */

/**
 * Sorgenti regex per i consumer che devono ispezionare una forma specifica.
 * Le factory, invece di un literal globale /g, evitano di condividere
 * lastIndex fra scansioni indipendenti.
 */
export const STATIC_IMPORT_SOURCE =
  "^[ \\t]*(?:import\\b\\s*(?:[^'\";]*?\\bfrom\\s*)?|export\\b[^'\";]*?\\bfrom\\s*)(['\"])([^'\"]+)\\1";
export const DYNAMIC_IMPORT_SOURCE =
  "(?<![\\p{L}\\p{N}_$.])import\\s*\\(\\s*(['\"])([^'\"]+)\\1";

export const staticImportRe = () => new RegExp(STATIC_IMPORT_SOURCE, 'gmu');
export const dynamicImportRe = () => new RegExp(DYNAMIC_IMPORT_SOURCE, 'gu');

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

function skipTrivia(src, at) {
  while (at < src.length) {
    while (at < src.length && /\s/u.test(src[at])) at += 1;
    if (src.startsWith('//', at)) {
      const nl = src.indexOf('\n', at + 2);
      at = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (src.startsWith('/*', at)) {
      const end = src.indexOf('*/', at + 2);
      at = end < 0 ? src.length : end + 2;
      continue;
    }
    break;
  }
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
    if (src[i] === "'" || src[i] === '"' || src[i] === String.fromCharCode(96)) {
      i = skipQuoted(src, i, src[i]) - 1;
      continue;
    }
    if (src[i] === ';') return null;
    if (wordAt(src, i, 'from')) {
      return quotedValue(src, skipTrivia(src, i + 4));
    }
    if (wordAt(src, i, 'import') || wordAt(src, i, 'export')) return null;
  }
  return null;
}

/** Salta la parte testuale di un template, scandendo solo le sue espressioni. */
function skipTemplate(src, at, found) {
  for (let i = at + 1; i < src.length;) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === String.fromCharCode(96)) return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') {
      i = scanCode(src, i + 2, found, true);
      continue;
    }
    i += 1;
  }
  return src.length;
}

/**
 * Scandisce codice JavaScript fino alla fine del sorgente o della graffa che
 * chiude un'interpolazione `${...}`. Le graffe annidate impediscono a un
 * oggetto nell'espressione di chiudere il template troppo presto.
 */
function scanCode(src, at, found, stopAtClosingBrace = false) {
  let braceDepth = 0;
  for (let i = at; i < src.length;) {
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
    if (src[i] === "'" || src[i] === '"') {
      i = skipQuoted(src, i, src[i]);
      continue;
    }
    if (src[i] === String.fromCharCode(96)) {
      i = skipTemplate(src, i, found);
      continue;
    }
    if (stopAtClosingBrace && src[i] === '}' && braceDepth === 0) return i + 1;
    if (src[i] === '{') {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (src[i] === '}' && braceDepth > 0) {
      braceDepth -= 1;
      i += 1;
      continue;
    }

    let keyword = null;
    if (wordAt(src, i, 'import')) keyword = 'import';
    else if (wordAt(src, i, 'export')) keyword = 'export';
    if (!keyword) { i += 1; continue; }

    const next = skipTrivia(src, i + keyword.length);
    if (keyword === 'import' && src[next] === '(') {
      const value = quotedValue(src, skipTrivia(src, next + 1));
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
  return src.length;
}

/**
 * Restituisce tutti gli specificatori statici e dinamici, nell'ordine in cui
 * compaiono e con i duplicati conservati.
 */
export function importSpecifiers(source) {
  const src = String(source || '');
  const found = [];
  scanCode(src, 0, found);
  return found.sort((a, b) => a.at - b.at).map(({ specifier }) => specifier);
}

/** Solo gli specificatori relativi: pacchetti e builtin non stanno nell'albero. */
export const relativeImportSpecifiers = (source) =>
  importSpecifiers(source).filter((specifier) => specifier.startsWith('.'));
