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
// I predicati sono quelli VERI, non una copia: `translatedStringOrNull` e'
// esattamente la funzione che il loop ritagliato riceve in produzione, e una
// copia locale nel test divergerebbe in silenzio dal fix (AGENTS.md #6).
import { translatedStringOrNull } from '../scripts/lib/article-free-mt.mjs';
import { hasUsableContentText, hasUsableTranslatedText } from '../scripts/lib/body2-payload-verdict.mjs';

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
  const marker = '`${locale}:${field}-missing-retry`,';
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
async function runMissingFieldLoop({ data, itContent, callWithRetry, detectTruncation, warnings = [] }) {
  const capturingConsole = { error: () => {}, warn: (msg) => warnings.push(msg) };
  const fn = new Function(
    'data', 'itContent', 'callWithRetry', 'translatedStringOrNull', 'hasUsableTranslatedText', 'detectTruncation', 'console',
    `return (async () => { ${MISSING_FIELD_LOOP_SRC} })();`,
  );
  await fn(data, itContent, callWithRetry, translatedStringOrNull, hasUsableTranslatedText, detectTruncation || (() => []), capturingConsole);
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
async function runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry, translateInChunks, warnings = [] }) {
  const sanitizeBodyText = (v) => v;
  const countWords = (s) => String(s).split(/\s+/).filter(Boolean).length;
  const capturingConsole = { error: () => {}, warn: (msg) => warnings.push(msg) };
  const noopTranslateInChunks = async () => {
    throw new Error('translateInChunks chiamato senza mock — il test non lo aspettava per un campo sotto soglia');
  };
  const fn = new Function(
    'data', 'itContent', 'detectTruncation', 'callWithRetry', 'translateInChunks',
    'TRANSLATION_CHUNK_THRESHOLD', 'translatedStringOrNull', 'sanitizeBodyText', 'countWords', 'console',
    `return (async () => { ${LOOP_SRC} })();`,
  );
  await fn(
    data, itContent, detectTruncation, callWithRetry, translateInChunks || noopTranslateInChunks,
    TRANSLATION_CHUNK_THRESHOLD, translatedStringOrNull, sanitizeBodyText, countWords, capturingConsole,
  );
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

test('itValue non-vuoto: il fallback resta quello atteso (nessuna regressione)', async () => {
  const data = { content: { fr: { body3: 'Cette phrase ne finit jamais et' } } };
  const itContent = { body3: 'Testo italiano completo.' };
  const detectTruncation = () => ['incomplete-ending'];
  const callWithRetry = async () => { throw new Error('retry fallito'); };

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry });

  assert.equal(data.content.fr.body3, 'Testo italiano completo.');
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
  const data = { content: { en: { body1: undefined, title: 'T', excerpt: 'E', body2: 'B2', body3: 'B3' } } };
  // Un fallback fatto di soli spazi è truthy: senza `.trim()` il guard non
  // scattava e il valore quasi-vuoto veniva assegnato invece di lanciare.
  const itContent = { body1: '   ', title: 'T', excerpt: 'E', body2: 'B2', body3: 'B3' };
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

test('ramo truncation-retry: fallback IT esso stesso troncato — warning esplicito, pubblicato come ultima risorsa (#705)', async () => {
  const truncatedIt = 'Questa frase italiana non finisce e';
  const data = { content: { en: { body1: 'This sentence never ends and' } } };
  const itContent = { body1: truncatedIt };
  // Ogni testo (traduzione iniziale, retry, e la sorgente IT stessa) risulta
  // troncato: prima del fix (#705) l'IT veniva pubblicato senza alcun
  // controllo su questo terzo caso.
  const detectTruncation = () => ['incomplete-ending'];
  const callWithRetry = async () => { throw new Error('retry fallito'); };
  const warnings = [];

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry, warnings });

  assert.equal(
    data.content.en.body1,
    truncatedIt,
    'il fallback IT troncato viene comunque pubblicato come ultima risorsa (nessun fallback migliore disponibile)',
  );
  assert.ok(
    warnings.some((w) => w.includes('ESSO STESSO troncato')),
    `deve emettere un warning esplicito quando anche il fallback IT risulta troncato — warnings raccolti: ${JSON.stringify(warnings)}`,
  );
});

test('ramo missing-field: fallback IT esso stesso troncato — warning esplicito, pubblicato come ultima risorsa (#705)', async () => {
  const truncatedIt = 'Questo campo italiano non finisce e';
  // `de` e `fr` sono già completi: il loop itera su tutte e tre le locali,
  // e senza questi il loop leggerebbe `data.content['de'][field]` su un
  // oggetto undefined non appena passa oltre `en`.
  const complete = { title: 'T', excerpt: 'E', body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete, body1: undefined }, de: { ...complete }, fr: { ...complete } } };
  const itContent = { body1: truncatedIt, title: 'T', excerpt: 'E', body2: 'B2', body3: 'B3' };
  const callWithRetry = async () => { throw new Error('retry fallito'); };
  const detectTruncation = () => ['incomplete-ending'];
  const warnings = [];

  await runMissingFieldLoop({ data, itContent, callWithRetry, detectTruncation, warnings });

  assert.equal(
    data.content.en.body1,
    truncatedIt,
    'il fallback IT troncato viene comunque pubblicato come ultima risorsa (nessun fallback migliore disponibile)',
  );
  assert.ok(
    warnings.some((w) => w.includes('ESSO STESSO troncato')),
    `deve emettere un warning esplicito quando anche il fallback IT (campo mancante) risulta troncato — warnings raccolti: ${JSON.stringify(warnings)}`,
  );
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
  const complete = { title: 'T', excerpt: 'E', body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete }, de: { ...complete, body1: 'null' }, fr: { ...complete } } };
  const itContent = { body1: 'Corpo italiano reale.', title: 'T', excerpt: 'E', body2: 'B2', body3: 'B3' };
  const calls = [];
  const callWithRetry = async (_prompt, _tokens, label) => {
    calls.push(label);
    return { body1: 'Echter deutscher Text.' };
  };

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.deepEqual(calls, ['de:body1-missing-retry'], 'il retry mirato deve partire proprio su de:body1');
  assert.equal(data.content.de.body1, 'Echter deutscher Text.');
});

test('ramo missing-field: "null" doppiamente serializzato — fallback IT quando il retry non produce nulla (#799)', async () => {
  const complete = { title: 'T', excerpt: 'E', body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete, excerpt: '"null"' }, de: { ...complete, body3: 'null' }, fr: { ...complete } } };
  const itContent = { body1: 'B1it', title: 'Tit', excerpt: 'Excerpt italiano.', body2: 'B2it', body3: 'Body3 italiano.' };
  // Il retry restituisce a sua volta `"null"`: `translatedStringOrNull` lo
  // rifiuta, quindi si cade sul valore italiano invece di pubblicare `null`.
  const callWithRetry = async () => ({ excerpt: 'null', body3: 'null' });

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.equal(data.content.en.excerpt, 'Excerpt italiano.');
  assert.equal(data.content.de.body3, 'Body3 italiano.');
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
test('ramo missing-field: un campo DE che vale «Null» (zero, in tedesco) NON e\' mancante e non cade sull\'italiano (#831)', async () => {
  const complete = { title: 'T', excerpt: 'E', body1: 'B1', body2: 'B2', body3: 'B3' };
  const data = { content: { en: { ...complete }, de: { ...complete, title: 'Null' }, fr: { ...complete } } };
  const itContent = { body1: 'B1it', title: 'Zero', excerpt: 'Eit', body2: 'B2it', body3: 'B3it' };
  const calls = [];
  const callWithRetry = async (_p, _t, label) => { calls.push(label); return { title: 'Null' }; };

  await runMissingFieldLoop({ data, itContent, callWithRetry });

  assert.deepEqual(calls, [], 'nessun retry: il campo tradotto c\'e\', non e\' mancante');
  assert.equal(data.content.de.title, 'Null', 'il titolo DE legittimo non deve essere sostituito dal testo italiano');
});

test('translatedStringOrNull: rifiuta la serializzazione letterale di null, non il testo reale', () => {
  for (const v of ['null', ' null ', '"null"', "'null'", '', '   ', null, undefined, {}, ['x']]) {
    assert.equal(translatedStringOrNull(v), null, `deve rifiutare ${JSON.stringify(v)}`);
  }
  assert.equal(translatedStringOrNull('  Testo reale.  '), '  Testo reale.  ', 'il testo reale passa BYTE PER BYTE, senza trim');
  assert.equal(translatedStringOrNull('"Nullo" e\' un cognome'), '"Nullo" e\' un cognome');
  // #831: sul testo TRADOTTO solo la grafia serializzata e' scartata.
  // `String(null)`/`JSON.stringify(null)` non producono altro che `null`
  // minuscolo, mentre `Null` e' la parola tedesca per «zero».
  for (const v of ['Null', 'NULL', 'Null.', '"Null"']) {
    assert.equal(translatedStringOrNull(v), v, `deve tenere ${JSON.stringify(v)}: non e' una serializzazione`);
  }
});
