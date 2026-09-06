/**
 * ts-literals.mjs — localizzare un letterale dentro un sorgente TS, senza
 * euristiche di testo.
 *
 * ## Perché esiste
 *
 * Sia `scripts/retire-article.mjs` sia `generator/scripts/create-article.mjs`
 * riscrivono a mano l'array piatto degli id (`ALL_BLOG_ARTICLE_IDS`) dentro
 * `content/routerBlogData.ts`. Entrambi lo localizzavano con due euristiche che
 * sembrano equivalenti a una scansione vera e non lo sono:
 *
 *   - **l'inizio**, cercato per NOME (`\b<varName>\b[^=]*=\s*\[`). `[^=]`
 *     comprende il newline, quindi una qualunque MENZIONE del nome — un
 *     commento «aggiungi l'id anche a ALL_BLOG_ARTICLE_IDS» venti righe sopra —
 *     apre il match, che poi scavalla fino al primo `= [` successivo: la
 *     finestra parte da un array che non è quello, e la riscrittura corrompe il
 *     file. L'unico backstop era l'exit code.
 *   - **la fine**, cercata come primo `];` letterale. Un array chiuso
 *     `] as const;`, o formattato su più righe con la parentesi rientrata, non
 *     ha un `];` lì: `indexOf` scavalla al `];` di un array successivo e il
 *     taglio cade nel punto sbagliato.
 *
 * Non è ipotetico: è esattamente il difetto misurato su `BORDER_WAIT_CROSSINGS`
 * in `generator/tests/rewire-json-contracts.test.mjs` (finestra da 166 token
 * invece di 134, per gli STESSI due estremi sbagliati). Qui la posta è più
 * alta, perché quei due chiamanti non leggono il file: lo riscrivono.
 *
 * Da qui la sorgente unica (AGENTS.md #6): l'ancora è la DICHIARAZIONE e sta su
 * una riga sola, la fine è la parentesi che chiude davvero quella di apertura.
 */

/** `apertura → chiusura`, per `matchingDelimiter`. */
const CLOSING = { '{': '}', '[': ']', '(': ')' };

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Trova il delimitatore che chiude quello a `openIdx`, ignorando ciò che sta
 * dentro stringhe e commenti. Restituisce `-1` se non chiude.
 *
 * Deve seguire TUTTI E TRE i delimitatori di stringa — `'`, `"` e il backtick —
 * e non solo l'apice singolo con cui sono scritte le chiavi. I blocchi
 * `structuredData` dei file SEO sono JSON con le chiavi fra doppi apici, e i
 * loro valori contengono apostrofi italiani (`"description": "…un'autostrada…"`).
 * Seguendo il solo apice singolo, quell'apostrofo apre una stringa che non si
 * chiude più, tutte le graffe successive vengono ignorate e la funzione
 * restituisce una `}` interna: il blocco viene troncato a metà e il file resta
 * con una `},` orfana. Non è ipotetico — è successo al primo giro su
 * `content/seo/seo-blog-ch.ts`, e `tsx` lo ha rifiutato con
 * «Expected identifier» sulla chiave successiva.
 *
 * I commenti sono saltati per la stessa ragione, un giro prima che morda: un
 * `// l'array è append-only` fra le voci apre una stringa che non si chiude, e
 * questi file di corpus i commenti li hanno (`content/blog-articles-data.ts`,
 * `content/routerBlogData.ts`, `content/seo/seo-blog.ts`).
 */
export function matchingDelimiter(src, openIdx) {
  const open = src[openIdx];
  const close = CLOSING[open];
  if (!close) throw new Error(`matchingDelimiter: '${open}' non è un delimitatore di apertura`);
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * La finestra del letterale `<const> <varName> … = [ … ]`, o `null` se il file
 * non lo dichiara COME letterale.
 *
 * `null` non vuol dire «non c'è il nome»: la sezione svizzera deriva il suo
 * elenco (`export const ALL_SWISS_ARTICLE_IDS = Object.keys(SWISS_SLUGS)`), e
 * lì non c'è niente da riscrivere. È per questo che l'ancora pretende `= [`
 * attaccato alla dichiarazione: distingue il letterale dal derivato.
 *
 * L'ancora è confinata alla riga della dichiarazione (`[^=\n]*`, non `[^=]*`),
 * così una menzione del nome in un commento non può aprire una finestra che
 * poi scavalla su un altro assegnamento.
 *
 * @returns {{declStart: number, openIdx: number, closeIdx: number} | null}
 */
export function findIdListLiteralSpan(src, varName) {
  const declRx = new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(varName)}\\b[^=\\n]*=\\s*\\[`);
  const m = declRx.exec(src);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = matchingDelimiter(src, openIdx);
  if (closeIdx === -1) throw new Error(`array ${varName}: la '[' della dichiarazione non si chiude — sorgente troncata?`);
  return { declStart: m.index, openIdx, closeIdx };
}

/**
 * Rimuove `'<id>'` da un array letterale piatto (`export const <varName> = [...]`).
 * Opera solo sul corpo fra la sua `[` di apertura e la `]` che la chiude, per
 * non rischiare di toccare un'altra occorrenza dell'id altrove nel file.
 */
export function removeFromIdListLiteral(src, varName, id) {
  const span = findIdListLiteralSpan(src, varName);
  if (!span) {
    // Il chiamante ha chiesto questo array perché la sua sezione ce l'ha: se il
    // nome è nel file ma non come letterale, la forma è cambiata sotto i piedi.
    // Tacere qui significa lasciare l'id nell'elenco e accorgersene solo al
    // passo 12, a scritture già fatte — cioè una RIMOZIONE PARZIALE, che è il
    // caso peggiore di tutti (vedi l'intestazione di retire-article.mjs).
    if (new RegExp(`\\b${escapeRegex(varName)}\\b`).test(src)) {
      throw new Error(`array ${varName}: il nome compare nel file ma non come dichiarazione '<const> ${varName} … = [' — la forma è cambiata, va riscritta l'ancora (non allentata)`);
    }
    return { changed: false, src };
  }
  const before = src.slice(0, span.openIdx + 1);
  const body = src.slice(span.openIdx + 1, span.closeIdx);
  const after = src.slice(span.closeIdx);
  const escaped = escapeRegex(id);
  let newBody;
  if (new RegExp(`'${escaped}',\\s*`).test(body)) {
    newBody = body.replace(new RegExp(`'${escaped}',\\s*`), '');
  } else if (new RegExp(`,\\s*'${escaped}'`).test(body)) {
    newBody = body.replace(new RegExp(`,\\s*'${escaped}'`), '');
  } else if (new RegExp(`^\\s*'${escaped}'\\s*$`).test(body)) {
    newBody = '';
  } else {
    return { changed: false, src };
  }
  return { changed: true, src: before + newBody + after };
}
