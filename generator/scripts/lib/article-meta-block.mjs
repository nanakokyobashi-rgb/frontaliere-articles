/**
 * Emissione del BLOCCO META di un articolo: le righe
 * `'blog.article.<id>.<campo>': '<valore>'` che vengono appese a
 * `content/blog-meta-<locale>.ts` (sul sito: `services/locales/...`), una volta
 * per ognuna delle quattro locali.
 *
 * ## Perche' e' un modulo a se' e non piu' una funzione dentro create-article.mjs
 *
 * Quel blocco e' l'UNICO punto in cui il corpus decide quali campi per-locale
 * escono dalla generazione e diventano superficie pubblica: `build-api.mjs`
 * serializza il default export di `blog-meta-<locale>.ts` senza filtrare
 * niente (`write(\`meta-${loc}.json\`, meta)`), quindi un campo che non passa
 * di qui non esiste per nessun consumatore, per quanto sia stato scritto e
 * testato a monte. E' esattamente cosi' che le `seoDescription` localizzate
 * della PR #83 sono rimaste invisibili: nate corrette in
 * `generator/scripts/lib/daily-brief-content.mjs`, misurate da
 * `daily-brief-content.test.mjs` in tutte e quattro le locali, e mai emesse —
 * `meta-en.json` pubblicato esponeva 3141 `title`, 3141 `excerpt`, 3141
 * `imageAlt` e zero `seoDescription`.
 *
 * Una funzione privata dentro un file da 11 000 righe che importa `jsdom` non
 * e' testabile con `node --test` (nessun `node_modules` qui): il difetto sopra
 * poteva vivere per sempre dietro una suite verde perche' nessun test poteva
 * vedere l'emettitore. Qui invece si importa in tre righe.
 *
 * ## L'ordine dei campi e' un contratto
 *
 * `title`, `excerpt`, `imageAlt` restano nell'ordine storico e nelle stesse
 * posizioni: per un articolo che non porta i due campi SEO l'output di questo
 * modulo e' byte-identico a quello della versione precedente. E' cio' che rende
 * il cambio ADDITIVO — i lettori esistenti (`metaFieldRegex`,
 * `engine/shared/articleReaders.ts`, `engine/rssFeeds.mjs`,
 * `engine/ogPagesPlugin.ts`) cercano un campo per NOME, e una chiave in piu' e'
 * inerte per tutti.
 *
 * Il significato di `excerpt` non cambia: resta il testo che l'utente LEGGE
 * (card, rail correlati, newsletter, ~250-280 caratteri). `seoDescription` non
 * lo sostituisce, gli si affianca — collassare i due e' il difetto #79/#80,
 * dove il budget della SERP e' diventato il tetto di cio' che il lettore poteva
 * vedere.
 *
 * ## Chi lo consuma dall'altra parte
 *
 * Nessuno, ancora: `engine/ogPagesPlugin.ts` (che vive nel repo del SITO e
 * scende qui col mirror) riconosce solo `title|excerpt|imageAlt` e ricava la
 * meta description di en/de/fr dall'excerpt della locale troncato a 155. La
 * meta' engine e' una PR gemella sul sito. Emettere il campo PRIMA e' l'ordine
 * giusto: il campo in piu' e' inerte finche' non viene letto, mentre un lettore
 * che cerca un campo non ancora emesso legge `undefined` e cade sul fallback
 * senza dirlo a nessuno.
 */

/**
 * I campi storici. Emessi nell'ordine, sempre per primi: la posizione fa parte
 * del contratto di retrocompatibilita' descritto sopra.
 */
export const META_CORE_FIELDS = Object.freeze(['title', 'excerpt', 'imageAlt']);

/**
 * I due campi che la versione precedente emetteva SEMPRE, anche vuoti
 * (`escapeForSingleQuoteTS(undefined)` restituisce `''`). Restano incondizionati
 * apposta: `imageAlt` era gia' condizionale (`if (alt)`), e cambiare la
 * condizionalita' di `title`/`excerpt` non sarebbe additivo — toglierebbe una
 * chiave che `scripts/check-orphan-article-meta` del sito usa per distinguere
 * «entry parziale» da «entry assente».
 */
const META_ALWAYS_EMITTED = Object.freeze(['title', 'excerpt']);

/**
 * I campi descrittivi introdotti dalla separazione delle tre superfici (#83):
 * `seoDescription` e' cio' che Google mostra (150-160), `ogDescription` cio'
 * che Facebook/LinkedIn/WhatsApp mostrano (200-250). Opzionali per costruzione:
 * li scrive solo un content builder che sa scriverli per la propria locale
 * (oggi il Bollettino del Frontaliere), e per tutti gli altri articoli il
 * consumatore continua a cadere sull'excerpt.
 */
export const META_SEO_FIELDS = Object.freeze(['seoDescription', 'ogDescription']);

/** Tutti i campi che questo modulo puo' emettere, nell'ordine di emissione. */
export const META_FIELDS = Object.freeze([...META_CORE_FIELDS, ...META_SEO_FIELDS]);

/**
 * Escape di un valore dentro una stringa TS a singoli apici.
 *
 * Viveva in `create-article.mjs`; sta qui perche' e' la meta' inseparabile
 * dell'emissione — un campo nuovo emesso senza il suo escape produce un file
 * `.ts` che non compila, e il test che pinna il campo deve poter verificare
 * ANCHE l'escape. Stessa ragione per cui `metaFieldRegex` (il lettore) e' un
 * modulo suo: la coppia scrittore/lettore va tenuta sotto lo stesso sguardo.
 */
export function escapeForSingleQuoteTS(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

/**
 * Il valore di un campo per una locale, cercato nei due posti in cui i
 * generatori di questo repo tengono i testi per-locale:
 *
 *   `data.content[locale][field]`  — dove stanno title/excerpt e i body
 *   `data[field][locale]`          — dove sta imageAlt (mappa per locale)
 *
 * La regola di presenza NON e' unica: e' quella che aveva ciascun campo nel
 * vecchio `buildMetaBlock` dentro `create-article.mjs`, prima che questo modulo
 * lo sostituisse (#117).
 *
 *   - `title`/`excerpt` (META_ALWAYS_EMITTED): il vecchio codice non faceva
 *     ALCUN controllo di presenza — usava `c.title`/`c.excerpt` cosi' come
 *     stavano, `escapeForSingleQuoteTS` collassava solo `undefined`/`null`/`''`
 *     a stringa vuota. Un valore whitespace-only era truthy e usciva intatto.
 *   - `imageAlt`: il vecchio codice era `if (alt)` — falsy solo sulla stringa
 *     vuota, quindi whitespace-only era gia' sufficiente per emetterlo.
 *   - `seoDescription`/`ogDescription` (META_SEO_FIELDS, nuovi con #117): qui
 *     il trim e' voluto, non un refuso — un valore whitespace-only e' trattato
 *     come assente ed e' cio' che pinna il test "un campo vuoto o assente non
 *     produce una chiave vuota".
 *
 * Trattarli tutti con lo stesso trim (come faceva una versione precedente di
 * questa funzione) rompeva il claim "byte-identico a prima" per title/excerpt/
 * imageAlt whitespace-only: un caso degenere, ma la garanzia di
 * retrocompatibilita' vale anche li'.
 */
function readLocaleField(data, locale, field) {
  const isAlwaysEmitted = META_ALWAYS_EMITTED.includes(field);
  const isSeoField = META_SEO_FIELDS.includes(field);
  for (const raw of [data?.content?.[locale]?.[field], data?.[field]?.[locale]]) {
    if (typeof raw !== 'string') continue;
    if (isAlwaysEmitted) return raw;
    if (isSeoField) {
      if (raw.trim() !== '') return raw;
    } else if (raw !== '') {
      return raw;
    }
  }
  return null;
}

/**
 * Le righe del blocco meta per una locale, gia' indentate e con la virgola
 * finale, pronte per essere appese al file della locale.
 *
 * @param {{ id: string, content?: Record<string, Record<string, unknown>> }} data
 * @param {'it'|'en'|'de'|'fr'} locale
 * @returns {string[]}
 */
export function buildMetaBlockLines(data, locale) {
  const id = data?.id;
  if (!id) throw new Error('buildMetaBlockLines: data.id mancante');
  if (!data?.content?.[locale]) {
    throw new Error(`buildMetaBlockLines: data.content['${locale}'] mancante per '${id}'`);
  }
  const lines = [];
  for (const field of META_FIELDS) {
    const value = readLocaleField(data, locale, field);
    if (value === null && !META_ALWAYS_EMITTED.includes(field)) continue;
    lines.push(`    'blog.article.${id}.${field}': '${escapeForSingleQuoteTS(value)}',`);
  }
  return lines;
}

/** Il blocco meta di una locale come testo, una riga per campo. */
export function buildMetaBlock(data, locale) {
  return buildMetaBlockLines(data, locale).join('\n');
}
