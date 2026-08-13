/**
 * extractHeadlines must strip the screen-reader-only prefix that federal AEM
 * sites (admin.ch, seco.admin.ch — same CMS) prepend to every teaser link's
 * accessible name ("Maggiori informazioni su <title>"). It is plain text
 * content, not a tag, so it survives the `<[^>]+>` tag-strip in
 * `create-article.mjs` and used to reach `results[].headline` verbatim,
 * polluting the classifier's `hasTopicalSignal`/`countAdmissionHits` match
 * with boilerplate that never carries a topic signal (issue #209, item 1,
 * follow-up to PR #187).
 *
 * EXTRACTION, not import: `create-article.mjs` pulls the whole generator
 * closure (sharp/undici/…) and this repo has no `node_modules` — same
 * technique as news-scan-section-gates.test.mjs and
 * news-prompt-token-budget.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const SRC = readFileSync(CREATE_ARTICLE, 'utf-8');

function slice(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`delimitatore iniziale non trovato in create-article.mjs: ${JSON.stringify(startMarker)} — aggiornare questo test`);
  }
  const end = SRC.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`delimitatore finale non trovato dopo ${JSON.stringify(startMarker)}: ${JSON.stringify(endMarker)} — aggiornare questo test`);
  }
  return SRC.slice(start, end + endMarker.length);
}

// extractHeadlines closes over extractDatesFromHtml, which closes over
// nothing outside the three functions themselves — no module-scope names
// need injecting.
// `.replace(/^export /gm, '')`: dal 2026-08-13 il blocco contiene anche
// `parseHeadlineDate` e il suo registro di formati (issue #190 punto 2), che
// sono esportati per essere provati altrove. `new Function` non accetta
// `export`, e senza questa riga l'intera suite muore su un SyntaxError che non
// ha nulla a che vedere con cio' che verifica.
const BLOCK = slice('function extractDateFromUrl(url) {', '\n// ── Step 1b-bis:').replace(/^export /gm, '');

assert.match(BLOCK, /function extractHeadlines\(html, baseUrl\) \{/, 'il blocco deve contenere extractHeadlines — delimitatori da aggiornare');
assert.match(BLOCK, /function extractDatesFromHtml\(html, baseUrl\) \{/, 'il blocco deve contenere extractDatesFromHtml — delimitatori da aggiornare');

const { extractHeadlines } = new Function(`${BLOCK}\nreturn { extractHeadlines, extractDatesFromHtml, extractDateFromUrl };`)();

const BASE_URL = 'https://www.admin.ch/it/newnsb';

test('strips the "Maggiori informazioni su" screen-reader prefix from an AEM teaser', () => {
  const html = `<a href="/it/newnsb/2026/comunicato-01"><span class="sr-only">Maggiori informazioni su</span> Il Consiglio federale approva il nuovo accordo con la UE</a>`;
  const [item] = extractHeadlines(html, BASE_URL);
  assert.equal(item.headline, 'Il Consiglio federale approva il nuovo accordo con la UE');
});

test('strips the prefix when followed by a colon', () => {
  const html = `<a href="/it/newnsb/2026/comunicato-02">Maggiori informazioni su: SECO pubblica le previsioni congiunturali per il 2026</a>`;
  const [item] = extractHeadlines(html, BASE_URL);
  assert.equal(item.headline, 'SECO pubblica le previsioni congiunturali per il 2026');
});

test('is case-insensitive and tolerates the tag-strip collapsing whitespace', () => {
  const html = `<a href="/it/newnsb/2026/comunicato-03">MAGGIORI INFORMAZIONI SU   <b>Nuove misure per il mercato del lavoro svizzero</b></a>`;
  const [item] = extractHeadlines(html, BASE_URL);
  assert.equal(item.headline, 'Nuove misure per il mercato del lavoro svizzero');
});

test('a headline that genuinely contains the phrase mid-sentence is left alone', () => {
  const html = `<a href="/it/newnsb/2026/comunicato-04">Il portale con maggiori informazioni su pensioni è online da oggi</a>`;
  const [item] = extractHeadlines(html, BASE_URL);
  assert.equal(item.headline, 'Il portale con maggiori informazioni su pensioni è online da oggi');
});

test('a link with no real title left after stripping the prefix is dropped by the length gate', () => {
  const html = `<a href="/it/newnsb/2026/comunicato-05">Maggiori informazioni su: Sciopero</a>`;
  const results = extractHeadlines(html, BASE_URL);
  assert.deepEqual(results, []);
});
