/**
 * translate-article-truncation-fallback.test.mjs — un fallback IT vuoto non
 * deve sovrascrivere un body tradotto troncato-ma-presente (#686).
 *
 * IL DIFETTO. Nel loop di truncation-retry di `translateArticle()`, quando
 * `detectTruncation()` segnala un body EN/DE/FR troncato e il retry mirato
 * fallisce (o resta troncato), il codice eseguiva incondizionatamente
 * `data.content[locale][field] = itValue` con `itValue = itContent[field]`,
 * senza controllare che fosse non-vuoto. Il ramo missing-field poco sopra
 * valida solo il caso "campo assente" (`if (data.content[locale][field])
 * continue;`), quindi questo loop parte già da un campo non-vuoto — può
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
  assert.ok(block.includes('if (!itValue) {'), 'il ritaglio non contiene la guardia del fix (#686): anchor sbagliata');
  return block;
}

const LOOP_SRC = extractTruncationRetryLoop();

/**
 * Esegue il loop ritagliato dentro una funzione async iniettando i mock come
 * variabili di chiusura (stessa forma delle dipendenze reali di
 * `translateArticle`: `detectTruncation`, `callWithRetry`,
 * `translatedStringOrNull`, `sanitizeBodyText`, `countWords`, `console`).
 */
async function runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry }) {
  const translatedStringOrNull = (v) => (typeof v === 'string' && v.trim() ? v : null);
  const sanitizeBodyText = (v) => v;
  const countWords = (s) => String(s).split(/\s+/).filter(Boolean).length;
  const silentConsole = { error: () => {}, warn: () => {} };
  const fn = new Function(
    'data', 'itContent', 'detectTruncation', 'callWithRetry',
    'translatedStringOrNull', 'sanitizeBodyText', 'countWords', 'console',
    `return (async () => { ${LOOP_SRC} })();`,
  );
  await fn(data, itContent, detectTruncation, callWithRetry, translatedStringOrNull, sanitizeBodyText, countWords, silentConsole);
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

test('nessun troncamento rilevato: il campo non viene toccato', async () => {
  const data = { content: { en: { body1: 'A complete sentence.' } } };
  const itContent = { body1: 'Una frase completa.' };
  const detectTruncation = () => [];
  const callWithRetry = async () => { throw new Error('non dovrebbe essere chiamato'); };

  await runTruncationRetryLoop({ data, itContent, detectTruncation, callWithRetry });

  assert.equal(data.content.en.body1, 'A complete sentence.');
});
