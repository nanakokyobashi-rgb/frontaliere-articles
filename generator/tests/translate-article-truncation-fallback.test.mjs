/**
 * translate-article-truncation-fallback.test.mjs — un fallback IT vuoto non
 * deve sovrascrivere un body tradotto troncato-ma-presente (#686).
 *
 * IL DIFETTO. Nel loop di truncation-retry di `translateArticle()`, quando
 * `detectTruncation()` segnala un body EN/DE/FR troncato e il retry mirato
 * fallisce (o resta troncato), il codice eseguiva incondizionatamente
 * `data.content[locale][field] = itValue` con `itValue = itContent[field]`,
 * senza controllare che fosse non-vuoto. Il ramo missing-field poco sopra
 * valida solo il caso "campo assente" (`if (hasUsableContentText(data.content
 * [locale][field])) continue;`), quindi questo loop parte già da un campo
 * con contenuto utilizzabile — può
 * arrivare al fallback con `itValue` vuoto/assente senza che nulla l'abbia
 * intercettato prima. Risultato: il fallback sostituiva un body tradotto
 * troncato con una stringa vuota/undefined, peggiorando la superficie
 * pubblicata invece di ripararla.
 *
 * IL FIX. Guardia esplicita immediatamente prima dell'assegnazione di
 * fallback: se `itValue` è vuoto/undefined, non sovrascrivere il campo —
 * resta il valore tradotto troncato, con un warning esplicito.
 *
 * DA #1875 (causa B) un `bodyN` non riceve PIU' il valore italiano, in
 * nessuno dei due loop: quando free-MT e retry LLM falliscono il campo resta
 * ASSENTE dal locale (`markBodyTranslationPending`), che e' il marker di
 * traduzione in attesa. Il fallback IT resta solo su title/excerpt/FAQ, e i
 * test #705 sul fallback IT troncato lo esercitano su quei campi.
 *
 * COME GIRA. Il blocco del loop è ritagliato VERBATIM dal sorgente ed
 * eseguito con `new Function`, iniettando `detectTruncation`,
 * `callWithRetry`, `translatedStringOrNull` e `sanitizeBodyText` mockati —
 * la stessa tecnica di create-article-wall-budget.test.mjs e
 * body2-expected-fields.test.mjs: create-article.mjs non è importabile dalle
 * gate del generatore (niente `npm ci`, niente jsdom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSectionFeeds, RSS_SECTIONS } from '../../engine/rssFeeds.mjs';
import { escapeForSingleQuoteTS, META_SEO_FIELDS } from '../scripts/lib/article-meta-block.mjs';
import { decodeHtmlEntities } from '../scripts/lib/decode-html-entities.mjs';
// I predicati sono quelli VERI, non una copia: `translatedStringOrNull` e'
// esattamente la funzione che il loop ritagliato riceve in produzione, e una
// copia locale nel test divergerebbe in silenzio dal fix (AGENTS.md #6).
import { translatedStringOrNull, isSourcePassthrough, joinTranslatedChunks, translateFieldFreeMt } from '../scripts/lib/article-free-mt.mjs';
import { hasUsableContentText, hasUsableTranslatedText, metaFieldPlausibilityMiss } from '../scripts/lib/body2-payload-verdict.mjs';
import {
  createFreeMtRecoveryReport,
  claimFreeMtLlmFallback,
  recordFreeMtUnusableOutput,
  wasFreeMtUnusable,
  maxFreeMtLlmFallbacksPerLocale,
  MAX_FREE_MT_LLM_FALLBACKS_PER_RUN,
  MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE,
  markBodyTranslationPending,
  isBodyTranslationPending,
  pendingBodyTranslations,
} from '../scripts/lib/free-mt-recovery.mjs';

// Riempitivo dei campi meta nelle fixture. NON e' un dettaglio di stile: dal
// floor di plausibilita' (#798) il loop missing-field giudica anche `title` e
// `excerpt`, quindi un segnaposto di un carattere farebbe partire un retry
// mirato che questi test non stanno misurando. Le fixture portano meta
// plausibili; l'oggetto dei test — `"null"`, il «Null» tedesco, il fallback IT
// — resta esattamente lo stesso.
const META_PLAUSIBILI = {
  title: 'Titolo di prova plausibile',
  excerpt: 'Un riassunto di prova abbastanza lungo.',
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

/** Ritaglia il loop di truncation-retry di `translateArticle()` VERBATIM. */
function extractTruncationRetryLoop() {
  const marker = '`${locale}:${field}-truncation-retry`,';
  const m = src.indexOf(marker);
  assert.notEqual(m, -1, 'marker non trovato — aggiornare questo test');
  const startAnchor = "for (const locale of ['en', 'de', 'fr']) {";
  const a = src.lastIndexOf(startAnchor, m);
  assert.notEqual(a, -1, 'inizio del loop non trovato');
  const endAnchor = '\n  // Detect untranslated title/excerpt';
  const e = src.indexOf(endAnchor, m);
  assert.notEqual(e, -1, 'fine del loop non trovata');
  const block = src.slice(a, e);
  assert.ok(block.includes('detectTruncation'), 'il ritaglio non contiene detectTruncation: anchor sbagliata');
  assert.ok(block.includes('if (!itValue?.trim()) {'), 'il ritaglio non contiene la guardia del fix (#686/#691): anchor sbagliata');
  return block;
}

const LOOP_SRC = extractTruncationRetryLoop();

/**
 * Ritaglia il loop missing-field VERBATIM (gemello, simmetrico, del loop di
 * truncation-retry sopra): stesso antipattern `!itValue`, stesso fix
 * `!itValue?.trim()` (#691).
 */
function extractMissingFieldLoop() {
  const marker = '`${locale}:${recoveryField}-missing-retry`,';
  const m = src.indexOf(marker);
  assert.notEqual(m, -1, 'marker non trovato — aggiornare questo test');
  const startAnchor = "for (const locale of ['en', 'de', 'fr']) {";
  const a = src.lastIndexOf(startAnchor, m);
  assert.notEqual(a, -1, 'inizio del loop non trovato');
  const endAnchor = '\n  // Detect a translated body field cut off mid-sentence';
  const e = src.indexOf(endAnchor, m);
  assert.notEqual(e, -1, 'fine del loop non trovata');
  const block = src.slice(a, e);
  assert.ok(block.includes('mancante nella traduzione'), 'il ritaglio non contiene il ramo missing-field: anchor sbagliata');
  assert.ok(block.includes('if (!itValue?.trim()) {'), 'il ritaglio non contiene la guardia del fix (#691): anchor sbagliata');
  return block;
}

const MISSING_FIELD_LOOP_SRC = extractMissingFieldLoop();

/**
 * Esegue il loop missing-field ritagliato, stessa tecnica del loop sopra.
 * `detectTruncation` di default segnala sempre "pulito": i test che non lo
 * passano esplicitamente non esercitano il ramo warning IT-esso-stesso-troncato
 * (#705). `warnings` raccoglie i messaggi di `console.warn` per assert.
 */
async function runMissingFieldLoop({ data, itContent, callWithRetry, detectTruncation, warnings = [], translationReport, freeMt = true }) {
  const capturingConsole = { error: () => {}, warn: (msg) => warnings.push(msg) };
  const RUN_REPORT = { translation: translationReport || createFreeMtRecoveryReport() };
  // `markBodyTranslationPending` e' quello VERO (#1875): e' lui a decidere che
  // il body resta assente invece di ricevere l'italiano, e un mock qui non
  // proverebbe quel comportamento.
  const fn = new Function(
    'data', 'itContent', 'callWithRetry', 'translatedStringOrNull', 'hasUsableTranslatedText', 'metaFieldPlausibilityMiss', 'detectTruncation', 'console',
    'ARTICLE_TRANSLATE_FREE_MT', 'claimFreeMtLlmFallback', 'wasFreeMtUnusable', 'maxFreeMtLlmFallbacksPerLocale', 'RUN_REPORT', 'MAX_FREE_MT_LLM_FALLBACKS_PER_RUN', 'MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE',
    'markBodyTranslationPending', 'isSourcePassthrough',
    `return (async () => { ${MISSING_FIELD_LOOP_SRC} })();`,
  );
  // `metaFieldPlausibilityMiss` e' il floor VERO (#798), non un mock: il ramo
  // floor-miss del loop tiene il valore tradotto invece di cadere sul fallback
  // IT, e un mock qui non proverebbe quel comportamento.
  await fn(data, itContent, callWithRetry, translatedStringOrNull, hasUsableTranslatedText, metaFieldPlausibilityMiss, detectTruncation || (() => []), capturingConsole, freeMt, claimFreeMtLlmFallback, wasFreeMtUnusable, maxFreeMtLlmFallbacksPerLocale, RUN_REPORT, MAX_FREE_MT_LLM_FALLBACKS_PER_RUN, MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE, markBodyTranslationPending, isSourcePassthrough);
  return RUN_REPORT;
}

/**
 * Legge `TRANSLATION_CHUNK_THRESHOLD` dal sorgente invece di duplicarlo come
 * costante nel test (AGENTS.md #6: un valore condiviso ha una sola sorgente):
 * se la soglia cambia in create-article.mjs, questo test la segue.
 */
function extractTranslationChunkThreshold() {
  const m = src.match(/const TRANSLATION_CHUNK_THRESHOLD = (\d+);/);
  assert.ok(m, 'TRANSLATION_CHUNK_THRESHOLD non trovato nel sorgente — aggiornare questo test');
  return Number(m[1]);
}

const TRANSLATION_CHUNK_THRESHOLD = extractTranslationChunkThreshold();

/**
 * Esegue il loop ritagliato dentro una funzione async iniettando i mock come
 * variabili di chiusura (stessa forma delle dipendenze reali di
 * `translateArticle`: `detectTruncation`, `callWithRetry`, `translateInChunks`,
 * `TRANSLATION_CHUNK_THRESHOLD`, `translatedStringOrNull`, `sanitizeBodyText`,
 * `countWords`, `console`).
 */
async function runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry, translateInChunks, warnings = [], translationReport }) {
  const sanitizeBodyText = (v) => v;
  const countWords = (s) => String(s).split(/\s+/).filter(Boolean).length;
  const capturingConsole = { error: () => {}, warn: (msg) => warnings.push(msg) };
  const noopTranslateInChunks = async () => {
    throw new Error('translateInChunks chiamato senza mock — il test non lo aspettava per un campo sotto soglia');
  };
  const RUN_REPORT = { translation: translationReport || createFreeMtRecoveryReport() };
  const fn = new Function(
    'data', 'itContent', 'detectTruncation', 'callWithRetry', 'translateInChunks',
    'TRANSLATION_CHUNK_THRESHOLD', 'translatedStringOrNull', 'sanitizeBodyText', 'countWords', 'console',
    'markBodyTranslationPending', 'RUN_REPORT', 'isSourcePassthrough',
    `return (async () => { ${LOOP_SRC} })();`,
  );
  await fn(
    data, itContent, detectTruncation, callWithRetry, translateInChunks || noopTranslateInChunks,
    TRANSLATION_CHUNK_THRESHOLD, translatedStringOrNull, sanitizeBodyText, countWords, capturingConsole,
    markBodyTranslationPending, RUN_REPORT, isSourcePassthrough,
  );
  return RUN_REPORT;
}

test('itValue vuoto: il body tradotto troncato NON viene sovrascritto (#686)', async () => {
  const data = { content: { en: { body1: 'This sentence never ends and' } } };
  const itContent = { body1: '' };
  // Ogni chiamata a detectTruncation segnala troncamento, sia sul testo
  // iniziale che sul risultato del retry.
  const detectTruncation = () => ['incomplete-ending'];
  // Il retry mirato torna comunque un valore troncato (o fallisce): non deve
  // importare, la guardia scatta comunque perché itValue è vuoto.
  const callWithRetry = async () => ({ body1: 'This sentence never ends and' });

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry });

  assert.equal(
    data.content.en.body1,
    'This sentence never ends and',
    'il body troncato deve restare intatto quando il fallback IT è vuoto',
  );
});

test('itValue assente (undefined): stessa guardia, nessuna sovrascrittura', async () => {
  const data = { content: { de: { body2: 'Dieser Satz hört nie auf und' } } };
  const itContent = {}; // body2 assente del tutto
  const detectTruncation = () => ['incomplete-ending'];
  const callWithRetry = async () => { throw new Error('retry fallito'); };

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry });

  assert.equal(data.content.de.body2, 'Dieser Satz hört nie auf und');
});

test('itValue non-vuoto: retry fallito → body NON tradotto, niente italiano sotto /fr/ (#1875)', async () => {
  const data = { id: 'articolo-prova', content: { fr: { body3: 'Cette phrase ne finit jamais et' } } };
  const itContent = { body3: 'Testo italiano completo.' };
  const detectTruncation = () => ['incomplete-ending'];
  const callWithRetry = async () => { throw new Error('retry fallito'); };

  const report = await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry });

  assert.equal(Object.hasOwn(data.content.fr, 'body3'), false, 'il body3 fr resta assente: e\' il marker di attesa');
  assert.notEqual(data.content.fr.body3, itContent.body3, 'l\'italiano non deve essere pubblicato come body3 fr');
  assert.deepEqual(pendingBodyTranslations(data), [
    { id: 'articolo-prova', locale: 'fr', field: 'body3', reason: 'truncation-retry-error' },
  ]);
  assert.deepEqual(report.translation.pendingBodyFields, { 'fr:body3': 'truncation-retry-error' });
});

test('itValue >700 parole: il retry usa il sub-chunking di translateBodyField invece di una singola chiamata monolitica (#688)', async () => {
  const longIt = Array.from({ length: TRANSLATION_CHUNK_THRESHOLD + 1 }, (_, i) => `parola${i}`).join(' ');
  const data = { content: { en: { body1: 'Truncated sentence and' } } };
  const itContent = { body1: longIt };
  // Troncato al primo giro, pulito dopo il retry mirato.
  const detectTruncation = (text) => (text === 'Truncated sentence and' ? ['incomplete-ending'] : []);
  const callWithRetry = async () => {
    throw new Error('callWithRetry non deve ricevere l\'intero campo lungo in una sola chiamata');
  };
  let translateInChunksCall = null;
  const translateInChunks = async (bodyText, fieldKey, makeChunkPrompt, labelPrefix) => {
    translateInChunksCall = { bodyText, fieldKey, labelPrefix };
    return 'Full English translation, complete.';
  };

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry, translateInChunks });

  assert.ok(translateInChunksCall, 'translateInChunks non è stato chiamato per un body >700 parole');
  assert.equal(translateInChunksCall.bodyText, longIt);
  assert.equal(translateInChunksCall.fieldKey, 'body1');
  assert.equal(
    data.content.en.body1,
    'Full English translation, complete.',
    'il risultato del sub-chunking deve sostituire il body troncato',
  );
});

test('itValue whitespace-only: il body tradotto troncato NON viene sovrascritto (#691)', async () => {
  const data = { content: { en: { body1: 'This sentence never ends and' } } };
  // Un fallback fatto di soli spazi è truthy: senza `.trim()` bypassava il
  // guard (#691, follow-up a #686/#689).
  const itContent = { body1: '   ' };
  const detectTruncation = () => ['incomplete-ending'];
  const callWithRetry = async () => ({ body1: 'This sentence never ends and' });

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry });

  assert.equal(
    data.content.en.body1,
    'This sentence never ends and',
    'il body troncato deve restare intatto quando il fallback IT è whitespace-only',
  );
});

test('ramo missing-field: itValue whitespace-only lancia l\'errore invece di pubblicare un fallback quasi-vuoto (#691)', async () => {
  const data = { content: { en: { body1: undefined, ...META_PLAUSIBILI, body2: 'B2', body3: 'B3' } } };
  // Un fallback fatto di soli spazi è truthy: senza `.trim()` il guard non
  // scattava e il valore quasi-vuoto veniva assegnato invece di lanciare.
  const itContent = { body1: '   ', ...META_PLAUSIBILI, body2: 'B2', body3: 'B3' };
  const callWithRetry = async () => { throw new Error('non dovrebbe essere chiamato: il guard deve lanciare prima'); };

  await assert.rejects(
    () => runMissingFieldLoop({ data, itContent, callWithRetry }),
    /Campo body1 mancante nella traduzione en/,
  );
});

test('nessun troncamento rilevato: il campo non viene toccato', async () => {
  const data = { content: { en: { body1: 'A complete sentence.' } } };
  const itContent = { body1: 'Una frase completa.' };
  const detectTruncation = () => [];
  const callWithRetry = async () => { throw new Error('non dovrebbe essere chiamato'); };

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry });

  assert.equal(data.content.en.body1, 'A complete sentence.');
});

test('ramo truncation-retry: retry ancora troncato → body NON tradotto, l\'italiano (anche troncato) non si pubblica (#1875, era #705)', async () => {
  const truncatedIt = 'Questa frase italiana non finisce e';
  const data = { content: { en: { body1: 'This sentence never ends and' } } };
  const itContent = { body1: truncatedIt };
  // Ogni testo (traduzione iniziale, retry, e la sorgente IT stessa) risulta
  // troncato. Fino a #1875 l'IT veniva pubblicato come «ultima risorsa» con il
  // warning #705; ora l'italiano non si scrive sotto /en/, troncato o no.
  const detectTruncation = () => ['incomplete-ending'];
  const callWithRetry = async () => ({ body1: 'This retried sentence is still cut and' });
  const warnings = [];

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry, warnings });

  assert.equal(Object.hasOwn(data.content.en, 'body1'), false, 'body1 en lasciato non tradotto');
  assert.equal(isBodyTranslationPending(data, 'en', 'body1'), true);
  assert.equal(pendingBodyTranslations(data)[0].reason, 'truncation-retry-unusable');
  assert.ok(
    warnings.some((w) => w.includes('lasciato NON tradotto')),
    `il campo in attesa deve essere segnalato — warnings raccolti: ${JSON.stringify(warnings)}`,
  );
});

test('ramo missing-field: fallback IT esso stesso troncato — warning esplicito, pubblicato come ultima risorsa (#705)', async () => {
  // Da #1875 il fallback IT esiste solo sui campi META: il caso #705 si prova
  // quindi su un `excerpt`, e il body gemello nello stesso articolo resta NON
  // tradotto invece di ricevere l'italiano troncato.
  const truncatedIt = 'Questo campo italiano non finisce e';
  // `de` e `fr` sono già completi: il loop itera su tutte e tre le locali,
  // e senza questi il loop leggerebbe `data.content['de'][field]` su un
  // oggetto undefined non appena passa oltre `en`.
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete, excerpt: undefined, body1: undefined }, de: { ...complete }, fr: { ...complete } } };
  const itContent = { ...META_PLAUSIBILI, excerpt: truncatedIt, body1: 'Corpo italiano anch\'esso tagliato e', body2: 'B2', body3: 'B3' };
  const callWithRetry = async () => { throw new Error('retry fallito'); };
  const detectTruncation = () => ['incomplete-ending'];
  const warnings = [];

  await runMissingFieldLoop({ data, itContent, callWithRetry, detectTruncation, warnings });

  assert.equal(
    data.content.en.excerpt,
    truncatedIt,
    'il fallback IT troncato di un campo meta viene comunque pubblicato come ultima risorsa (nessun fallback migliore disponibile)',
  );
  assert.ok(
    warnings.some((w) => w.includes('ESSO STESSO troncato')),
    `deve emettere un warning esplicito quando anche il fallback IT (campo mancante) risulta troncato — warnings raccolti: ${JSON.stringify(warnings)}`,
  );
  assert.equal(Object.hasOwn(data.content.en, 'body1'), false, 'il body1 en resta NON tradotto, niente italiano (#1875)');
  assert.equal(isBodyTranslationPending(data, 'en', 'body1'), true);
});

// ── La stringa letterale "null" nel percorso di TRADUZIONE (#799) ───────────
//
// Gemello vivo del difetto che #799 chiude sul merge dello split: il gate
// «campo tradotto presente» era una truthiness nuda, e `"null"` — la
// serializzazione che `haiku` produce quando decide di non rispondere — la
// supera. A differenza del percorso IT qui NON c'e' nessun
// `normalizeItalianContentFromPayload` a valle (`validateItalianPayload` gira
// solo su `content.it`): il campo sarebbe finito in `content/`, in
// `dist/api/meta-de.json` e nel feed RSS `de` come paragrafo il cui testo e'
// `null`.

test('ramo missing-field: body1 tradotto = "null" viene letto come MANCANTE e ritradotto (#799)', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete }, de: { ...complete, body1: 'null' }, fr: { ...complete } } };
  // body2/body3 italiani DIVERSI da quelli tradotti: un body identico
  // all'italiano e' ora un passthrough e partirebbe anche lui in retry (#1875).
  const itContent = { body1: 'Corpo italiano reale.', ...META_PLAUSIBILI, body2: 'B2it', body3: 'B3it' };
  const calls = [];
  const callWithRetry = async (_prompt, _tokens, label) => {
    calls.push(label);
    return { body1: 'Echter deutscher Text.' };
  };

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.deepEqual(calls, ['de:body1-missing-retry'], 'il retry mirato deve partire proprio su de:body1');
  assert.equal(data.content.de.body1, 'Echter deutscher Text.');
});

test('ramo missing-field: "null" doppiamente serializzato — excerpt sul fallback IT, body NON tradotto quando il retry non produce nulla (#799, #1875)', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete, excerpt: '"null"' }, de: { ...complete, body3: 'null' }, fr: { ...complete } } };
  const itContent = { body1: 'B1it', title: 'Tit', excerpt: 'Excerpt italiano.', body2: 'B2it', body3: 'Body3 italiano.' };
  // Il retry restituisce a sua volta `"null"`: `translatedStringOrNull` lo
  // rifiuta, quindi `null` non si pubblica in nessun caso. L'excerpt cade
  // sull'italiano (campo meta); il body3 resta non tradotto (#1875).
  const callWithRetry = async () => ({ excerpt: 'null', body3: 'null' });

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.equal(data.content.en.excerpt, 'Excerpt italiano.');
  assert.equal(Object.hasOwn(data.content.de, 'body3'), false, 'ne\' `null` ne\' l\'italiano sotto /de/');
  assert.equal(isBodyTranslationPending(data, 'de', 'body3'), true);
});

// ── «Null» tedesco: contenuto, non campo mancante (#831) ───────────────────
//
// Il rovescio del test sopra. `Null` e' la parola tedesca corrente per «zero»,
// e i sostantivi tedeschi sono SEMPRE maiuscoli: col predicato della sorgente
// (`hasUsableContentText`, case-insensitive) un campo DE il cui testo intero
// e' `Null` si leggeva come MANCANTE. Il retry non ha niente da correggere —
// la traduzione e' giusta — quindi si cadeva sul valore ITALIANO, e il locale
// `de` pubblicava testo italiano. Nessun gate a valle lo vede: e' prosa non
// vuota, solo nella lingua sbagliata.
//
// Dal floor di plausibilita' (#798) un `title` DE di quattro caratteri fa
// partire UNA ritraduzione mirata — un title di quel calibro e' esattamente la
// forma degenere che diventa slug. Cio' che #831 protegge resta intatto ed e'
// il punto di questo test: quando il retry non produce di meglio, il campo NON
// scende sul fallback IT. Sul solo floor-miss l'ultima risorsa e' il valore
// TRADOTTO, mai l'italiano sotto `/de/`.
test('ramo missing-field: un campo DE che vale «Null» (zero, in tedesco) non cade sull\'italiano (#831/#798)', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete }, de: { ...complete, title: 'Null' }, fr: { ...complete } } };
  const itContent = { body1: 'B1it', title: 'Zero', excerpt: 'Eit', body2: 'B2it', body3: 'B3it' };
  const calls = [];
  const callWithRetry = async (_p, _t, label) => { calls.push(label); return { title: 'Null' }; };

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.deepEqual(calls, ['de:title-missing-retry'], 'il floor chiede UNA ritraduzione, non di piu\'');
  assert.equal(data.content.de.title, 'Null', 'il titolo DE non deve essere sostituito dal testo italiano');
});

test('ramo missing-field: il campo DE sotto il floor NON e\' mancante — il body gemello non fa scattare nulla (#831)', async () => {
  // Il rovescio senza il floor di mezzo: sui body il floor meta non esiste, e
  // `Null` tedesco resta contenuto a tutti gli effetti — zero retry, come prima.
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete }, de: { ...complete, body1: 'Null' }, fr: { ...complete } } };
  const itContent = { body1: 'B1it', ...META_PLAUSIBILI, body2: 'B2it', body3: 'B3it' };
  const calls = [];
  const callWithRetry = async (_p, _t, label) => { calls.push(label); return { body1: 'Null' }; };

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.deepEqual(calls, [], 'nessun retry: il campo tradotto c\'e\', non e\' mancante');
  assert.equal(data.content.de.body1, 'Null', 'il body DE legittimo non deve essere sostituito dal testo italiano');
});

// Il rovescio del rovescio: la deroga e' TEDESCA, non generica. In inglese e
// in francese `NULL` come testo INTERO di un campo non e' prosa, e a valle non
// c'e' nessuna rete — l'ultimo gate prima della scrittura gira solo su `['it']`
// — quindi un `title` en che vale `NULL` arriverebbe verbatim nel corpus, in
// `meta-en` e nel feed RSS `en`. Su quei locali il campo deve continuare a
// leggersi come MANCANTE: retry mirato e, se non produce nulla, fallback IT.
test('ramo missing-field: «NULL» su en/fr resta un campo mancante (la deroga #831 e\' solo tedesca)', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = {
    content: {
      en: { ...complete, title: 'NULL' },
      de: { ...complete },
      fr: { ...complete, excerpt: 'Null' },
    },
  };
  const itContent = { title: 'Titolo italiano.', excerpt: 'Excerpt italiano.', body1: 'B1it', body2: 'B2it', body3: 'B3it' };
  const calls = [];
  // Il retry restituisce a sua volta la stessa grafia: rifiutata, quindi si
  // cade sul valore italiano invece di pubblicare `NULL` sotto /en/ e /fr/.
  const callWithRetry = async (_p, _t, label) => {
    calls.push(label);
    return { title: 'NULL', excerpt: 'Null' };
  };

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.deepEqual(calls, ['en:title-missing-retry', 'fr:excerpt-missing-retry'], 'il retry mirato deve partire su en e fr');
  assert.equal(data.content.en.title, 'Titolo italiano.');
  assert.equal(data.content.fr.excerpt, 'Excerpt italiano.');
  assert.equal(data.content.de.title, META_PLAUSIBILI.title, 'il locale de non e\' toccato da questo caso');
});

test('translatedStringOrNull: rifiuta la serializzazione letterale di null, non il testo reale', () => {
  for (const v of ['null', ' null ', '"null"', "'null'", '', '   ', null, undefined, {}, ['x']]) {
    assert.equal(translatedStringOrNull(v, 'de'), null, `deve rifiutare ${JSON.stringify(v)}`);
  }
  assert.equal(translatedStringOrNull('  Testo reale.  ', 'de'), '  Testo reale.  ', 'il testo reale passa BYTE PER BYTE, senza trim');
  assert.equal(translatedStringOrNull('"Nullo" e\' un cognome', 'de'), '"Nullo" e\' un cognome');
  // #831: la deroga alla grafia maiuscola vale SOLO su `de`, dove `Null` e' la
  // parola per «zero». `String(null)`/`JSON.stringify(null)` non producono
  // altro che `null` minuscolo, quindi su `de` una maiuscola non e' mai una
  // serializzazione; su en/fr — e senza locale — lo si tratta come campo
  // mancante e la recovery per-campo lo ripara (#822).
  for (const v of ['Null', 'NULL', 'Null.', '"Null"']) {
    assert.equal(translatedStringOrNull(v, 'de'), v, `deve tenere ${JSON.stringify(v)} su de: non e' una serializzazione`);
  }
  for (const v of ['Null', 'NULL', '"Null"']) {
    for (const loc of ['en', 'fr', undefined]) {
      assert.equal(translatedStringOrNull(v, loc), null, `${JSON.stringify(v)} non e' prosa in ${loc}`);
    }
  }
  // Il punto finale non e' la parola: `Null.` non e' `null` in nessun locale.
  assert.equal(translatedStringOrNull('Null.', 'en'), 'Null.');
});

// ── Il cap free-MT e' scopato ai campi che il free-MT ha rifiutato ─────────
//
// Il budget e' proporzionato ai campi indicizzati per articolo, con un tetto
// globale per run. Addebitarlo a ogni ingresso nel loop lo esaurirebbe con un
// articolo solo, e da li' in poi OGNI campo mancante salta il retry mirato e
// cade sul valore italiano: prosa IT sotto i locali tradotti, cioe' il difetto
// #831 che la catena dovrebbe chiudere.
function reportConCapEsaurito(coppieRifiutate = [], localiEsauriti = ['de']) {
  const report = createFreeMtRecoveryReport();
  for (const [targetLang, field] of coppieRifiutate) {
    recordFreeMtUnusableOutput(report, { reason: 'unusable-text', targetLang, field });
  }
  // La quota e' PER LOCALE (#831: un budget globale si svuotava tutto su `en`
  // e lasciava `de`/`fr` senza recovery), quindi va esaurita sul locale che il
  // test esercita, con campi rifiutati reali e non con claim anonimi. `body1`
  // resta libero per il test che verifica il campo NON rifiutato dal free-MT.
  const quotaProbeFields = ['title', 'excerpt', 'body2', 'body3'];
  for (const locale of localiEsauriti) {
    const alreadyRejected = new Set(
      Object.keys(report.unusableFields || {}).filter((key) => key.startsWith(`${locale}:`)),
    );
    for (const field of quotaProbeFields) {
      const fieldKey = `${locale}:${field}`;
      if (alreadyRejected.has(fieldKey)) continue;
      recordFreeMtUnusableOutput(report, { reason: 'unusable-text', targetLang: locale, field });
      alreadyRejected.add(fieldKey);
      if (alreadyRejected.size >= MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE) break;
    }
    for (let i = 0; i < MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE; i += 1) {
      claimFreeMtLlmFallback(report, locale);
    }
  }
  return report;
}

test('la quota free-MT copre i 21 candidati, incluse le FAQ', () => {
  assert.equal(MAX_FREE_MT_LLM_FALLBACKS_PER_RUN, 7);
  assert.equal(MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE, 3);
});

test('ramo missing-field: faq.q e faq.a rifiutati ottengono il retry anche se il free-MT aveva lasciato IT', async () => {
  const faqIt = {
    q: 'Domanda italiana abbastanza lunga per il test.',
    a: 'Risposta italiana abbastanza lunga per il test.',
  };
  const data = {
    content: {
      en: { ...META_PLAUSIBILI, faq: [{ ...faqIt }] },
      de: { ...META_PLAUSIBILI, faq: [{ q: 'Deutsche Frage ausreichend lang.', a: 'Deutsche Antwort ausreichend lang.' }] },
      fr: { ...META_PLAUSIBILI, faq: [{ q: 'Question française suffisamment longue.', a: 'Réponse française suffisamment longue.' }] },
    },
  };
  const itContent = { ...META_PLAUSIBILI, faq: [{ ...faqIt }] };
  const report = createFreeMtRecoveryReport();
  recordFreeMtUnusableOutput(report, { reason: 'unusable-text', targetLang: 'en', field: 'faq.q[0]' });
  recordFreeMtUnusableOutput(report, { reason: 'unusable-text', targetLang: 'en', field: 'faq.a[0]' });
  const calls = [];
  const callWithRetry = async (_prompt, _tokens, label) => {
    calls.push(label);
    const part = label.includes('.q[') ? 'q' : 'a';
    return { faq: [{ [part]: part === 'q' ? 'Question in English, repaired.' : 'Answer in English, repaired.' }] };
  };

  await runMissingFieldLoop({ data, itContent, callWithRetry, translationReport: report });

  assert.deepEqual(calls, ['en:faq.q[0]-missing-retry', 'en:faq.a[0]-missing-retry']);
  assert.equal(data.content.en.faq[0].q, 'Question in English, repaired.');
  assert.equal(data.content.en.faq[0].a, 'Answer in English, repaired.');
});

test("recovery FAQ indicizzata: un rifiuto non contagia le coppie gia' usabili", async () => {
  const faqIt = [
    { q: 'Prima domanda italiana abbastanza lunga per il test.', a: 'Prima risposta italiana abbastanza lunga per il test.' },
    { q: 'Seconda domanda italiana abbastanza lunga per il test.', a: 'Seconda risposta italiana abbastanza lunga per il test.' },
  ];
  const data = {
    content: {
      en: {
        ...META_PLAUSIBILI,
        faq: [
          { q: '', a: '' },
          { q: 'Second English question remains usable.', a: 'Second English answer remains usable.' },
        ],
      },
      de: { ...META_PLAUSIBILI, faq: faqIt.map((item) => ({ ...item })) },
      fr: { ...META_PLAUSIBILI, faq: faqIt.map((item) => ({ ...item })) },
    },
  };
  const itContent = { ...META_PLAUSIBILI, faq: faqIt };
  const report = createFreeMtRecoveryReport();
  recordFreeMtUnusableOutput(report, { reason: 'unusable-text', targetLang: 'en', field: 'faq.q[0]' });
  recordFreeMtUnusableOutput(report, { reason: 'unusable-text', targetLang: 'en', field: 'faq.a[0]' });
  const calls = [];
  const callWithRetry = async (_prompt, _tokens, label) => {
    calls.push(label);
    const part = label.includes('.q[') ? 'q' : 'a';
    return { faq: [{ [part]: part === 'q' ? 'First English question.' : 'First English answer.' }] };
  };

  await runMissingFieldLoop({ data, itContent, callWithRetry, translationReport: report });

  assert.deepEqual(calls, ['en:faq.q[0]-missing-retry', 'en:faq.a[0]-missing-retry']);
  assert.deepEqual(data.content.en.faq[1], {
    q: 'Second English question remains usable.',
    a: 'Second English answer remains usable.',
  });
});

test('il report di recovery si resetta per articolo e separa gli addebiti del cap', () => {
  const translateStart = src.indexOf('async function translateArticle(data) {');
  assert.notEqual(translateStart, -1);
  const afterStart = src.slice(translateStart, translateStart + 700);
  assert.match(afterStart, /const bodyFieldCount = Object\.keys\(collectBodySections\(data\?\.content\?\.it\)\)\.length;/);
  assert.match(afterStart, /RUN_REPORT\.translation = createFreeMtRecoveryReport\(\{ faqCount, bodyFieldCount \}\)/);
  assert.match(src, /body_fields=\$\{recovery\.bodyFieldCount\}/);
  assert.match(src, /return \{ q: q \|\| '', a: a \|\| '' \}/);
  assert.match(src, /unusable_fields=\$\{JSON\.stringify\(recovery\.unusableFields \|\| \{\}\)\}/);
});

test('ramo missing-field: cap esaurito ma campo NON rifiutato dal free-MT → il retry mirato parte comunque (#831)', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete }, de: { ...complete, body1: '' }, fr: { ...complete } } };
  const itContent = { ...META_PLAUSIBILI, body1: 'B1it', body2: 'B2it', body3: 'B3it' };
  const calls = [];
  const callWithRetry = async (_p, _t, label) => { calls.push(label); return { body1: 'B1 auf Deutsch' }; };

  // Il cap e' esaurito da un ALTRO campo (`de:title`): questo body1 non e' mai
  // stato rifiutato dal free-MT, quindi non deve pagarne il conto.
  await runMissingFieldLoop({ data, itContent, callWithRetry, translationReport: reportConCapEsaurito([['de', 'title']]) });

  assert.deepEqual(calls, ['de:body1-missing-retry'], 'il campo estraneo al free-MT conserva il suo retry mirato');
  assert.equal(data.content.de.body1, 'B1 auf Deutsch', 'niente fallback italiano sotto /de/');
});

// #831 (round redflag): il budget era UNICO per run e il loop scorre `en`
// prima di `de` e `fr`. In una run in cui il free-MT degrada su tutti i campi
// — l'esatto scenario per cui il cap esiste — i 7 claim finivano tutti su
// `en`, e da `de` in poi ogni campo saltava il retry mirato cadendo su
// `itValue`: `/de/` e `/fr/` pubblicati con prosa ITALIANA. Con la quota per
// locale `en` non puo' piu' affamare gli altri.
test('ramo missing-field: `en` degradato non consuma il budget di `de` (#831)', async () => {
  const vuoti = { title: '', excerpt: '', body1: '', body2: '', body3: '' };
  const completo = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...vuoti }, de: { ...completo, body1: '' }, fr: { ...completo } } };
  const itContent = { ...META_PLAUSIBILI, body1: 'B1it', body2: 'B2it', body3: 'B3it' };
  const calls = [];
  const callWithRetry = async (_p, _t, label) => {
    calls.push(label);
    const field = label.split(':')[1].replace('-missing-retry', '');
    return { [field]: `${field} tradotto in modo plausibile e abbastanza lungo` };
  };

  // Il free-MT ha rifiutato TUTTI i campi `en` piu' `de:body1`: ognuno di
  // questi paga il cap, e senza quota per locale i cinque `en` lo esaurivano.
  const rifiutati = ['title', 'excerpt', 'body1', 'body2', 'body3'].map((f) => ['en', f]);
  const report = createFreeMtRecoveryReport();
  for (const [targetLang, field] of [...rifiutati, ['de', 'body1']]) {
    recordFreeMtUnusableOutput(report, { reason: 'unusable-text', targetLang, field });
  }

  await runMissingFieldLoop({ data, itContent, callWithRetry, translationReport: report });

  assert.ok(
    calls.includes('de:body1-missing-retry'),
    `de deve conservare il suo retry mirato, chiamate: ${JSON.stringify(calls)}`,
  );
  assert.notEqual(data.content.de.body1, itContent.body1, 'niente fallback italiano sotto /de/');
  assert.equal(
    calls.filter((c) => c.startsWith('en:')).length,
    MAX_FREE_MT_LLM_FALLBACKS_PER_LOCALE,
    'en resta dentro la sua quota',
  );
});

test('ramo missing-field: body rifiutato dal free-MT con cap esaurito → niente retry, body NON tradotto (#1875)', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete }, de: { ...complete, body1: '' }, fr: { ...complete } } };
  const itContent = { ...META_PLAUSIBILI, body1: 'Questa frase non finisce mai e', body2: 'B2it', body3: 'B3it' };
  const calls = [];
  const callWithRetry = async (_p, _t, label) => { calls.push(label); return { body1: 'B1 auf Deutsch' }; };
  const warnings = [];
  const translationReport = reportConCapEsaurito([['de', 'body1']]);

  await runMissingFieldLoop({
    data,
    itContent,
    callWithRetry,
    detectTruncation: () => [{ type: 'incomplete-ending' }],
    warnings,
    translationReport,
  });

  assert.deepEqual(calls, [], 'il campo davvero rifiutato dal free-MT paga il cap: nessun retry LLM');
  assert.equal(Object.hasOwn(data.content.de, 'body1'), false, 'niente fallback IT sotto /de/: il body resta in attesa');
  assert.equal(translationReport.pendingBodyFields['de:body1'], 'retry-capped');
});

test('ramo missing-field: campo META rifiutato dal free-MT con cap esaurito → il fallback IT troncato resta segnalato (#705)', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete }, de: { ...complete, excerpt: '' }, fr: { ...complete } } };
  const itContent = { ...META_PLAUSIBILI, excerpt: 'Questo riassunto non finisce mai e', body1: 'B1it', body2: 'B2it', body3: 'B3it' };
  const calls = [];
  const callWithRetry = async (_p, _t, label) => { calls.push(label); return { excerpt: 'Auszug auf Deutsch.' }; };
  const warnings = [];

  await runMissingFieldLoop({
    data,
    itContent,
    callWithRetry,
    detectTruncation: () => [{ type: 'incomplete-ending' }],
    warnings,
    translationReport: reportConCapEsaurito([['de', 'excerpt']]),
  });

  assert.deepEqual(calls, [], 'il campo davvero rifiutato dal free-MT paga il cap: nessun retry LLM');
  assert.equal(data.content.de.excerpt, itContent.excerpt, 'fallback IT come ultima risorsa sui campi meta');
  assert.ok(
    warnings.some((w) => String(w).includes('ESSO STESSO troncato')),
    'anche il ramo del cap deve passare per detectTruncation(itValue) e segnalare il fallback IT troncato',
  );
});

// ── #1875 causa B: MT + retry LLM falliti → body NON tradotto, mai italiano ──
//
// La forma della run 36119335123 (2026-09-25): DeepL e Azure a quota esaurita,
// il tier Codex fuori budget, il free-MT che restituisce `fr:body1` al 53% dei
// caratteri (`semantic-truncation`, quindi rifiutato) e il retry LLM mirato che
// muore con «All AI models failed». Fino a #1875 il loop scriveva `itValue` e
// `fr/ridurre-tempi-ripristino-a2-mezzovico` e' uscito con il body1 in
// italiano. Sul codice di prima questo test e' ROSSO: `fr.body1` vale il testo
// italiano.
test('#1875 causa B: free-MT rifiutato + retry LLM fallito → fr.body1 assente e marcato in attesa, nessun italiano', async () => {
  const bodyIt = 'Il ripristino della A2 a Mezzovico richiedera\' tempi lunghi secondo l\'USTRA.';
  const complete = (lang) => ({ ...META_PLAUSIBILI, body1: `B1 ${lang}`, body2: `B2 ${lang}`, body3: `B3 ${lang}` });
  const fr = complete('fr');
  delete fr.body1; // il free-MT omette il campo che ha rifiutato
  const data = { id: 'ridurre-tempi-ripristino-a2-mezzovico', content: { en: complete('en'), de: complete('de'), fr } };
  const itContent = { ...META_PLAUSIBILI, body1: bodyIt, body2: 'B2it', body3: 'B3it' };
  const translationReport = createFreeMtRecoveryReport({ bodyFieldCount: 3 });
  recordFreeMtUnusableOutput(translationReport, { reason: 'semantic-truncation', targetLang: 'fr', field: 'body1' });
  const calls = [];
  const callWithRetry = async (_p, _t, label) => {
    calls.push(label);
    const err = new Error('All AI models failed (quota esaurita su tutto il roster)');
    err.code = 'ALL_MODELS_EXHAUSTED';
    throw err;
  };
  const warnings = [];

  await runMissingFieldLoop({ data, itContent, callWithRetry, warnings, translationReport });

  assert.deepEqual(calls, ['fr:body1-missing-retry'], 'il retry mirato parte, e fallisce');
  assert.equal(Object.hasOwn(data.content.fr, 'body1'), false, 'fr.body1 resta ASSENTE: e\' il marker di traduzione in attesa');
  for (const locale of ['en', 'de', 'fr']) {
    for (const [field, value] of Object.entries(data.content[locale])) {
      assert.notEqual(value, bodyIt, `il body italiano non deve comparire in ${locale}.${field}`);
    }
  }
  assert.deepEqual(pendingBodyTranslations(data), [
    { id: 'ridurre-tempi-ripristino-a2-mezzovico', locale: 'fr', field: 'body1', reason: 'retry-error' },
  ]);
  assert.deepEqual(translationReport.pendingBodyFields, { 'fr:body1': 'retry-error' });
  assert.equal(data.content.fr.body2, 'B2 fr', 'i body tradotti dello stesso locale restano intatti');
  assert.ok(warnings.some((w) => w.includes('lasciato NON tradotto')), `il campo in attesa va segnalato: ${JSON.stringify(warnings)}`);
});

test('#1875: un retry che restituisce l\'italiano verbatim non passa per traduzione — body in attesa', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete, body2: '' }, de: { ...complete }, fr: { ...complete } } };
  const itContent = { ...META_PLAUSIBILI, body1: 'B1it', body2: 'Secondo corpo italiano.', body3: 'B3it' };
  const callWithRetry = async () => ({ body2: 'Secondo corpo italiano.' });

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.equal(Object.hasOwn(data.content.en, 'body2'), false);
  assert.equal(pendingBodyTranslations(data)[0].reason, 'retry-passthrough');
});

test('#1875: title/excerpt/FAQ mantengono il fallback IT (fuori da questa causa), solo i bodyN restano in attesa', async () => {
  const data = { content: { en: { title: '', excerpt: '', body1: '' }, de: { ...META_PLAUSIBILI, body1: 'B1' }, fr: { ...META_PLAUSIBILI, body1: 'B1' } } };
  const itContent = { title: 'Titolo italiano di prova', excerpt: 'Un riassunto italiano di prova abbastanza lungo.', body1: 'Corpo italiano.' };
  const callWithRetry = async () => { throw new Error('retry fallito'); };

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.equal(data.content.en.title, itContent.title);
  assert.equal(data.content.en.excerpt, itContent.excerpt);
  assert.equal(Object.hasOwn(data.content.en, 'body1'), false);
  assert.deepEqual(pendingBodyTranslations(data).map((r) => `${r.locale}:${r.field}`), ['en:body1']);
});

test('markBodyTranslationPending: rifiuta i campi non-body, non serializza il marker, non scrive mai l\'italiano', () => {
  const data = { id: 'x', content: { de: { body1: 'null', body2: 'Deutsch' } } };
  assert.throws(() => markBodyTranslationPending(data, { locale: 'de', field: 'title', reason: 'r' }), /non e' un campo bodyN/);
  const record = markBodyTranslationPending(data, { locale: 'de', field: 'body1', reason: 'retry-error' });
  assert.deepEqual(record, { id: 'x', locale: 'de', field: 'body1', reason: 'retry-error' });
  assert.deepEqual(data.content.de, { body2: 'Deutsch' }, 'il valore inutilizzabile e\' tolto, il resto intatto');
  assert.equal(JSON.stringify(data).includes('_pendingBodyTranslations'), false, 'il marker su data non finisce in nessun JSON');
  markBodyTranslationPending(data, { locale: 'de', field: 'body1', reason: 'retry-capped' });
  assert.deepEqual(pendingBodyTranslations(data), [{ id: 'x', locale: 'de', field: 'body1', reason: 'retry-capped' }], 'una coppia, un record');
  assert.equal(isBodyTranslationPending(data, 'de', 'body2'), false);
});

// ── I mutatori a valle non devono ricreare il body in attesa ───────────────
//
// `validateAndEnforceCTA` appende la CTA a body3 e `enforceStrongInternalLinks`
// il blocco di link a body2, anche quando il campo manca (`(body3 || '') +
// cta`). Su un body in attesa quel moncone cancellerebbe il marker e, nella
// SPA, vincerebbe sul body italiano completo che il sito mostra al posto della
// chiave mancante. Le due funzioni sono ritagliate VERBATIM dal sorgente, con
// le loro costanti, come i loop sopra.
function extractFunctionSource(startMarker) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `${startMarker} non trovato — aggiornare questo test`);
  const e = src.indexOf('\n}\n', a);
  assert.notEqual(e, -1, `fine di ${startMarker} non trovata`);
  return src.slice(a, e + 2);
}

const COLLECT_BODY_SECTIONS_SRC = extractFunctionSource('function collectBodySections(content) {');
const CTA_SRC = extractFunctionSource('function validateAndEnforceCTA(data) {');
const LINKS_SRC = (() => {
  const a = src.indexOf('const LINK_CLUSTER_PATTERNS = {');
  assert.notEqual(a, -1, 'LINK_CLUSTER_PATTERNS non trovato — aggiornare questo test');
  const fnAt = src.indexOf('function enforceStrongInternalLinks(data) {', a);
  assert.notEqual(fnAt, -1, 'enforceStrongInternalLinks non trovato dopo le sue costanti');
  return src.slice(a, src.indexOf('\n}\n', fnAt) + 2);
})();

function runDownstreamMutators(data) {
  const fn = new Function(
    'data', 'isBodyTranslationPending', 'console',
    'bodyTextForQuality', 'pickDefaultCTA', 'CTA_KEYWORDS_IT', 'CTA_KEYWORDS_EN', 'CTA_KEYWORDS_DE', 'CTA_KEYWORDS_FR',
    `${COLLECT_BODY_SECTIONS_SRC}\n${LINKS_SRC}\n${CTA_SRC}\nvalidateAndEnforceCTA(data);\nenforceStrongInternalLinks(data);\nreturn data;`,
  );
  const cta = { it: '\n\nCTA it', en: '\n\nCTA en', de: '\n\nCTA de', fr: '\n\nCTA fr' };
  return fn(
    data, isBodyTranslationPending, { error: () => {}, warn: () => {} },
    () => '', () => cta, ['cta-it'], ['cta-en'], ['cta-de'], ['cta-fr'],
  );
}

test('#1875: CTA e link interni non ricreano body3/body2 lasciati in attesa, e restano invariati altrove', () => {
  const lang = (l) => ({ title: `T ${l}`, excerpt: `E ${l}`, body1: `B1 ${l}`, body2: `B2 ${l}`, body3: `B3 ${l}` });
  const data = { id: 'prova', category: 'novita', content: { it: lang('it'), en: lang('en'), de: lang('de'), fr: lang('fr') } };
  markBodyTranslationPending(data, { locale: 'fr', field: 'body3', reason: 'retry-error' });
  markBodyTranslationPending(data, { locale: 'de', field: 'body2', reason: 'retry-capped' });

  runDownstreamMutators(data);

  assert.equal(Object.hasOwn(data.content.fr, 'body3'), false, 'nessun body3 fr di sola CTA');
  assert.equal(Object.hasOwn(data.content.de, 'body2'), false, 'nessun body2 de di soli link');
  assert.match(data.content.en.body3, /CTA en$/, 'la CTA resta dove il body3 e\' tradotto');
  assert.match(data.content.de.body3, /CTA de$/);
  assert.match(data.content.fr.body2, /nav:calculator/, 'il blocco di link resta dove il body2 e\' tradotto');
  assert.match(data.content.en.body2, /nav:calculator/);
});

test('#1875: senza marker i mutatori ricreano il campo mancante come prima (il salto dipende solo dal marker)', () => {
  const data = { id: 'prova', category: 'novita', content: { it: { title: 'T', body1: 'B1', body2: 'B2' }, en: { title: 'T', body1: 'B1' } } };

  runDownstreamMutators(data);

  assert.match(data.content.en.body3, /CTA en$/);
  assert.match(data.content.en.body2, /nav:calculator/);
});

test('#1875: translateArticle azzera i marker per articolo e la riga FREE_MT_RECOVERY_OUTCOME li conta', () => {
  const translateStart = src.indexOf('async function translateArticle(data) {');
  assert.notEqual(translateStart, -1);
  assert.match(src.slice(translateStart, translateStart + 900), /resetBodyTranslationPending\(data\);/);
  assert.match(src, /pending_bodies=\$\{JSON\.stringify\(recovery\.pendingBodyFields \|\| \{\}\)\}/);
});

// ── Il consumatore del corpus che legge i body: i feed RSS di build-api ────
//
// `scripts/build-api.mjs` non legge i body se non attraverso
// `engine/rssFeeds.mjs` (`<content:encoded>` dei dieci feed in dist/api/).
// Un locale con un `bodyN` in attesa deve quindi continuare a produrre il suo
// feed, con le sole parti tradotte e senza italiano. Il file di body e' scritto
// nella forma di `buildBodyFile()`: le chiavi presenti, nessun segnaposto per
// quella mancante.
test('#1875: un body in attesa non rompe i feed RSS di build-api e non ci porta italiano', () => {
  const section = RSS_SECTIONS.find((s) => s.id === 'frontaliere');
  const id = 'articolo-in-attesa';
  const bodyFile = (entries) => `const body: Record<string, string> = {\n${entries
    .map(([k, v]) => `    'blog.article.${id}.${k}': '${v}',`).join('\n')}\n};\n\nexport default body;\n`;
  const bodyDir = (locale) => path.join('services/locales', section.bodyDir, locale);
  const files = new Map([
    [path.join('services/seo', section.seoFiles[0]), `export default {\n  'blog-${id}': {\n    "headline": "Titolo",\n    "description": "Descrizione",\n    "datePublished": "2026-09-25T00:00:00.000Z",\n    "articleSection": "Notizie",\n  },\n};\n`],
    [section.slugFile, `export const BLOG_SLUGS = {\n '${id}': { it: '${id}', en: 'pending-article', de: 'y', fr: 'z' },\n};\n`],
    [path.join(bodyDir('it'), `${id}.ts`), bodyFile([['body1', 'Primo corpo italiano abbastanza lungo per il feed.'], ['body2', 'SECONDO CORPO ITALIANO da non pubblicare sotto en.'], ['body3', 'Terzo corpo italiano.']])],
    [path.join(bodyDir('en'), `${id}.ts`), bodyFile([['body1', 'First English body long enough for the feed.'], ['body3', 'Third English body.']])],
  ]);
  const fakeFs = {
    existsSync: (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    readdirSync: (dir) => [...files.keys()].filter((k) => path.dirname(k) === dir).map((k) => path.basename(k)),
  };

  const { feeds } = buildSectionFeeds({ fs: fakeFs, path, rootDir: '', section, registry: [], repairSerpSnippet: (x) => x });
  const byName = new Map(feeds);
  const en = byName.get(section.feedFile('en'));

  assert.ok(en, 'il feed en deve essere prodotto anche con un body in attesa');
  assert.match(en, /First English body[\s\S]*Third English body/, 'le parti tradotte arrivano nel feed');
  assert.doesNotMatch(en, /SECONDO CORPO ITALIANO/, 'nessun italiano nel feed en');
  assert.match(byName.get(section.feedFile('it')), /SECONDO CORPO ITALIANO/, 'il feed it resta completo');
});

// ── End-to-end: dal marker di attesa al file di body emesso ────────────────
//
// Review della PR #1877: un passaggio che scrive `bodyN = ''` (o un moncone)
// su una chiave assente distrugge il marker, perche' `buildBodyFile()` emette
// ogni chiave stringa. Qui gira la catena REALE, nell'ordine di
// `generateAndValidateArticle()` dopo `translateArticle()`, con ogni blocco
// ritagliato VERBATIM dal sorgente: i due loop di recovery, lo Step 3c
// (grassetto + URL + nav), CTA e link interni, lo Step 3e (citazione in
// body3), poi la decodifica delle entita' e `buildBodyFile()` di
// `writeSectionLocale()`. Il file emesso per il locale in attesa NON deve
// contenere la chiave. Sul codice di prima e' rosso: i loop scrivevano
// l'italiano, CTA e link ricreavano body3/body2.
function sliceBetween(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `${startMarker.trim().slice(0, 60)} non trovato — aggiornare questo test`);
  const e = src.indexOf(endMarker, a);
  assert.notEqual(e, -1, `${endMarker.trim().slice(0, 60)} non trovato dopo l'inizio — aggiornare questo test`);
  return src.slice(a, e);
}

const STEP_3C_SRC = sliceBetween('  // Step 3c: Sanitize bold + URLs + nav links on translated content', '\n  // Step 3a.1: Reject/repair prompt-schema');
const STEP_3E_SRC = sliceBetween("  const citationUrl = url.startsWith('stats-bfs://')", '\n  console.error(`\\n📝 Articolo generato');
const BOLD_SRC = extractFunctionSource('function sanitizeBoldFormatting(data) {');
const DECODE_ENTITIES_SRC = extractFunctionSource('function decodeLocaleContentEntities(data, locale) {');
const BUILD_BODY_FILE_SRC = extractFunctionSource('function buildBodyFile(data, locale) {');
const MAX_BODY_KEYS = (() => {
  const m = src.match(/const MAX_BODY_KEYS = (\d+);/);
  assert.ok(m, 'MAX_BODY_KEYS non trovato nel sorgente — aggiornare questo test');
  return Number(m[1]);
})();

function runPostTranslationToBodyFiles(data, url) {
  const fn = new Function(
    'data', 'url', 'isBodyTranslationPending', 'console',
    'bodyTextForQuality', 'pickDefaultCTA', 'CTA_KEYWORDS_IT', 'CTA_KEYWORDS_EN', 'CTA_KEYWORDS_DE', 'CTA_KEYWORDS_FR',
    'decodeHtmlEntities', 'META_SEO_FIELDS', 'escapeForSingleQuoteTS', 'MAX_BODY_KEYS',
    `${COLLECT_BODY_SECTIONS_SRC}\n${BOLD_SRC}\n${LINKS_SRC}\n${CTA_SRC}\n${DECODE_ENTITIES_SRC}\n${BUILD_BODY_FILE_SRC}\n`
    + `${STEP_3C_SRC}\nvalidateAndEnforceCTA(data);\nenforceStrongInternalLinks(data);\n${STEP_3E_SRC}\n`
    + "const out = {};\nfor (const locale of ['it', 'en', 'de', 'fr']) { decodeLocaleContentEntities(data, locale); out[locale] = buildBodyFile(data, locale); }\nreturn out;",
  );
  const cta = { it: '\n\nCTA it calcolatore', en: '\n\nCTA en calculator', de: '\n\nCTA de rechner', fr: '\n\nCTA fr calculateur' };
  return fn(
    data, url, isBodyTranslationPending, { error: () => {}, warn: () => {} },
    () => '', () => cta, ['calcolatore'], ['calculator'], ['rechner'], ['calculateur'],
    decodeHtmlEntities, META_SEO_FIELDS, escapeForSingleQuoteTS, MAX_BODY_KEYS,
  );
}

test('#1875 end-to-end: la chiave in attesa resta ASSENTE nel file di body emesso da buildBodyFile()', async () => {
  const id = 'catena-in-attesa';
  const it = { ...META_PLAUSIBILI, body1: 'Primo corpo italiano.', body2: 'Secondo corpo italiano.', body3: 'Terzo corpo italiano.' };
  const lang = (l) => ({ ...META_PLAUSIBILI, body1: `First ${l} body.`, body2: `Second ${l} body.`, body3: `Third ${l} body.` });
  const fr = lang('fr');
  delete fr.body1; // rifiutato dal free-MT
  const de = lang('de');
  delete de.body3; // idem
  const en = lang('en');
  en.body2 = 'This second body is cut off and'; // troncato: passa dal loop truncation-retry
  const data = { id, category: 'novita', content: { it, en, de, fr } };
  const translationReport = createFreeMtRecoveryReport({ bodyFieldCount: 3 });
  recordFreeMtUnusableOutput(translationReport, { reason: 'semantic-truncation', targetLang: 'fr', field: 'body1' });
  recordFreeMtUnusableOutput(translationReport, { reason: 'semantic-truncation', targetLang: 'de', field: 'body3' });
  const failing = async () => { throw Object.assign(new Error('All AI models failed'), { code: 'ALL_MODELS_EXHAUSTED' }); };

  await runMissingFieldLoop({ data, itContent: it, callWithRetry: failing, translationReport });
  await runTruncationRetryLoop({
    data,
    itContent: it,
    detectTruncation: (text) => (String(text).endsWith(' and') ? ['incomplete-ending'] : []),
    callWithRetry: failing,
    translationReport,
  });
  assert.deepEqual(
    pendingBodyTranslations(data).map((r) => `${r.locale}:${r.field}:${r.reason}`).sort(),
    ['de:body3:retry-error', 'en:body2:truncation-retry-error', 'fr:body1:retry-error'],
  );

  const files = runPostTranslationToBodyFiles(data, 'https://www.rsi.ch/news/ticino/articolo');
  const keysOf = (file) => [...file.matchAll(new RegExp(`'blog\\.article\\.${id}\\.(body\\d+)'`, 'g'))].map((m) => m[1]);

  assert.deepEqual(keysOf(files.it), ['body1', 'body2', 'body3'], 'l\'italiano resta completo');
  assert.deepEqual(keysOf(files.fr), ['body2', 'body3'], 'fr: body1 in attesa, assente dal file');
  assert.deepEqual(keysOf(files.de), ['body1', 'body2'], 'de: body3 in attesa, niente body3 di sola CTA/citazione');
  assert.deepEqual(keysOf(files.en), ['body1', 'body3'], 'en: body2 in attesa, niente body2 di soli link interni');
  for (const locale of ['en', 'de', 'fr']) {
    assert.doesNotMatch(files[locale], /corpo italiano/, `nessun testo italiano nel file ${locale}`);
    assert.doesNotMatch(files[locale], /\.body\d+': '',/, `nessun body vuoto emesso nel file ${locale}`);
  }
  assert.match(files.fr, /Third fr body\.[\s\S]*CTA fr calculateur/, 'dove il body c\'e\' la CTA continua ad arrivare');
});

// ── validate(): il sanitizer dei body non crea chiavi assenti ──────────────
//
// Il finding della review sulla PR #1877 indica questo loop di `validate()`.
// Oggi gira PRIMA di `translateArticle()` (generateAndValidateArticle), quindi
// sul flusso primario non incontra un body in attesa; ma scriveva
// `data.content[locale][field] = text` con `text = campo || ''` per OGNI
// body atteso dall'italiano, cioe' creava `''` dove la chiave mancava. Il
// guard rende l'invariante «il marker sopravvive» indipendente dall'ordine.
test('#1875: il sanitizer dei body di validate() non ricrea una chiave assente (niente body vuoto)', () => {
  const block = sliceBetween('  // ── Validate internal links in body content ──', '\n  // Coerce all seo fields to strings');
  const fn = new Function(
    'data', 'expectedBodyFields', 'stripFabricatedExamples', 'stripCompetitorPromotion', 'sanitizeNavLinkSemantics', 'console',
    `${block}\nreturn data;`,
  );
  const passThrough = (text) => ({ text, removedSections: 0, removed: 0, stripped: 0, examples: [] });
  const data = {
    id: 'x',
    content: {
      it: { title: 'T', body1: 'Uno.', body2: 'Due.', body3: 'Tre.' },
      fr: { title: 'T', body2: 'Deux [lien](nav:inesistente).', body3: 'Trois.' },
    },
  };
  markBodyTranslationPending(data, { locale: 'fr', field: 'body1', reason: 'retry-error' });

  fn(data, ['body1', 'body2', 'body3'], passThrough, passThrough, passThrough, { error: () => {}, warn: () => {} });

  assert.equal(Object.hasOwn(data.content.fr, 'body1'), false, 'la chiave in attesa non diventa un body vuoto');
  assert.equal(data.content.fr.body2, 'Deux lien.', 'i body presenti sono ancora sanitizzati (link nav invalido rimosso)');
  assert.deepEqual(Object.keys(data.content.it).filter((k) => k.startsWith('body')), ['body1', 'body2', 'body3']);
});

// ── Risposta = italiano: UN predicato per ogni punto di accettazione ───────
//
// Review della PR #1877 (HEAD 2a010c2f): due punti accettavano come
// traduzione un body che era l'italiano ricopiato, e lo pubblicavano sotto
// /en/ /de/ /fr/ scavalcando il marker di attesa. `isSourcePassthrough`
// (lib/article-free-mt.mjs) e' ora l'unico predicato: cascata free-MT, ramo
// LLM legacy (chiamata singola e a chunk), loop missing-field, retry mirato,
// retry del troncamento. Un test per percorso; tutti tranne la cascata
// free-MT (che il controllo lo aveva gia') sono rossi su 2a010c2f.
test('isSourcePassthrough: confronto normalizzato su bordi e whitespace, mai su testo diverso', () => {
  assert.equal(isSourcePassthrough('  Testo   italiano\n completo. ', 'Testo italiano completo.'), true);
  assert.equal(isSourcePassthrough('Italian text, translated.', 'Testo italiano.'), false);
  assert.equal(isSourcePassthrough('', ''), false, 'una sorgente vuota non rende passthrough niente');
  assert.equal(isSourcePassthrough(null, 'Testo'), false);
});

test('percorso free-MT: la cascata rifiuta il passthrough con lo stesso predicato (anche con whitespace diverso)', async () => {
  const signals = [];
  const out = await translateFieldFreeMt({
    text: 'Il Consiglio di Stato ha approvato il messaggio.',
    sourceLang: 'it',
    targetLang: 'fr',
    fieldType: 'description',
    fieldName: 'body1',
    translate: async () => '  Il Consiglio di Stato  ha approvato il messaggio.\n',
    onUnusableOutput: (e) => signals.push(e.reason),
  });
  assert.equal(out, '');
  assert.deepEqual(signals, ['passthrough']);
});

// Il ramo `ARTICLE_TRANSLATE_FREE_MT=0`: `translateContent` ritagliata VERBATIM
// (e' una chiusura di `translateArticle`), con `callWithRetry` finto.
const TRANSLATE_CONTENT_SRC = (() => {
  const a = src.indexOf('  async function translateContent(sourceLang, targetLang, targetLabel, sourceContent) {');
  assert.notEqual(a, -1, 'translateContent non trovata — aggiornare questo test');
  return src.slice(a, src.indexOf('\n  }\n', a) + 4);
})();
const TRANSLATE_IN_CHUNKS_SRC = (() => {
  const a = src.indexOf('  async function translateInChunks(bodyText, fieldKey, makeChunkPrompt, labelPrefix, targetLang) {');
  assert.notEqual(a, -1, 'translateInChunks non trovata — aggiornare questo test');
  return src.slice(a, src.indexOf('\n  }\n', a) + 4);
})();
const SPLIT_CHUNKS_SRC = extractFunctionSource('function splitIntoTranslationChunks(bodyText, chunkTarget = 500) {');
const COUNT_WORDS_SRC = extractFunctionSource("function countWords(text = '') {");

async function runLegacyTranslateContent(sourceContent, callWithRetry) {
  const fn = new Function(
    'sourceContent', 'callWithRetry', 'ARTICLE_TRANSLATE_FREE_MT', 'translateContentFreeMt', 'TRANSLATION_CHUNK_THRESHOLD',
    'translatedStringOrNull', 'isSourcePassthrough', 'sanitizeBodyText', 'joinTranslatedChunks', 'console',
    `${COLLECT_BODY_SECTIONS_SRC}\n${COUNT_WORDS_SRC}\n${SPLIT_CHUNKS_SRC}\n${TRANSLATE_IN_CHUNKS_SRC}\n${TRANSLATE_CONTENT_SRC}\n`
    + "return translateContent('it', 'fr', '4/5', sourceContent);",
  );
  return fn(
    sourceContent, callWithRetry, false, async () => { throw new Error('ramo free-MT non atteso'); }, TRANSLATION_CHUNK_THRESHOLD,
    translatedStringOrNull, isSourcePassthrough, (v) => v, joinTranslatedChunks, { error: () => {}, warn: () => {} },
  );
}

test('percorso legacy ARTICLE_TRANSLATE_FREE_MT=0, chiamata singola: un body identico all\'italiano non esce da translateContent', async () => {
  const sourceContent = { title: 'Titolo', excerpt: 'Riassunto', body1: 'Primo corpo italiano.', body2: 'Secondo corpo italiano.' };
  const callWithRetry = async (prompt) => {
    if (prompt.includes('- title:')) return { title: 'Titre', excerpt: 'Résumé' };
    if (prompt.includes('- body1:')) return { body1: ' Primo corpo  italiano.\n' }; // l'italiano, ricopiato
    return { body2: 'Deuxième corps traduit.' };
  };

  const out = await runLegacyTranslateContent(sourceContent, callWithRetry);

  assert.equal(Object.hasOwn(out, 'body1'), false, 'la copia italiana e\' scartata: il campo entra nella recovery');
  assert.equal(out.body2, 'Deuxième corps traduit.');
});

test('percorso legacy ARTICLE_TRANSLATE_FREE_MT=0, a chunk: un chunk identico al suo italiano scarta il campo', async () => {
  const para = (n) => Array.from({ length: 400 }, (_, i) => `parola${n}x${i}`).join(' ');
  const body1 = `${para(1)}\n\n${para(2)}`;
  const sourceContent = { title: 'Titolo', excerpt: 'Riassunto', body1 };
  const callWithRetry = async (prompt) => {
    if (prompt.includes('- title:')) return { title: 'Titre', excerpt: 'Résumé' };
    const chunk = prompt.slice(prompt.indexOf('- body1: ') + '- body1: '.length, prompt.indexOf('\n\nREGOLE'));
    return { body1: chunk.startsWith('parola1') ? 'Premier paragraphe traduit.' : chunk }; // il secondo resta italiano
  };

  const out = await runLegacyTranslateContent(sourceContent, callWithRetry);

  assert.equal(Object.hasOwn(out, 'body1'), false, 'mezzo body italiano non passa per traduzione');
  assert.equal(joinTranslatedChunks([{ body1: 'A' }, { body1: 'Due' }], 'body1', 'fr', ['Uno', 'Due']), null);
  assert.equal(joinTranslatedChunks([{ body1: 'A' }, { body1: 'B' }], 'body1', 'fr', ['Uno', 'Due']), 'A\n\nB');
});

test('loop missing-field con ARTICLE_TRANSLATE_FREE_MT=0: un body presente ma identico all\'italiano entra nella recovery e resta in attesa', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const bodyIt = 'Corpo italiano che il modello ha ricopiato.';
  const data = { content: { en: { ...complete }, de: { ...complete }, fr: { ...complete, body1: `${bodyIt}\n` } } };
  const itContent = { ...META_PLAUSIBILI, body1: bodyIt, body2: 'B2it', body3: 'B3it' };
  const calls = [];
  const callWithRetry = async (_p, _t, label) => { calls.push(label); throw new Error('All AI models failed'); };

  await runMissingFieldLoop({ data, itContent, callWithRetry, freeMt: false });

  assert.deepEqual(calls, ['fr:body1-missing-retry'], 'la copia italiana non e\' letta come campo usabile');
  assert.equal(Object.hasOwn(data.content.fr, 'body1'), false);
  assert.equal(pendingBodyTranslations(data)[0].reason, 'retry-error');
});

test('retry mirato: l\'italiano con whitespace diverso non passa per traduzione (retry-passthrough)', async () => {
  const complete = { ...META_PLAUSIBILI, body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete }, de: { ...complete, body3: '' }, fr: { ...complete } } };
  const itContent = { ...META_PLAUSIBILI, body1: 'B1it', body2: 'B2it', body3: 'Terzo corpo italiano.' };
  const callWithRetry = async () => ({ body3: 'Terzo  corpo\nitaliano.' });

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.equal(Object.hasOwn(data.content.de, 'body3'), false);
  assert.equal(pendingBodyTranslations(data)[0].reason, 'retry-passthrough');
});

test('retry del troncamento: l\'italiano completo (non troncato) non sostituisce il body, resta in attesa', async () => {
  const itBody = 'Testo italiano completo, con la frase finale.';
  const data = { content: { de: { body2: 'Dieser Satz endet nie und' } } };
  const itContent = { body2: itBody };
  const detectTruncation = (text) => (String(text).endsWith(' und') ? ['incomplete-ending'] : []);
  const callWithRetry = async () => ({ body2: itBody });

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry });

  assert.equal(Object.hasOwn(data.content.de, 'body2'), false, 'la copia italiana non e\' accettata come retry riuscito');
  assert.equal(pendingBodyTranslations(data)[0].reason, 'truncation-retry-passthrough');
});
