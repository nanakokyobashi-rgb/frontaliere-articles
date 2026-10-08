/**
 * Osservatore del gate finale sugli evergreen (run generate-article del
 * 2026-09-27).
 *
 * ── IL DIFETTO ─────────────────────────────────────────────────────────────
 *
 * Il gate deterministico del ciclo di generazione, per un URL `evergreen://`,
 * giudica l'articolo con `sourceText: ''`: `pageContent` e' il brief che
 * create-article ha scritto da se', non una fonte da ricitare (#96). Il gate
 * FINALE (`assertArticlePassesFactualityGates`, Step 3a.2) riceveva invece
 * `_sourceText: pageContent` nudo, e rigettava con
 * `[source-fidelity-low] 1/31` ogni evergreen che il ciclo aveva appena
 * approvato — dopo aver pagato le traduzioni. Keyword come Friburgo ritirate a
 * 3/3 tentativi.
 *
 * ── COSA PINNA ─────────────────────────────────────────────────────────────
 *
 *   #1 un evergreen con brief non vuoto passa il gate finale: la
 *      source-fidelity non si applica (sul codice vecchio: throw
 *      `source-fidelity-low`);
 *   #2 lo stesso testo con una fonte REALE resta rigettato: la correzione non
 *      spegne il gate, lo riallinea;
 *   #3 il gate completo continua a giudicare anche le traduzioni;
 *   #4 wiring: il gate italiano gira PRIMA di `translateArticle()` nel flusso
 *      primario, il gate completo resta dopo, e il testo di fonte ha UNA sola
 *      espressione (niente copie inline del ternario evergreen).
 *
 * Stessa tecnica di translation-factuality-admission-gate.test.mjs: le
 * funzioni vere sono ritagliate verbatim dal sorgente e istanziate con
 * `new Function`, con le dipendenze di libreria vere (`runFactualityGates`,
 * `formatIssues`). create-article.mjs non e' importabile senza `npm ci`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFactualityGates, formatIssues } from '../scripts/lib/article-factuality-gates.mjs';
import { findArticleLocalizedToponymMismatches } from '../scripts/lib/localized-toponyms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

/** Ritaglia `function <nome>(...)` fino alla `}` in colonna 0, o '' se assente. */
function cutFunctionIfPresent(nome) {
  const re = new RegExp(`^(?:export )?function ${nome}\\(`, 'm');
  const m = re.exec(src);
  if (!m) return '';
  const a = m.index + (m[0].startsWith('export ') ? 'export '.length : 0);
  const rel = src.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura di ${nome} non trovata`);
  return src.slice(a, a + rel + 2);
}

function cutFunction(nome) {
  const block = cutFunctionIfPresent(nome);
  assert.ok(block, `function ${nome} non trovata — aggiornare questo test`);
  return block;
}

function cutSet(nome) {
  const anchor = `const ${nome} = new Set([`;
  const a = src.indexOf(anchor);
  assert.notEqual(a, -1, `anchor non trovata — aggiornare questo test: ${anchor}`);
  const rel = src.slice(a).indexOf(']);');
  return src.slice(a, a + rel + 3);
}

// Le funzioni introdotte dalla correzione sono opzionali nel ritaglio: sul
// codice vecchio mancano, e il test deve fallire per COMPORTAMENTO (#1), non
// per un'anchor assente.
const GATE_SRC = [
  cutFunction('collectBodySections'),
  cutFunction('bodyFieldNames'),
  cutFunction('coerceBodyFields'),
  cutFunction('coerceContentBodyFields'),
  cutSet('DETERMINISTIC_BODY_HEURISTIC_CODES'),
  cutSet('DETERMINISTIC_MAJOR_BLOCKING_CODES'),
  cutFunction('runArticleFactualityGates'),
  cutFunctionIfPresent('factualityGateSourceText'),
  cutFunctionIfPresent('assertItalianArticlePassesFactualityGates'),
  cutFunction('assertArticlePassesFactualityGates'),
  cutFunctionIfPresent('assertLocalizedToponyms'),
].join('\n');

function makeGate() {
  const translationCalls = [];
  const factory = new Function(
    'runFactualityGates',
    'formatIssues',
    'console',
    'BODY_ONLY_FIELDS',
    'defectMemory',
    'checkStatsAstraCountFidelity',
    'joinBodySections',
    'assertTranslationsPassFactualityGates',
    'findArticleLocalizedToponymMismatches',
    `${GATE_SRC}\nreturn assertArticlePassesFactualityGates;`,
  );
  const gate = factory(
    runFactualityGates,
    formatIssues,
    { error: () => {} },
    ['body1', 'body2', 'body3'],
    () => ({}),
    () => ({ passed: true }),
    (content) => Object.values(content).join(' '),
    (data) => { translationCalls.push(data); },
    findArticleLocalizedToponymMismatches,
  );
  return { gate, translationCalls };
}

// Un brief evergreen denso di fatti verificabili (numeri, date, percentuali)
// che l'articolo non ricita: su una fonte reale e' un `source-fidelity-low`.
const BRIEF = [
  'Il comune di Friburgo conta 38.000 abitanti e un moltiplicatore d\'imposta del 76,5%.',
  'Il 1 gennaio 2024 e\' entrato in vigore il nuovo regolamento, con un contributo di CHF 1\'250 per famiglia.',
  'Nel 2023 i frontalieri erano 4.812, il 12,4% in piu\' rispetto al 2019.',
  'L\'affitto medio di un trilocale e\' di CHF 1\'780, contro i CHF 1\'540 del 2020.',
  'La tassa sui cani costa CHF 120 e la raccolta rifiuti CHF 95 all\'anno.',
].join('\n');

const PARAGRAPH = 'Vivere a Friburgo significa scegliere una citta\' bilingue con servizi completi e una vita culturale vivace. ';

function article() {
  const body = PARAGRAPH.repeat(5).trim();
  return { id: 'vivere-friburgo', content: { it: { title: 'Vivere a Friburgo', body1: body, body2: body, body3: body } } };
}

/** Come il flusso primario: il contesto di fonte viaggia in proprieta' non enumerabili. */
function withSource(data, url, sourceText) {
  Object.defineProperties(data, {
    _sourceUrl: { value: url, configurable: true },
    _sourceText: { value: sourceText, configurable: true },
  });
  return data;
}

test('controllo: il brief, trattato come fonte reale, fa scattare source-fidelity-low', () => {
  const body = PARAGRAPH.repeat(5).trim();
  const r = runFactualityGates({
    sections: { body1: body, body2: body, body3: body },
    locale: 'it',
    sourceText: BRIEF,
    publishedAt: new Date().toISOString(),
    memory: {},
  });
  assert.ok(r.blocking.some((i) => i.code === 'source-fidelity-low'), 'fixture non piu\' discriminante');
});

test('#1 evergreen con pageContent non vuoto: il gate finale non applica la source-fidelity', () => {
  const { gate } = makeGate();
  // Il valore NUDO che il flusso passava prima della correzione: il gate deve
  // ignorarlo per un URL evergreen, chiunque lo chiami.
  const data = withSource(article(), 'evergreen://vivere-friburgo', BRIEF);
  assert.doesNotThrow(() => gate(data));
});

test('#2 lo stesso articolo contro una fonte reale resta rigettato', () => {
  const { gate } = makeGate();
  const data = withSource(article(), 'https://www.fr.ch/comune-friburgo', BRIEF);
  assert.throws(() => gate(data), (err) => err.qualityReject === true && /source-fidelity-low/.test(err.message));
});

test('#3 il gate completo giudica ancora le traduzioni', () => {
  const { gate, translationCalls } = makeGate();
  const data = withSource(article(), 'evergreen://vivere-friburgo', BRIEF);
  gate(data);
  assert.equal(translationCalls.length, 1);
});

test('#4 wiring: gate IT prima della traduzione, gate completo dopo, testo di fonte con una sola espressione', () => {
  const i = src.indexOf('async function generateAndValidateArticle');
  const j = src.indexOf('function slugifySlugPart');
  assert.ok(i > 0 && j > i, 'generateAndValidateArticle non trovata');
  const corpo = src.slice(i, j);

  const early = corpo.indexOf('assertItalianArticlePassesFactualityGates(data, {');
  const translate = corpo.indexOf('await translateArticle(data);');
  const final = corpo.indexOf('assertArticlePassesFactualityGates(data);');
  assert.ok(early !== -1, 'il gate italiano non e\' chiamato nel flusso primario');
  assert.ok(translate !== -1 && final !== -1);
  assert.ok(early < translate, 'il gate italiano deve precedere translateArticle(): altrimenti uno scarto consuma il budget traduzioni');
  assert.ok(translate < final, 'il gate completo deve restare dopo la traduzione (giudica anche en/de/fr)');

  const earlyCall = corpo.slice(early, corpo.indexOf(');', early));
  assert.match(earlyCall, /sourceText: factualityGateSourceText\(url, pageContent\)/);
  assert.match(corpo, /_sourceText: \{ value: factualityGateSourceText\(url, pageContent\)/);
  assert.doesNotMatch(src, /url\.startsWith\('evergreen:\/\/'\) \? '' : pageContent/,
    'copia inline del ternario evergreen: usa factualityGateSourceText, altrimenti i gate tornano a divergere');
});
