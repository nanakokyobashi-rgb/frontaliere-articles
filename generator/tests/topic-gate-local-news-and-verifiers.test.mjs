/**
 * topic-gate-local-news-and-verifiers.test.mjs
 *
 * Two owner decisions of 2026-09-25, both from run 36096755072:
 *
 * 1. Local news that touches the commute or work in Ticino is frontaliere
 *    news even when the source does not say "frontalieri". Codex had aborted
 *    all eight news headlines of that run under REGOLA #0 (road closures on
 *    the SS 341 and in the Gambarogno, FFS Cargo job cuts, the cantonal
 *    budget). The three places that judge relevance must agree, or an article
 *    admitted by one is rejected by the next: the pre-spend classifier, the
 *    REGOLA #0 gate in the generation prompt, and point 11 of the fact-check.
 *
 * 2. The fact-check must get an answer it can read. Its verifiers were
 *    gpt-4.1 and gemini-2.5-flash (GitHub Models retired, Gemini quota spent),
 *    so both fell through to the same nemotron model, which answered in prose.
 *
 * create-article.mjs cannot be imported by a test (network call at module
 * scope), so these checks read its source, like prompt-rebracket-prefer-degradata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AI_MODELS } from '../scripts/lib/ai-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');

function frontaliereGate() {
  const start = SRC.indexOf('const topicalRelevanceGate = IS_FRONTALIERE');
  const end = SRC.indexOf('    : `═══ REGOLA #0', start);
  assert.ok(start !== -1 && end > start, 'REGOLA #0 frontaliere non trovata');
  return SRC.slice(start, end);
}

test('REGOLA #0 counts the commute, work in Ticino and the cantonal budget as a real link', () => {
  const gate = frontaliereGate();
  assert.match(gate, /anche se non nomina i frontalieri/);
  assert.match(gate, /Tragitto casa-lavoro:.*province di Varese, Como e VCO.*chiusure, cantieri, deviazioni/);
  assert.match(gate, /Lavoro in Ticino: licenziamenti, riorganizzazioni, appalti/);
  assert.match(gate, /Canton Ticino: preventivo, deficit, imposte/);
});

test('REGOLA #0 still refuses pure cronaca and still forbids inventing the link', () => {
  const gate = frontaliereGate();
  assert.match(gate, /NON sono nesso reale: cronaca nera, sport, cultura/);
  assert.match(gate, /NON inventare quanti frontalieri impiega un'azienda, percorsi alternativi, orari o importi/);
  assert.match(gate, /"abort_topical_relevance": true/);
});

test('the pre-spend classifier admits the same local news', () => {
  const start = SRC.indexOf('Sei un editor del sito frontaliereticino.ch');
  assert.notEqual(start, -1);
  const prompt = SRC.slice(start, SRC.indexOf('HEADLINE:', start));
  assert.match(prompt, /È RILEVANTE anche se non nomina i frontalieri: viabilità del tragitto casa-lavoro/);
  assert.match(prompt, /posti di lavoro in aziende o enti in Ticino/);
  assert.match(prompt, /finanze e politica del Canton Ticino/);
});

test('the fact-check does not fail those articles for topical relevance', () => {
  const start = SRC.indexOf('**RILEVANZA TOPICA AL FRONTALIERE TICINO-ITALIA (CRITICO)**');
  assert.notEqual(start, -1);
  const point11 = SRC.slice(start, start + 1500);
  assert.match(point11, /viabilità del tragitto casa-lavoro/);
  assert.match(point11, /mercato del lavoro ticinese anche quando la fonte non nomina i frontalieri/);
  assert.match(point11, /politica e finanze del Canton Ticino/);
});

test('the fact-check verifiers are models that answer today: two providers when Gemini has quota, two families otherwise', () => {
  const start = SRC.indexOf('const verificationCandidates = [');
  assert.notEqual(start, -1, 'lista dei verificatori non trovata');
  const list = SRC.slice(start, SRC.indexOf('].filter(Boolean);', start));
  const order = ['NV_GEMMA_4_31B', 'GEMINI_FLASH', 'NV_NEMOTRON_ULTRA', 'NV_NEMOTRON_SUPER'];
  const positions = order.map((key) => list.indexOf(`AI_MODELS.${key}`));
  assert.ok(positions.every((p) => p !== -1), `verificatori attesi: ${order.join(', ')}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'ordine dei verificatori cambiato');
  assert.doesNotMatch(list, /GPT_4_1|GPT4O/, 'GitHub Models e\' ritirato: non puo\' essere un verificatore');
  assert.equal(AI_MODELS.NV_GEMMA_4_31B, 'nvidia/google/gemma-4-31b-it');
  assert.equal(AI_MODELS.NV_NEMOTRON_ULTRA, 'nvidia/nvidia/nemotron-3-ultra-550b-a55b');
  assert.match(SRC, /availableVerifiers\.length >= 2 \? availableVerifiers : verificationCandidates/);
});

test('the consensus counts one vote per model that answered, and seeks a second opinion when two collapse', () => {
  // Review of PR #1848: the two verifiers are only starting points of the
  // cascade, so both can be served by one fallback model. Every vote goes
  // through addIndependentVote (unit-tested in fact-check-response.test.mjs).
  const start = SRC.indexOf('const modelsToQuery = verificationModels.slice(0, 2);');
  assert.notEqual(start, -1);
  const loop = SRC.slice(start, SRC.indexOf('if (modelResults.length === 0) {', start));
  assert.doesNotMatch(loop, /modelResults\.push\(/, 'un voto aggiunto senza passare da addIndependentVote');
  assert.match(loop, /addIndependentVote\(modelResults, modelsToQuery\[i\], s\.value\)/);
  assert.match(loop, /_runSingleFactCheck\(next, prompt, \{ isEvergreen, excludeModels: voted \}\)/);
  assert.match(loop, /addIndependentVote\(modelResults, verificationModels\[2\], fallback\)/);
  const line = SRC.split('\n').find((l) => l.includes('buildFactCheckCallOptions({ model,'));
  assert.match(line, /excludeModels: opts\.excludeModels/);
});

test('the served model survives a cache hit, and the local guard checks it', () => {
  const fn = SRC.slice(SRC.indexOf('async function _runSingleFactCheck('), SRC.indexOf('// assertNoFabricatedStatistics() REMOVED'));
  assert.match(fn, /if \(servedBy === 'cache'\) servedBy = _factCheckServedBy\.get\(servedMemoKey\) \|\| null;/);
  assert.match(fn, /if \(servedBy === AI_MODELS\.LOCAL_FALLBACK\) \{/);
  assert.doesNotMatch(fn, /if \(modelUsedRef\.model === AI_MODELS\.LOCAL_FALLBACK\)/, 'una risposta locale in cache sfuggirebbe alla guardia');
  assert.match(fn, /return \{ verdict, confidence, issues, servedBy \};/);
});

test('the fact-check asks for JSON and reads it with the balanced-object parser', () => {
  const line = SRC.split('\n').find((l) => l.includes('buildFactCheckCallOptions({ model,'));
  assert.ok(line, 'la call del fact-check e\' sparita');
  assert.match(line, /jsonMode: true/);
  assert.match(SRC, /const \{ result, error \} = extractFactCheckJson\(raw\);/);
  assert.doesNotMatch(SRC, /const jsonMatch = raw\.match\(\/\\\{\[\\s\\S\]\*\\\}\/\);/);
});
