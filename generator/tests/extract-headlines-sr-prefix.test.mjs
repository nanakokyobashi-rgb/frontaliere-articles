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
import { decodeHtmlEntities } from '../scripts/lib/decode-html-entities.mjs';

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

// The slice includes the quote-aware walker and the date/embedded scanners
// used by extractHeadlines; no module-scope names need injecting.
// `.replace(/^export /gm, '')`: dal 2026-08-13 il blocco contiene anche
// `parseHeadlineDate` e il suo registro di formati (issue #190 punto 2), che
// sono esportati per essere provati altrove. `new Function` non accetta
// `export`, e senza questa riga l'intera suite muore su un SyntaxError che non
// ha nulla a che vedere con cio' che verifica.
const BLOCK = slice('function extractDateFromUrl(url) {', '\n// ── Step 1b-bis:').replace(/^export /gm, '');

assert.match(BLOCK, /function extractHeadlines\(html, baseUrl\) \{/, 'il blocco deve contenere extractHeadlines — delimitatori da aggiornare');
assert.match(BLOCK, /function extractDatesFromHtml\(html, baseUrl\) \{/, 'il blocco deve contenere extractDatesFromHtml — delimitatori da aggiornare');

const { extractHeadlines, extractDatesFromHtml, extractEmbeddedHeadlineDates } = new Function(
  'decodeHtmlEntities',
  `${BLOCK}\nreturn { extractHeadlines, extractDatesFromHtml, extractEmbeddedHeadlineDates, extractDateFromUrl };`,
)(decodeHtmlEntities);

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

test('quote-aware anchor scanning preserves attributes containing > before and after href', () => {
  const html = '<a data-x="a > b" href="/it/newnsb/2026/comunicato-06">'
    + 'Il Consiglio federale approva il nuovo accordo prima</a>'
    + '<a href="/it/newnsb/2026/comunicato-07" data-x="a > b">'
    + 'Il Consiglio federale approva il nuovo accordo dopo</a>';
  const items = extractHeadlines(html, BASE_URL);

  assert.deepEqual(items.map((item) => item.url), [
    'https://www.admin.ch/it/newnsb/2026/comunicato-06',
    'https://www.admin.ch/it/newnsb/2026/comunicato-07',
  ]);
  assert.deepEqual(items.map((item) => item.headline), [
    'Il Consiglio federale approva il nuovo accordo prima',
    'Il Consiglio federale approva il nuovo accordo dopo',
  ]);
});

test('quote-aware date and structural scans keep a card headline and its time date', () => {
  const html = '<article class="news-card" data-note="a > b">'
    + '<h2>Il Consiglio federale approva il nuovo accordo</h2>'
    + '<time data-note="c > d" datetime="2026-10-14T09:30:00Z">14 ottobre</time>'
    + '<a href="/it/newnsb/2026/comunicato-08" data-note="e > f">Leggi tutto</a>'
    + '</article>';
  const [item] = extractHeadlines(html, BASE_URL);

  assert.equal(item.headline, 'Il Consiglio federale approva il nuovo accordo');
  assert.equal(item.date?.toISOString(), '2026-10-14T09:30:00.000Z');
});

test('does not turn anchors without a non-empty href into the listing URL', () => {
  const headline = 'Il Consiglio federale approva il nuovo accordo senza href';
  const html = `<a>${headline}</a><a href="">${headline}</a>`
    + `<a href="/it/newnsb/2026/comunicato-09">${headline}</a>`;
  const items = extractHeadlines(html, BASE_URL);

  assert.deepEqual(items.map((item) => item.url), [
    'https://www.admin.ch/it/newnsb/2026/comunicato-09',
  ]);

  const sectionHtml = `<section><h4>14 ottobre 2026</h4><a>${headline}</a><a href="">${headline}</a></section>`;
  assert.deepEqual(
    [...extractDatesFromHtml(sectionHtml, BASE_URL, { dateFromSectionHeading: 'h4' })],
    [],
  );
});

test('quote-aware embedded script scanning preserves the publish date', () => {
  const title = 'Il Consiglio federale approva il nuovo accordo embedded';
  const html = '<script type="application/json" data-note="a > b">'
    + JSON.stringify({ cards: [{ title, publishDate: '2026-10-14T09:30:00Z' }] })
    + '</script>'
    + `<a href="/it/newnsb/2026/comunicato-10">${title}</a>`;
  const [item] = extractHeadlines(html, BASE_URL, { quirks: { embeddedDateField: 'publishDate' } });

  assert.equal(item.date?.toISOString(), '2026-10-14T09:30:00.000Z');
  assert.equal(
    extractEmbeddedHeadlineDates(html, 'publishDate').get(title)?.toISOString(),
    '2026-10-14T09:30:00.000Z',
  );
});

test('quote-aware structural and text-lead readers preserve card content', () => {
  const html = '<article class="news-card">'
    + '<h2 data-label="headline > title">Il Consiglio federale approva il nuovo accordo strutturale</h2>'
    + '<div class="teaser" data-note="lead > text">Il Consiglio federale presenta oggi nuove misure per il mercato del lavoro</div>'
    + '<a href="/it/newnsb/2026/comunicato-11">Leggi tutto</a>'
    + '</article>';
  const [item] = extractHeadlines(html, BASE_URL, { quirks: { extractCardLead: 'text' } });

  assert.equal(item.headline, 'Il Consiglio federale approva il nuovo accordo strutturale');
  assert.equal(item.lead, 'Il Consiglio federale presenta oggi nuove misure per il mercato del lavoro');
});

test('quote-aware media lead reader preserves an image title', () => {
  const html = '<article class="news-card">'
    + '<img data-note="image > metadata" title="Il Consiglio federale presenta una nuova misura importante">'
    + '<a href="/it/newnsb/2026/comunicato-12">Una headline già disponibile nel link</a>'
    + '</article>';
  const [item] = extractHeadlines(html, BASE_URL, { quirks: { extractCardLead: 'media-title' } });

  assert.equal(item.lead, 'Il Consiglio federale presenta una nuova misura importante');
});
