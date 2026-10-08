/**
 * URL di notizie scartati dal topic-gate (REGOLA #0): il verdetto e' sulla
 * fonte, quindi la run dopo non deve rispendere selezione, fetch e Codex sullo
 * stesso URL (run 36514673677: 4 abort su 5 erano URL gia' scartati 45 minuti
 * prima). Pinna la memoria per sezione e per 48 h nel campo `topicGateUrls` del
 * tracker evergreen, che le altre funzioni del tracker non devono perdere, e il
 * cablaggio in create-article.mjs (non importabile nei test: vedi
 * body2-payload-verdict.mjs).
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOPIC_GATE_URL_MAX,
  TOPIC_GATE_URL_TTL_MS,
  appendEvergreenRejected,
  isTopicGateAbortedUrl,
  loadEvergreenRejectedTracker,
  persistEvergreenRejectedTracker,
  recordTopicGateAbortedUrl,
  strikeEvergreenKeyword,
} from '../scripts/lib/article-topic-selector.mjs';
import { clearStrikesForPool } from '../scripts/reset-evergreen-strikes.mjs';

const NOW = Date.parse('2026-09-29T03:00:00Z');
const URL_KEY = 'https://www.cdt.ch/news/esempio-1234';

test('un abort resta per la sua sezione e per 48 h', () => {
  const t = recordTopicGateAbortedUrl({ keywords: [], strikes: {} }, URL_KEY, 'frontaliere', NOW);
  assert.equal(isTopicGateAbortedUrl(t, URL_KEY, 'frontaliere', NOW + 60_000), true);
  assert.equal(isTopicGateAbortedUrl(t, URL_KEY, 'svizzera', NOW + 60_000), false, 'la sezione svizzera puo\' ancora usarla');
  assert.equal(isTopicGateAbortedUrl(t, URL_KEY, 'frontaliere', NOW + TOPIC_GATE_URL_TTL_MS), false, 'scaduto a 48 h');
  assert.equal(isTopicGateAbortedUrl(t, 'https://altro.ch/x', 'frontaliere', NOW), false);
});

test('registrare pota le voci scadute e tiene al massimo TOPIC_GATE_URL_MAX voci', () => {
  let t = recordTopicGateAbortedUrl({}, 'vecchio', 'frontaliere', NOW - TOPIC_GATE_URL_TTL_MS - 1);
  t = recordTopicGateAbortedUrl(t, URL_KEY, 'frontaliere', NOW);
  assert.deepEqual(Object.keys(t.topicGateUrls), [`frontaliere::${URL_KEY}`]);
  for (let i = 0; i < TOPIC_GATE_URL_MAX + 5; i++) t = recordTopicGateAbortedUrl(t, `u${i}`, 'frontaliere', NOW + i);
  assert.equal(Object.keys(t.topicGateUrls).length, TOPIC_GATE_URL_MAX);
  assert.equal(t.topicGateUrls['frontaliere::u0'], undefined, 'la voce piu\' vecchia esce per prima');
});

test('lo stesso URL scartato in due sezioni resta ricordato per entrambe', () => {
  let t = recordTopicGateAbortedUrl({}, URL_KEY, 'frontaliere', NOW);
  t = recordTopicGateAbortedUrl(t, URL_KEY, 'svizzera', NOW + 1000);
  assert.equal(isTopicGateAbortedUrl(t, URL_KEY, 'frontaliere', NOW + 2000), true);
  assert.equal(isTopicGateAbortedUrl(t, URL_KEY, 'svizzera', NOW + 2000), true);
});

test('le funzioni del tracker evergreen non perdono topicGateUrls', () => {
  const t = recordTopicGateAbortedUrl({ keywords: ['kw'], strikes: { kw2: 1 } }, URL_KEY, 'frontaliere', NOW);
  assert.deepEqual(t.keywords, ['kw']);
  assert.deepEqual(t.strikes, { kw2: 1 });
  const appended = appendEvergreenRejected(t, 'kw3');
  const struck = strikeEvergreenKeyword(appended, 'kw4');
  assert.equal(isTopicGateAbortedUrl(struck, URL_KEY, 'frontaliere', NOW), true);
  assert.deepEqual(struck.keywords, ['kw', 'kw3']);
  assert.equal(struck.strikes.kw4, 1);
});

test('persist e load conservano topicGateUrls, e un file senza il campo si carica ancora', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-gate-memo-'));
  try {
    const file = path.join(dir, 'tracker.json');
    const t = recordTopicGateAbortedUrl({ keywords: ['kw'], strikes: {} }, URL_KEY, 'svizzera', NOW);
    assert.equal(persistEvergreenRejectedTracker(t, { path: file }), true);
    const loaded = loadEvergreenRejectedTracker({ path: file });
    assert.equal(isTopicGateAbortedUrl(loaded, URL_KEY, 'svizzera', NOW + 1), true);
    fs.writeFileSync(file, JSON.stringify({ keywords: ['a'], strikes: { b: 2 } }));
    assert.deepEqual(loadEvergreenRejectedTracker({ path: file }), { keywords: ['a'], strikes: { b: 2 }, topicGateUrls: {} });
    fs.writeFileSync(file, JSON.stringify({ keywords: [], topicGateUrls: { x: { section: 'frontaliere' }, y: 'rotto' } }));
    assert.deepEqual(loadEvergreenRejectedTracker({ path: file }).topicGateUrls, {}, 'voci malformate ignorate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create-article registra l\'abort nel catch del ciclo notizie e lo filtra prima della selezione', () => {
  const src = fs.readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
  const prefilter = src.indexOf('Pre-filter: fonti gia\' rifiutate dal topic-gate');
  const urlPrefilter = src.indexOf('Pre-filter: remove headlines whose source URL was already used');
  const ranker = src.indexOf('Demand-driven ranker (Phase B+C)');
  assert.ok(urlPrefilter > 0 && prefilter > urlPrefilter && prefilter < ranker, 'filtro dopo quello degli URL usati, prima del ranker');
  assert.match(src, /_isTopicGateAbortedUrl\(topicGateTracker, normalizeNewsUrl\(h\.url\), SECTION_NAME\)/);
  assert.match(src, /_isTopicGateAbortedUrl\(_loadEvergreenRejectedTracker\(\), normalizeNewsUrl\(realUrl\), SECTION_NAME\)/);
  assert.match(src, /if \(isTopicGateAbort && url && !String\(url\)\.startsWith\('evergreen:\/\/'\)\) \{\n\s+try \{\n\s+_persistEvergreenRejectedTracker\(_recordTopicGateAbortedUrl\(_loadEvergreenRejectedTracker\(\), normalizeNewsUrl\(url\), SECTION_NAME\)\);/);
});

test('un corpo CMS cantonale verificato consente la rivalutazione del memo, non un bypass del gate', () => {
  const src = fs.readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('const topicGateTracker = _loadEvergreenRejectedTracker();');
  const end = src.indexOf('// ── Pre-filter: remove headlines whose TOPIC', start);
  assert.ok(start > 0 && end > start, 'prefiltro topic-gate non trovato');
  const block = src.slice(start, end);
  const bodyCheck = block.indexOf('h._cantonSourceContent.trim().length >= 200');
  const memoCheck = block.indexOf('_isTopicGateAbortedUrl(topicGateTracker, normalizeNewsUrl(h.url), SECTION_NAME)');
  assert.ok(bodyCheck > memoCheck, 'il memo viene controllato prima del corpo verificato');
  assert.match(block, /if \(hasVerifiedCantonBody\) \{[\s\S]*?return true;/);
  assert.match(block, /hasVerifiedCantonBody[\s\S]*?topicGateAbortedRecently/);
});

test('create-article controlla i duplicati prima del fact-check, oltre che dopo', () => {
  const src = fs.readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function generateAndValidateArticle('));
  const earlyDup = fn.indexOf('Step 3a.0-dup:');
  const factCheck = fn.indexOf('await llmFactCheck(');
  const lateDup = fn.indexOf('// Step 3a.2: Check for duplicates BEFORE translating');
  assert.ok(earlyDup > 0 && earlyDup < factCheck && factCheck < lateDup, `ordine: early=${earlyDup} factCheck=${factCheck} late=${lateDup}`);
  const early = fn.slice(earlyDup, factCheck);
  // Gli slug EN/DE/FR sono ancora provvisori prima della traduzione: il gate
  // anticipato controlla solo lo slot IT, Step 3a.2 e la rilocalizzazione il resto.
  assert.match(early, /checkForDuplicates\(data, \{ localizedSlugs: false \}\);/);
  assert.match(src, /function checkTranslatedSlugCollisions\(data, \{ locales = \['it', 'en', 'de', 'fr'\] \} = \{\}\)/);
  assert.match(src, /checkTranslatedSlugCollisions\(data, \{ locales: localizedSlugs \? \['it', 'en', 'de', 'fr'\] : \['it'\] \}\);/);
  assert.match(fn.slice(lateDup), /checkForDuplicates\(data\);/, 'Step 3a.2 resta completo');
  assert.match(early, /assertTopicNotRecentlyCovered\(data, loadExistingArticleSummariesWithDates\(\)\);/);
});

test('reset-evergreen-strikes non cancella topicGateUrls', () => {
  const t = recordTopicGateAbortedUrl({ keywords: ['kw'], strikes: { 'kw-pool': 3 } }, URL_KEY, 'svizzera', NOW);
  const { ledger } = clearStrikesForPool(t, ['kw-pool']);
  assert.deepEqual(ledger.strikes, {});
  assert.equal(isTopicGateAbortedUrl(ledger, URL_KEY, 'svizzera', NOW + 1), true);
});
