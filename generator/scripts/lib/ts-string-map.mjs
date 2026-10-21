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

/**
 * Decodifica il letterale TS che comincia a `i` (apice singolo, doppio o
 * backtick). I template interpolati non sono valori statici: fanno fallire
 * l'intera lettura prima che un backtick annidato possa restituire testo
 * parziale.
 */
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
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      throw new Error('Interpolated template literal is not supported in static TS string map');
    }
    if (c === quote) return { value: out, end: j + 1 };
    out += c;
    j += 1;
  }
  return null;
}

/** Tutte le coppie `'chiave': <letterale>` di un sorgente TS di stringhe. */
export function readTsStringMap(src) {
  const out = new Map();
  const rx = /(['"])(blog\.article\.[^'"]+)\1\s*:\s*/gu;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const lit = readTsStringLiteral(src, m.index + m[0].length);
    if (!lit) continue;
    out.set(m[2], lit.value);
    rx.lastIndex = lit.end;
  }
  return out;
}
