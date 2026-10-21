/**
 * Lettore dei sorgenti TS di stringhe del corpus (i body in `content/blog-body`
 * e `content/blog-body-ch`, i meta): un solo decodificatore per ogni script che ha bisogno
 * del VALORE di un campo `blog.article.<id>.<campo>` senza un parser TS.
 *
 * I due backfill del registry (`backfill-article-cantons.mjs` e
 * `backfill-article-type.mjs`) ne avevano una copia ciascuno, identica riga per
 * riga: due copie di un decodificatore di escape possono divergere e leggere
 * body diversi dallo stesso file (review della PR 2312). La storia di
 * `unescape-ts-string.mjs`, qui accanto, e' la stessa classe di difetto gia'
 * pagata due volte: tre catene di `.replace()` indipendenti, due rotte.
 *
 * Senza dipendenze: i content gate di `main` girano senza `npm ci`.
 * Il decoder copre anche le forme esadecimali `\\xNN` e Unicode code-point
 * `\\u{...}`: un URL scritto con una di queste forme deve arrivare al parser
 * esattamente come il valore che il compilatore TS consegna a runtime.
 */

function hexCodePoint(raw) {
  if (!/^[0-9a-fA-F]+$/u.test(raw)) return null;
  const value = Number.parseInt(raw, 16);
  return value <= 0x10FFFF ? value : null;
}

/** Decodifica un letterale TS statico che comincia a `i` (apice singolo, doppio o backtick). */
export function readTsStringLiteral(src, i) {
  const quote = src[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let out = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === 'v') out += '\v';
      else if (n === '0' && !/[0-9]/u.test(src[j + 2] || '')) out += '\0';
      else if (n === 'x' && /^[0-9a-fA-F]{2}$/u.test(src.slice(j + 2, j + 4))) {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
        j += 4;
        continue;
      } else if (n === 'u' && src[j + 2] === '{') {
        const close = src.indexOf('}', j + 3);
        const codePoint = close === -1 ? null : hexCodePoint(src.slice(j + 3, close));
        if (codePoint !== null && codePoint !== undefined) {
          out += String.fromCodePoint(codePoint);
          j = close + 1;
          continue;
        }
        out += n;
      } else if (n === 'u' && /^[0-9a-fA-F]{4}$/u.test(src.slice(j + 2, j + 6))) {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
        j += 6;
        continue;
      } else out += n ?? '';
      j += 2;
      continue;
    }
    if (c === quote) return { value: out, end: j + 1 };
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      throw new Error('Interpolated template literal is not supported in static article fields');
    }
    out += c;
    j += 1;
  }
  return null;
}

/**
 * Tokenizza il sottoinsieme lessicale usato dai moduli dati del corpus. I commenti
 * non producono token; ogni letterale resta un singolo token. Un'interpolazione
 * in qualunque template del file rende il sorgente non statico, quindi si rifiuta
 * il file intero prima di estrarre qualsiasi chiave.
 */
function staticSourceTokens(src) {
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (/\s/u.test(c)) {
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated comment in static article source');
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const literal = readTsStringLiteral(src, i);
      if (!literal) throw new Error('Unterminated string literal in static article source');
      tokens.push({ type: 'string', value: literal.value });
      i = literal.end;
      continue;
    }

    // Keep every significant source character so a key only matches an actual
    // adjacent `string : string` property, not text spanning intervening code.
    tokens.push({ type: 'punctuation', value: c });
    i += 1;
  }

  return tokens;
}

/**
 * Le chiavi fra parentesi quadre sono espressioni, anche quando contengono un
 * solo letterale. Non possono quindi contribuire a una mappa statica: se le
 * ignorassimo, il chiamante riceverebbe una mappa parziale. La stessa guardia
 * copre i metodi e gli accessor con chiave computata.
 */
function assertNoComputedPropertyKeys(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'punctuation' || token.value !== '[') continue;

    const previous = tokens[i - 1];
    const startsProperty = !previous || (
      previous.type === 'punctuation' && (previous.value === '{' || previous.value === ',')
    );

    let depth = 1;
    let end = i + 1;
    while (end < tokens.length && depth > 0) {
      const current = tokens[end];
      if (current.type === 'punctuation' && current.value === '[') depth += 1;
      if (current.type === 'punctuation' && current.value === ']') depth -= 1;
      end += 1;
    }
    if (depth !== 0) throw new Error('Unterminated computed article map key');

    const next = tokens[end];
    const afterOptionalMarker = next?.type === 'punctuation' && next.value === '?'
      ? tokens[end + 1]
      : next;
    if (!startsProperty && !(afterOptionalMarker?.type === 'punctuation' && afterOptionalMarker.value === '(')) {
      continue;
    }
    if (afterOptionalMarker?.type === 'punctuation' && afterOptionalMarker.value === ':') {
      throw new Error('Computed article map keys are not supported in static article sources');
    }
    if (afterOptionalMarker?.type === 'punctuation' && afterOptionalMarker.value === '(') {
      throw new Error('Computed article map methods and accessors are not supported in static article sources');
    }
  }
}

/** Rifiuta membri che il lettore non puo' materializzare senza eseguire codice. */
function assertNoDynamicObjectMembers(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    const nextNext = tokens[i + 2];

    if (token.type === 'punctuation' && token.value === '.' &&
      next?.type === 'punctuation' && next.value === '.' &&
      nextNext?.type === 'punctuation' && nextNext.value === '.') {
      throw new Error('Spread members are not supported in static article sources');
    }

    if (token.type === 'string' && token.value.startsWith('blog.article.') &&
      next?.type === 'punctuation' && next.value === '(') {
      throw new Error('Article map methods and accessors are not supported in static article sources');
    }
  }
}

/** Tutte le coppie `'chiave': <letterale>` di un sorgente TS di stringhe. */
export function readTsStringMap(src) {
  const tokens = staticSourceTokens(src);
  assertNoDynamicObjectMembers(tokens);
  assertNoComputedPropertyKeys(tokens);
  const out = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const key = tokens[i];
    const separator = tokens[i + 1];
    if (key.type !== 'string' || !key.value.startsWith('blog.article.') || !separator ||
      separator.type !== 'punctuation' || separator.value !== ':') continue;
    const value = tokens[i + 2];
    if (!value || value.type !== 'string') {
      throw new Error(`Non-static value for article field ${key.value}`);
    }

    const end = tokens[i + 3];
    if (end && !(end.type === 'punctuation' && (end.value === ',' || end.value === '}'))) {
      throw new Error(`Unexpected token after static article field ${key.value}`);
    }

    out.set(key.value, value.value);
    i += 2;
  }
  return out;
}
