/**
 * F6.2 — selezione per domanda di ricerca nei cantoni.
 * Il ranker e' deterministico e locale: nessuna rete, nessun LLM.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_VOCABULARY_QUERIES,
  compileVocabulary,
  demandScore,
  freshnessBand,
  loadSectionDemandVocabulary,
  rankCantonHeadlines,
  sectionVocabularyFor,
  usableSectionVocabulary,
} from '../scripts/lib/canton-section-demand-ranker.mjs';
import {
  buildAliasMap,
  buildVocabularySections,
  sectionOfPath,
} from '../scripts/build-section-demand-vocabulary.mjs';
import { buildCantonProfile } from '../scripts/lib/canton-section-profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = fs.readFileSync(path.join(HERE, '../scripts/create-article.mjs'), 'utf8');
const NOW = Date.parse('2026-11-28T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);

const vocab = (extra = []) => ({
  queries: [
    { query: 'premi cassa malati 2027', impressions: 400, clicks: 12, position: 8 },
    { query: 'imposta alla fonte ticino', impressions: 300, clicks: 9, position: 6 },
    { query: 'permesso G frontalieri', impressions: 200, clicks: 5, position: 12 },
    { query: 'ticino', impressions: 5000, clicks: 100, position: 2 },
    { query: 'cantiere autostrada A2 chiusura', impressions: 90, clicks: 2, position: 15 },
    { query: 'affitti lugano', impressions: 80, clicks: 1, position: 11 },
    { query: 'salario minimo cantone', impressions: 70, clicks: 1, position: 9 },
    { query: 'treno tilo orari', impressions: 60, clicks: 1, position: 14 },
    { query: 'assegni familiari', impressions: 50, clicks: 1, position: 10 },
    ...extra,
  ],
});
const IGNORE = ['Ticino', 'TI', 'articoli ticino'];
const h = (headline, hrs, extra = {}) => ({ headline, url: `https://example.org/${encodeURIComponent(headline)}`, source: 'src', date: hrs === null ? null : hoursAgo(hrs), ...extra });

test('vocabolario insufficiente: nessuna scelta (comportamento di oggi)', () => {
  assert.equal(usableSectionVocabulary({ queries: [] }), null);
  assert.equal(usableSectionVocabulary(null), null);
  const thin = { queries: vocab().queries.slice(0, MIN_VOCABULARY_QUERIES - 1) };
  const r = rankCantonHeadlines([h('Premi cassa malati 2027 in aumento', 1)], thin, { now: NOW, ignoreTerms: IGNORE });
  assert.deepEqual(r.picks, []);
  assert.equal(r.reason, 'insufficient-vocabulary');
  assert.equal(rankCantonHeadlines([h('x', 1)], null, { now: NOW }).reason, 'insufficient-vocabulary');
});

test('con vocabolario: la headline con piu domanda precede quella senza, a parita di freschezza', () => {
  const pool = [
    h('Sagra di paese tra musica e salsicce', 3),
    h('Premi cassa malati 2027: aumento medio in Ticino', 5),
    h('Imposta alla fonte, cosa cambia', 6),
  ];
  const r = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE });
  assert.equal(r.picks.length, 1);
  assert.match(r.picks[0].headline, /Premi cassa malati/);
  assert.equal(r.picks[0]._selectedSource, 'section-demand');
  assert.ok(r.picks[0]._score.matchedQueries.includes('premi cassa malati 2027'));
});

test('senza vocabolario l ordine del pool non viene riordinato (nessuna scelta)', () => {
  const pool = [h('Sagra di paese', 1), h('Premi cassa malati 2027', 2)];
  assert.deepEqual(rankCantonHeadlines(pool, null, { now: NOW }).picks, []);
});

test('freschezza prima della domanda: la notizia fresca non cede a una vecchia con piu domanda', () => {
  const pool = [
    h('Premi cassa malati 2027 in aumento, imposta alla fonte', 120), // vecchia, domanda alta
    h('Permesso G frontalieri: novita di oggi', 4),                  // fresca, domanda media
  ];
  const r = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE });
  assert.match(r.picks[0].headline, /Permesso G/);
  assert.equal(r.band, 0);
});

test('freschezza prima: fascia fresca senza match => nessuna scelta, non si scende alle vecchie', () => {
  const pool = [
    h('Sagra di paese', 2),
    h('Premi cassa malati 2027 in aumento', 100),
  ];
  const r = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE });
  assert.deepEqual(r.picks, []);
  assert.equal(r.reason, 'no-demand-match-in-freshest-band');
});

test('senza data = fascia piu bassa; futuro = fresca', () => {
  assert.equal(freshnessBand(h('a', null), NOW), 2);
  assert.equal(freshnessBand(h('a', 10), NOW), 0);
  assert.equal(freshnessBand(h('a', 100), NOW), 1);
  assert.equal(freshnessBand(h('a', 24 * 20), NOW), 2);
  assert.equal(freshnessBand({ headline: 'a', date: new Date(NOW + 3600e3) }, NOW), 0);
  const r = rankCantonHeadlines([h('Imposta alla fonte', null), h('Sagra', 5)], vocab(), { now: NOW, ignoreTerms: IGNORE });
  assert.deepEqual(r.picks, [], 'la fascia fresca (Sagra) non ha match: la senza-data non la scavalca');
});

test('il solo nome del cantone non e domanda su un argomento', () => {
  const compiled = compileVocabulary(vocab(), { ignoreTerms: IGNORE });
  assert.ok(!compiled.some((c) => c.query === 'ticino'));
  assert.equal(demandScore('Ticino: tutto sul Ticino', compiled).score, 0);
});

test('parita di punteggio: vince l ordine originale; deterministico', () => {
  const pool = [h('Imposta alla fonte: novita', 5), h('Imposta alla fonte: ultime', 5)];
  const a = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE });
  const b = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE });
  assert.equal(a.picks[0].headline, 'Imposta alla fonte: novita');
  assert.deepEqual(a, b);
});

test('titoli gia pubblicati: un quasi-duplicato viene saltato', () => {
  const pool = [h('Premi cassa malati 2027 in aumento', 2), h('Permesso G frontalieri: le regole', 3)];
  const r = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE, existingTitles: ['Premi cassa malati 2027 in aumento'] });
  assert.match(r.picks[0].headline, /Permesso G/);
});

test('query in tedesco/francese: i token accentati sono normalizzati', () => {
  const v = { queries: [...vocab().queries, { query: 'Grenzgänger Quellensteuer', impressions: 150, clicks: 3, position: 9 }] };
  const r = rankCantonHeadlines([h('Quellensteuer für Grenzgänger sinkt', 2), h('Sagra', 2)], v, { now: NOW, ignoreTerms: IGNORE });
  assert.match(r.picks[0].headline, /Quellensteuer/);
});

test('nessuna regressione per frontaliere e svizzera: il profilo non attiva il ranker di sezione', () => {
  assert.match(CREATE_ARTICLE, /demandRanker: true,\n    evergreenPool: frontaliere \? 'frontaliere' : 'national',/);
  const section = CREATE_ARTICLE.match(/return Object\.freeze\(\{\n    kind,\n    section: sectionName,[\s\S]*?\n  \}\);/);
  assert.ok(section, 'profilo storico trovato');
  assert.ok(!/sectionDemandRanker/.test(section[0]), 'frontaliere/svizzera restano sul ranker storico');
  const p = buildCantonProfile('canton-ti', { nationalTopicalKeywords: ['lavor'], nationalAdmissionKeywords: ['lavor'] });
  assert.equal(p.demandRanker, false, 'il ranker storico (vocabolario frontaliere, sperimentali) resta spento');
  assert.equal(p.sectionDemandRanker, true);
});

test('wiring: il ranker di sezione gira dopo quello storico e prima della selezione LLM, senza withLlmCallStage', () => {
  const i = CREATE_ARTICLE.indexOf('SECTION_PROFILE.sectionDemandRanker && _sectionDemandVocabulary');
  const legacy = CREATE_ARTICLE.indexOf('if (SECTION_PROFILE.demandRanker && (_demandVocabulary');
  const llm = CREATE_ARTICLE.indexOf('chosen = await selectArticle(availableHeadlines);');
  assert.ok(legacy > 0 && i > legacy && llm > i);
  const block = CREATE_ARTICLE.slice(i, llm);
  assert.ok(!/withLlmCallStage|selectArticle|callLLM/.test(block), 'nessuna chiamata LLM nel ranker di sezione (M4)');
});

test('loader: file mancante, rotto o di altra versione => null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdv-'));
  assert.equal(loadSectionDemandVocabulary(path.join(dir, 'nope.json')), null);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.equal(loadSectionDemandVocabulary(path.join(dir, 'bad.json')), null);
  fs.writeFileSync(path.join(dir, 'v9.json'), JSON.stringify({ version: 9, sections: {} }));
  assert.equal(loadSectionDemandVocabulary(path.join(dir, 'v9.json')), null);
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ version: 1, sections: { 'canton-ti': vocab() } }));
  const loaded = loadSectionDemandVocabulary(path.join(dir, 'ok.json'));
  assert.ok(sectionVocabularyFor(loaded, 'canton-ti'));
  assert.equal(sectionVocabularyFor(loaded, 'canton-vd'), null);
});

test('builder: aggrega per sezione dalle quattro lingue, scarta il rumore e le altre sezioni', () => {
  const aliasMap = buildAliasMap(['canton-ti', 'canton-ag']);
  assert.equal(sectionOfPath('/articoli-argovia/qualcosa', aliasMap), 'canton-ag');
  assert.equal(sectionOfPath('/de/aargau-artikel/etwas', aliasMap), 'canton-ag');
  assert.equal(sectionOfPath('/articoli-frontaliere/x', aliasMap), null);
  const rows = [
    { keys: ['Quellensteuer Aargau', 'https://frontaliereticino.ch/de/aargau-artikel/a'], clicks: 1, impressions: 10, position: 4 },
    { keys: ['quellensteuer  aargau', 'https://frontaliereticino.ch/de/aargau-artikel/b'], clicks: 0, impressions: 30, position: 8 },
    { keys: ['una sola impression', 'https://frontaliereticino.ch/articoli-argovia/c'], clicks: 0, impressions: 1, position: 3 },
    { keys: ['fuori', 'https://frontaliereticino.ch/articoli-frontaliere/c'], clicks: 9, impressions: 99, position: 1 },
  ];
  const out = buildVocabularySections(rows, aliasMap);
  assert.deepEqual(Object.keys(out), ['canton-ag']);
  assert.equal(out['canton-ag'].queries.length, 1);
  assert.deepEqual(out['canton-ag'].queries[0], { query: 'quellensteuer aargau', impressions: 40, clicks: 1, position: 7 });
});

test('vocabolario versionato: file valido e le sezioni presenti hanno segnale sufficiente', () => {
  const file = path.join(HERE, '../data/section-demand-vocabulary.json');
  if (!fs.existsSync(file)) return; // generato dallo script, opzionale per il runtime
  const doc = loadSectionDemandVocabulary(file);
  assert.ok(doc, 'JSON valido, version 1');
  assert.match(doc.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  for (const [section, entry] of Object.entries(doc.sections)) {
    assert.match(section, /^canton-[a-z]+$/);
    assert.ok(Array.isArray(entry.queries) && entry.queries.length > 0, section);
  }
});
