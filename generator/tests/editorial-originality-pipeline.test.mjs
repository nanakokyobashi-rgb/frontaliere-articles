import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');
const ORIGINALITY_HELPER = fs.readFileSync(path.join(HERE, '..', 'scripts', 'lib', 'editorial-originality.mjs'), 'utf8');
const factCheckStart = SOURCE.indexOf('async function llmFactCheck(');
const factCheckEnd = SOURCE.indexOf('\n}\n\n/**\n * Run a single fact-check', factCheckStart);
const verifierStart = SOURCE.indexOf('async function _runSingleFactCheck(');
const verifierEnd = SOURCE.indexOf('// assertNoFabricatedStatistics() REMOVED', verifierStart);
const verification = SOURCE.slice(factCheckStart, factCheckEnd);
const verifier = SOURCE.slice(verifierStart, verifierEnd);

test('one existing fact-check request carries exact article and source evidence', () => {
  assert.match(verification, /editorialContext = \{/);
  assert.match(verification, /articleBody: checkerArticleText\.slice\(articleBodyStart\)/);
  assert.match(verification, /evidenceText: \[/);
  assert.match(verification, /DATASET PRIMARIO BFS: fonte strutturata/);
  assert.match(verification, /BRIEF DI FATTI VERIFICATI PER EVERGREEN/);
  assert.match(verification, /const isEvergreenArticle = sourceUrl\.startsWith\('evergreen:\/\/'\)/);
  assert.match(verification, /const isStatsAstra = sourceUrl\.startsWith\('stats-astra:\/\/'\)/);
  assert.match(verification, /const isSyntheticDataset = isStatsBfs \|\| isStatsAstra/);
  assert.match(verification, /const hasSyntheticReference = isSyntheticDataset \|\| sourceUrl\.startsWith\('evergreen:\/\/'\)/);
  assert.match(verification, /Articolo basato sul dataset chiuso BFS riportato sotto, che è la fonte primaria/);
  assert.match(verification, /DATASET PRIMARIO ASTRA\/OFROU: fonte strutturata dei conteggi/);
  assert.match(verification, /Articolo basato sul dataset chiuso ASTRA\/OFROU riportato sotto/);
  assert.match(verification, /Confronta ogni totale, periodo e variazione con il dataset BFS primario/);
  assert.match(verification, /const sourceEvidenceContent = isSyntheticDataset \? syntheticReferenceText : sourceContent/);
  assert.match(verification, /syntheticReferenceText = extractSyntheticReferenceEvidence\(/);
  assert.match(verification, /evergreenBrief: sourceUrl\.startsWith\('evergreen:\/\/'\)[\s\S]*evergreenFactsBriefFor\(SECTION_NAME, CANTON_FACTS_BRIEF\)/);
  assert.match(verification, /evidenceText: \[[\s\S]*hasSyntheticReference \? syntheticReferenceText : sourceContent\.slice\(0, 6000\)/);
  assert.match(verification, /\$\{syntheticReferenceBlock\}/);
  assert.match(ORIGINALITY_HELPER, /markerIndex > 0 \? sourceContent\.slice\(0, markerIndex\)\.trim\(\) : ''/);
  assert.match(ORIGINALITY_HELPER, /return typeof evergreenBrief === 'string' \? evergreenBrief\.trim\(\) : ''/);
  assert.match(verification, /Valuta body1–body3 nel loro insieme/);
  assert.match(verification, /Attribuisci le notizie alla fonte/);
  assert.match(verification, /ometti cause, effetti, previsioni e consigli fiscali o finanziari senza prove/i);
  assert.match(verification, /reportage sul posto, interviste, fonti proprie o verifiche umane/);
  assert.match(verification, /Scrivi in italiano un finding specifico/);
  assert.match(verification, /"editorialAssessment"/);
  assert.match(verification, /"articleQuote": "citazione esatta di almeno 40 caratteri/);
  assert.match(verification, /"evidenceQuotes": \["citazione esatta di almeno 16 caratteri/);
  assert.equal((verification.match(/_runSingleFactCheck\(/g) || []).length, 4,
    'la valutazione usa gli stessi percorsi di fact-check, senza una nuova chiamata per articolo');
  assert.match(verification, /editorialContext, codexOnly: true/);
});

test('a checker response without verifiable evidence is not counted as a vote', () => {
  assert.match(verifier, /validateEditorialAssessment\(result\.editorialAssessment, opts\.editorialContext\)/);
  assert.match(verifier, /if \(!editorialAssessment\.verifiable\)[\s\S]*?return null;/);
  assert.match(verifier, /return \{ verdict, confidence, issues, editorialAssessment, servedBy \};/);
  assert.match(verification, /TUTTI i modelli di verifica hanno fallito \(rate-limit\/infra/);
  assert.match(verification, /unverified: true/);
});

test('a substantiated restatement or inference failure bypasses weighted issue demotion', () => {
  const gateStart = verification.indexOf('const originalityFailures = modelResults');
  const gateEnd = verification.indexOf('// ── Drop verdicts the source itself refutes ──', gateStart);
  const gate = verification.slice(gateStart, gateEnd);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, 'il gate originale deve precedere la logica di consenso ordinaria');
  assert.match(gate, /filter\(result => !result\.editorialAssessment\?\.passed\)/);
  assert.match(gate, /return \{ passed: false, issues: \[\.\.\.originalityIssues, \.\.\.factualIssues\] \};/);
  assert.ok(gate.indexOf('return { passed: false') < gateEnd);
  assert.ok(gateEnd < verification.indexOf('const HIGH_TRUST_CRITICAL_CATEGORIES'),
    'il rigetto di qualità non deve essere declassato dal punteggio weighted-major');
});

test('generation asks for a traceable contribution without forced implications', () => {
  const ruleStart = SOURCE.indexOf('═══ REGOLA #1 — FEDELTÀ ALLA FONTE');
  const antiHallucination = SOURCE.indexOf('═══ DIVIETI ANTI-ALLUCINAZIONE', ruleStart);
  const rule = SOURCE.slice(ruleStart, antiHallucination);
  assert.doesNotMatch(rule, /RISCRITTURA EDITORIALE della fonte/);
  assert.match(rule, /spiegazione, un confronto o una relazione concreta e verificabile oltre la parafrasi/);
  assert.match(rule, /Ometti cause, conseguenze, sviluppi o azioni non documentati/);
  assert.match(rule, /Non inventare reportage, interviste, fonti proprie/);
  assert.doesNotMatch(SOURCE, /ALMENO il 50% del testo dei campi body1, body2, body3/);
  assert.doesNotMatch(SOURCE, /body3 = AZIONE: cosa fare concretamente/);
});
