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
 */

/** Decodifica il letterale TS che comincia a `i` (apice singolo, doppio o backtick). */
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
      else if (n === 'u' && /^[0-9a-fA-F]{4}$/u.test(src.slice(j + 2, j + 6))) {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
        j += 6;
        continue;
      } else out += n ?? '';
      j += 2;
      continue;
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
