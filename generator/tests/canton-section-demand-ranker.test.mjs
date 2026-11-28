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
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MAX_VOCABULARY_AGE_DAYS,
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
  MAX_SECTION_CHANGE,
  MIN_QUERY_IMPRESSIONS,
  buildVocabularySections,
  sectionOfPath,
  verifyVocabularyDocument,
} from '../scripts/build-section-demand-vocabulary.mjs';
import { buildCantonProfile } from '../scripts/lib/canton-section-profile.mjs';
import { classifyDemandQuery, FILTER_LISTS, queryRef, sectionPlaces } from '../scripts/lib/section-demand-query-filter.mjs';

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
  const r = rankCantonHeadlines([h('Premi cassa malati 2027 in aumento', 1)], thin, { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
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
  const r = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.equal(r.picks.length, 1);
  assert.match(r.picks[0].headline, /Premi cassa malati/);
  assert.equal(r.picks[0]._selectedSource, 'section-demand');
  assert.ok(r.picks[0]._score.matchedQueryRefs.includes(queryRef('premi cassa malati 2027')));
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
  const r = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.match(r.picks[0].headline, /Permesso G/);
  assert.equal(r.band, 0);
});

test('freschezza prima: fascia fresca senza match => nessuna scelta, non si scende alle vecchie', () => {
  const pool = [
    h('Sagra di paese', 2),
    h('Premi cassa malati 2027 in aumento', 100),
  ];
  const r = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.deepEqual(r.picks, []);
  assert.equal(r.reason, 'no-demand-match-in-freshest-band');
});

test('senza data = fascia piu bassa; futuro = fresca', () => {
  assert.equal(freshnessBand(h('a', null), NOW), 2);
  assert.equal(freshnessBand(h('a', 10), NOW), 0);
  assert.equal(freshnessBand(h('a', 100), NOW), 1);
  assert.equal(freshnessBand(h('a', 24 * 20), NOW), 2);
  assert.equal(freshnessBand({ headline: 'a', date: new Date(NOW + 3600e3) }, NOW), 0);
  const r = rankCantonHeadlines([h('Imposta alla fonte', null), h('Sagra', 5)], vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.deepEqual(r.picks, [], 'la fascia fresca (Sagra) non ha match: la senza-data non la scavalca');
});

test('il solo nome del cantone non e domanda su un argomento', () => {
  const compiled = compileVocabulary(vocab(), { ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.ok(!compiled.some((c) => c.query === 'ticino'));
  assert.equal(demandScore('Ticino: tutto sul Ticino', compiled).score, 0);
});

test('parita di punteggio: vince l ordine originale; deterministico', () => {
  const pool = [h('Imposta alla fonte: novita', 5), h('Imposta alla fonte: ultime', 5)];
  const a = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  const b = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.equal(a.picks[0].headline, 'Imposta alla fonte: novita');
  assert.deepEqual(a, b);
});

test('titoli gia pubblicati: un quasi-duplicato viene saltato', () => {
  const pool = [h('Premi cassa malati 2027 in aumento', 2), h('Permesso G frontalieri: le regole', 3)];
  const r = rankCantonHeadlines(pool, vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti', existingTitles: ['Premi cassa malati 2027 in aumento'] });
  assert.match(r.picks[0].headline, /Permesso G/);
});

test('query in tedesco/francese: i token accentati sono normalizzati', () => {
  const v = { queries: [...vocab().queries, { query: 'Grenzgänger Quellensteuer', impressions: 150, clicks: 3, position: 9 }] };
  const r = rankCantonHeadlines([h('Quellensteuer für Grenzgänger sinkt', 2), h('Sagra', 2)], v, { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
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
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ version: 1, generatedAt: hoursAgo(24 * 3).toISOString(), sections: { 'canton-ti': vocab() } }));
  const loaded = loadSectionDemandVocabulary(path.join(dir, 'ok.json'), { now: NOW });
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

// ── Privacy, invecchiamento e pool vecchio (round 2 di F6.2). DATI INVENTATI. ──

function captureStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.join(' ')); };
  try { return { result: fn(), lines }; } finally { console.error = original; }
}

test('filtro: scarta, non anonimizza, nomi di persona inventati con o senza dominio', () => {
  const discarded = [
    'giacomo verdi lugano',        // nome + localita'
    'verdi lugano',                // solo cognome + localita'
    'giacomo verdi',               // nome cognome senza dominio
    'mario rossi stipendio',       // stipendio di una persona
    'stipendio giacomo verdi',
    'rossi steuererklärung',       // cognome + dominio: un token ignoto potrebbe essere un cognome
    'ehemann von lucia neri steuern',
    'moglie di giacomo verdi',
    'necrologio ticino',
    'todesanzeige aargau',
  ];
  for (const q of discarded) assert.equal(classifyDemandQuery(q).keep, false, 'scartata: categoria ' + classifyDemandQuery(q).reason);
  assert.equal(classifyDemandQuery('mario rossi stipendio').reason, 'person_pattern');
  assert.equal(classifyDemandQuery('ehemann von lucia neri steuern').reason, 'person_pattern');
  assert.ok(['unknown_token', 'no_domain'].includes(classifyDemandQuery('giacomo verdi').reason));
});

test('filtro: contatti, cifre, sintassi, lunghezza e query troppo corte', () => {
  assert.equal(classifyDemandQuery('info@esempio.invalid steuer').reason, 'contact');
  assert.equal(classifyDemandQuery('https://esempio.invalid/steuer').reason, 'contact');
  assert.equal(classifyDemandQuery('www.esempio steuer').reason, 'contact');
  assert.equal(classifyDemandQuery('079 123 45 67 steuer').reason, 'digits');
  assert.equal(classifyDemandQuery('0791234567').reason, 'digits');
  assert.equal(classifyDemandQuery('steuer abc123;def').reason, 'syntax');
  assert.equal(classifyDemandQuery('"steuer" AND (lohn OR gehalt)').reason, 'syntax');
  assert.equal(classifyDemandQuery('steuer ' + 'parola '.repeat(12)).reason, 'too_long');
  assert.equal(classifyDemandQuery('a').reason, 'too_short');
  assert.equal(classifyDemandQuery('1 2').reason, 'too_short');
});

test('filtro MEDIUM: query generiche a un token o di sole cifre fuori', () => {
  for (const q of ['yes', 'oui', '2026', '12345', 'benzina', 'frontaliere', 'ticino', 'zürich']) {
    assert.equal(classifyDemandQuery(q).keep, false, q);
  }
  assert.equal(classifyDemandQuery('2026 2027').keep, false);
});

test('filtro: righe lecite di dominio restano (4 lingue), con i toponimi della propria sezione', () => {
  const legit = [
    ['steuerfuss zürich 2026', 'canton-zh'], ['veranstaltungen winterthur', 'canton-zh'], ['veranstaltungen lugano', 'canton-ti'],
    ['premi cassa malati 2027', 'canton-ti'], ['imposta alla fonte ticino', 'canton-ti'], ['salario infermiere ticino', 'canton-ti'],
    ['quellensteuer kanton zug', 'canton-zg'], ['affitti lugano', 'canton-ti'], ['permesso G frontalieri', 'canton-ti'],
    ['stau a2 basel heute', 'canton-basilea'], ['fiscalité genève', 'canton-ge'], ['eventi ticino oggi', 'canton-ti'],
    ['steuerfuss niederwil', 'canton-ag'],
  ];
  for (const [q, section] of legit) assert.deepEqual(classifyDemandQuery(q, { section }), { keep: true, reason: null }, `${section} ${q}`);
  // Plurali/varianti elencati dalla lista chiusa di suffissi, solo per i termini di dominio.
  for (const q of ['mieten zürich', 'krankenkassen prämien 2027']) assert.equal(classifyDemandQuery(q, { section: 'canton-zh' }).keep, true, q);
});

test('filtro: i toponimi sono solo quelli della sezione, uno per query', () => {
  assert.equal(classifyDemandQuery('veranstaltungen winterthur', { section: 'canton-ti' }).keep, false, 'comune di un altro cantone');
  assert.equal(classifyDemandQuery('veranstaltungen lugano').keep, false, 'senza sezione nessun toponimo');
  assert.equal(classifyDemandQuery('affitti lugano locarno', { section: 'canton-ti' }).reason, 'toponym_excess');
  assert.equal(classifyDemandQuery('steuerfuss lugano ticino', { section: 'canton-ti' }).reason, 'toponym_excess');
  const ti = sectionPlaces('canton-ti');
  assert.ok(ti.communes.has('lugano') && !ti.communes.has('winterthur'));
  for (const section of ['canton-ti', 'canton-zh', 'canton-ag', 'canton-basilea', 'canton-appenzello']) {
    const places = sectionPlaces(section);
    assert.ok(places.communes.size > 0, section);
    for (const name of places.communes) {
      assert.ok(name.split(' ').length > 1 || name.length > 4, `toponimo corto escluso (${section})`);
      for (const w of name.split(' ')) if (w.length >= 3) assert.ok(!FILTER_LISTS.isDomainWord(w) && !FILTER_LISTS.isGenericWord(w), 'toponimo uguale a una parola di dominio/generica');
    }
  }
});

test('filtro: nessun prefisso ne sottostringa, solo token esatti (cognomi inventati)', () => {
  // Cognomi INVENTATI che iniziano o contengono una parola di dominio: il vecchio matcher a prefisso li lasciava passare.
  const dangerous = [
    ['steuerlin brunnental', 'canton-zh'], ['taxner zorbelli', 'canton-ti'], ['impostoni lugano', 'canton-ti'], ['permessotti g', 'canton-ti'],
    ['lavorini quarnetti ticino', 'canton-ti'], ['tassarelli affitti', 'canton-ti'], ['fiscalini steuer', 'canton-ti'], ['arbeitsen kolbrunn', 'canton-zh'],
    ['lohnberg zürich', 'canton-zh'], ['mietmann zürich', 'canton-zh'], ['bahnoffer steuer', 'canton-zh'], ['krankenfeld prämien', 'canton-zh'],
    ['casabelli lugano', 'canton-ti'], ['busaldi lugano', 'canton-ti'], ['scuolari steuer', 'canton-ti'],
    // cognomi uguali a comuni di altri cantoni o del proprio cantone con un cognome in coda
    ['steuerfuss uster', 'canton-ti'], ['affitti winterthur', 'canton-ti'], ['steuerfuss lugano zorbelli', 'canton-ti'], ['affitti locarno bellinzona', 'canton-ti'],
    // ruolo + cognome
    ['infermiera zorbelli lugano', 'canton-ti'], ['medico quarnetti', 'canton-ti'], ['avvocato vellini lugano', 'canton-ti'], ['muratore fornaroli ticino', 'canton-ti'],
    ['lehrer brunnentaler zürich', 'canton-zh'], ['arzt kolbrunn', 'canton-zh'],
    // via + nome
    ['via zorbelli 12 lugano affitto', 'canton-ti'], ['via giovanni quarnetti affitto', 'canton-ti'], ['strasse brunnental 5 wohnung', 'canton-zh'],
    // email e telefoni con spazi
    ['zorbelli@esempio.invalid affitto', 'canton-ti'], ['steuer info@esempio.invalid', 'canton-zh'],
    ['+41 79 123 45 67 lavoro', 'canton-ti'], ['079 123 45 67 affitto', 'canton-ti'], ['091 123 45 67 steuer', 'canton-ti'], ['0041 79 123 45 67 lavoro', 'canton-ti'],
    // persone private con pattern noti
    ['stipendio di maria zorbelli', 'canton-ti'], ['mario quarnetti permesso g', 'canton-ti'], ['ehemann von lucia quarnetti steuern', 'canton-zh'], ['rossi steuererklärung', 'canton-zh'],
  ];
  assert.ok(dangerous.length >= 30);
  const passing = dangerous.filter(([q, section]) => classifyDemandQuery(q, { section }).keep);
  assert.equal(passing.length, 0, `query pericolose che passano: ${passing.length}`);
});

test('versione del filtro 2 e soglia di impression 5', () => {
  assert.equal(MIN_QUERY_IMPRESSIONS, 5);
  const aliasMap = buildAliasMap(['canton-ti']);
  const page = 'https://frontaliereticino.ch/articoli-ticino/x';
  const rows = [{ keys: ['affitti lugano', page], clicks: 0, impressions: 4, position: 8 }, { keys: ['steuerfuss lugano', page], clicks: 0, impressions: 5, position: 8 }];
  assert.deepEqual(buildVocabularySections(rows, aliasMap)['canton-ti'].queries.map((q) => q.query), ['steuerfuss lugano']);
});

test('queryRef: HMAC con sale, non invertibile per dizionario', () => {
  const q = 'premi cassa malati 2027';
  assert.equal(queryRef(q), queryRef(q), 'stabile dentro il processo');
  assert.notEqual(queryRef(q, 'sale-a'), queryRef(q, 'sale-b'));
  const sha1 = 'q-' + crypto.createHash('sha1').update(q).digest('hex').slice(0, 8);
  assert.notEqual(queryRef(q), sha1, 'non e piu lo sha1 nudo');
});

const cleanDoc = () => ({
  version: 1, minQueryImpressions: 5,
  sections: { 'canton-ti': { queries: ['affitti lugano', 'steuerfuss lugano', 'premi cassa malati', 'permesso g frontalieri', 'treno tilo orari', 'assegni familiari', 'salario minimo ticino', 'eventi locarno', 'meteo lugano', 'carburanti ticino'].map((query) => ({ query, impressions: 9, clicks: 0, position: 8 })) } },
});

test('--verify: fallisce su un JSON sporco, passa su uno pulito, mai testo nell output', () => {
  assert.equal(verifyVocabularyDocument(cleanDoc()).ok, true);
  const dirty = cleanDoc();
  dirty.sections['canton-ti'].queries.push({ query: 'steuerlin zorbelli', impressions: 50, clicks: 0, position: 3 });
  const bad = verifyVocabularyDocument(dirty);
  assert.equal(bad.ok, false);
  assert.equal(bad.violations.reasons.unknown_token, 1);
  const low = cleanDoc();
  low.sections['canton-ti'].queries[0].impressions = 3;
  assert.equal(verifyVocabularyDocument(low).ok, false, 'sotto la soglia di impression');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdv-verify-'));
  const file = path.join(dir, 'dirty.json');
  fs.writeFileSync(file, JSON.stringify(dirty));
  const script = path.join(HERE, '../scripts/build-section-demand-vocabulary.mjs');
  const res = spawnSync(process.execPath, [script, '--verify', '--file', file], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.ok(!/zorbelli|steuerlin/.test(res.stderr + res.stdout), 'la query sporca non compare nell output');
  const good = path.join(dir, 'clean.json');
  fs.writeFileSync(good, JSON.stringify(cleanDoc()));
  assert.equal(spawnSync(process.execPath, [script, '--verify', '--file', good], { encoding: 'utf8' }).status, 0);
});

test('--verify: tetto di variazione del 30% per sezione, superabile solo con allow-large-change', () => {
  assert.equal(MAX_SECTION_CHANGE, 0.3);
  const previous = cleanDoc();
  const swap = (n) => {
    const doc = cleanDoc();
    const names = ['mieten lugano', 'wohnung lugano', 'steuern lugano', 'benzina lugano', 'bus lugano'];
    for (let i = 0; i < n; i += 1) doc.sections['canton-ti'].queries[i] = { query: names[i], impressions: 9, clicks: 0, position: 8 };
    return doc;
  };
  const small = verifyVocabularyDocument(swap(3), { previous });
  assert.equal(small.ok, true, '3 su 10 = 30%: ammesso');
  const large = verifyVocabularyDocument(swap(4), { previous });
  assert.equal(large.ok, false, '4 su 10 = 40%: oltre il tetto');
  assert.deepEqual(large.changeViolations, ['canton-ti']);
  assert.equal(verifyVocabularyDocument(swap(4), { previous, allowLargeChange: true }).ok, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdv-change-'));
  const prev = path.join(dir, 'prev.json');
  const next = path.join(dir, 'next.json');
  fs.writeFileSync(prev, JSON.stringify(previous));
  fs.writeFileSync(next, JSON.stringify(swap(4)));
  const script = path.join(HERE, '../scripts/build-section-demand-vocabulary.mjs');
  assert.equal(spawnSync(process.execPath, [script, '--verify', '--file', next, '--previous', prev], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [script, '--verify', '--file', next, '--previous', prev, '--allow-large-change'], { encoding: 'utf8' }).status, 0);
});

test('builder: scarta PRIMA dell aggregazione; i conteggi non contengono testo delle query', () => {
  const aliasMap = buildAliasMap(['canton-ti']);
  const page = 'https://frontaliereticino.ch/articoli-ticino/x';
  const row = (query, impressions) => ({ keys: [query, page], clicks: 0, impressions, position: 8 });
  const rows = [
    row('Steuerfuss Lugano 2026', 40),
    row('affitti lugano', 30),
    row('giacomo verdi lugano', 500),
    row('mario rossi stipendio', 500),
    row('info@esempio.invalid', 500),
    row('079 123 45 67', 500),
    row('abc123;def steuer', 500),
    row('yes', 500),
  ];
  const stats = {};
  const out = buildVocabularySections(rows, aliasMap, { stats });
  assert.deepEqual(out['canton-ti'].queries.map((q) => q.query), ['steuerfuss lugano 2026', 'affitti lugano']);
  assert.equal(out['canton-ti'].totalQueries, 2, 'le scartate non entrano nemmeno nel totale');
  assert.equal(stats.keptDistinct, 2);
  assert.equal(Object.values(stats.discarded).reduce((a, b) => a + b, 0), 6);
  const dump = JSON.stringify({ out, stats });
  for (const leaked of ['verdi', 'rossi', 'esempio', '123', 'abc']) assert.ok(!dump.includes(leaked), 'nessun testo scartato nell output');
});

test('runtime: un JSON vecchio con nomi non li porta nel ranker ne nel punteggio', () => {
  const dirty = { queries: [...vocab().queries, { query: 'giacomo verdi lugano', impressions: 900, clicks: 9, position: 5 }, { query: 'verdi', impressions: 900, clicks: 9, position: 5 }] };
  const compiled = compileVocabulary(dirty, { ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.ok(compiled.every((c) => !/verdi/.test(JSON.stringify(c))), 'nessuna voce compilata dai nomi');
  const r = rankCantonHeadlines([h('Giacomo Verdi a Lugano: incontro pubblico', 2)], dirty, { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.deepEqual(r.picks, [], 'la headline con il nome non trova domanda');
  // Un vocabolario sufficiente SOLO grazie alle query personali diventa insufficiente.
  const names = Array.from({ length: 10 }, (_, i) => ({ query: `giacomo verdi${i} lugano`, impressions: 100, clicks: 1, position: 7 }));
  assert.equal(usableSectionVocabulary({ queries: names }), null);
});

test('log: il ranker espone solo un riferimento breve della query, mai il testo', () => {
  const r = rankCantonHeadlines([h('Premi cassa malati 2027: aumento medio', 3)], vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  const refs = r.picks[0]._score.matchedQueryRefs;
  assert.ok(refs.length > 0 && refs.every((x) => /^q-[0-9a-f]{8}$/.test(x)));
  assert.ok(!JSON.stringify(r.picks[0]._score).includes('premi cassa'));
  assert.ok(/matchedQueryRefs\.join/.test(CREATE_ARTICLE) && !/matchedQueries/.test(CREATE_ARTICLE), 'create-article logga i riferimenti');
});

test('loader: vocabolario stantio (> 45 giorni) o senza data => null con SECTION_DEMAND_STALE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdv-stale-'));
  const write = (name, generatedAt) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ version: 1, ...(generatedAt ? { generatedAt } : {}), sections: { 'canton-ti': vocab() } }));
    return file;
  };
  assert.equal(MAX_VOCABULARY_AGE_DAYS, 45);
  const stale = captureStderr(() => loadSectionDemandVocabulary(write('old.json', hoursAgo(24 * 60).toISOString()), { now: NOW }));
  assert.equal(stale.result, null);
  assert.ok(stale.lines.some((l) => l.startsWith('SECTION_DEMAND_STALE')));
  assert.ok(stale.lines.every((l) => !l.includes('premi cassa')), 'il log stantio non cita query');
  const edge = captureStderr(() => loadSectionDemandVocabulary(write('edge.json', hoursAgo(24 * 44).toISOString()), { now: NOW }));
  assert.ok(edge.result, '44 giorni e\' ancora valido');
  assert.deepEqual(edge.lines, []);
  assert.equal(captureStderr(() => loadSectionDemandVocabulary(write('nodate.json', null), { now: NOW })).result, null);
});

test('no-fresh-pool: se la fascia migliore e la 2 (vecchia o senza data) nessuna scelta', () => {
  const old = rankCantonHeadlines([h('Premi cassa malati 2027 in aumento', 24 * 20), h('Imposta alla fonte, cosa cambia', null)], vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.deepEqual(old.picks, []);
  assert.equal(old.reason, 'no-fresh-pool');
  assert.equal(old.band, 2);
  const recent = rankCantonHeadlines([h('Premi cassa malati 2027 in aumento', 100)], vocab(), { now: NOW, ignoreTerms: IGNORE, section: 'canton-ti' });
  assert.equal(recent.picks.length, 1, 'la fascia 1 (recente) continua a funzionare');
  assert.equal(recent.band, 1);
});

test('vocabolario versionato: ogni query presente passa il filtro di privacy', () => {
  const file = path.join(HERE, '../data/section-demand-vocabulary.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  let total = 0;
  let rejected = 0;
  for (const [section, entry] of Object.entries(doc.sections)) {
    for (const q of entry.queries) { total += 1; if (!classifyDemandQuery(q.query, { section }).keep || q.impressions < MIN_QUERY_IMPRESSIONS) rejected += 1; }
  }
  assert.ok(total > 0);
  assert.equal(rejected, 0, 'nessuna query personale o fuori dominio nel file versionato');
  assert.ok(doc.discardedByReason && typeof doc.discardedByReason === 'object', 'conteggi di scarto presenti, mai testo');
});

test('workflow di rinnovo mensile: schedule + dispatch, builder, PR con PAT', () => {
  const wf = fs.readFileSync(path.join(HERE, '../../.github/workflows/refresh-section-demand-vocabulary.yml'), 'utf8');
  assert.match(wf, /\n  schedule:\n(?:\s+#.*\n)*\s+- cron: '[^']+'/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /node generator\/scripts\/load-rc-env\.mjs/);
  assert.match(wf, /build-section-demand-vocabulary\.mjs/);
  assert.match(wf, /gh pr create/);
  assert.match(wf, /allow_large_change:/);
  assert.ok(wf.indexOf('build-section-demand-vocabulary.mjs "${ARGS[@]}"') < wf.indexOf('--verify'), 'verify dopo il builder');
  assert.ok(wf.indexOf('--verify') < wf.indexOf('git add --'), 'verify prima di git add');
  assert.match(wf, /--allow-large-change/);
  assert.match(wf, /## Implementato/);
  assert.match(wf, /## Non implementato \(ancora\)/);
});
