import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createRunDeadline, DEFAULT_SOFT_WALL_MS, parseWallMs } from '../scripts/lib/run-deadline.mjs';

const MIN = 60_000;
const HARD_MS = 2340 * 1000; // GENERATE_HARD_KILL_S 2400 - 60 s
const SOFT_MS = DEFAULT_SOFT_WALL_MS; // 23 min

function clock(startMs = 1_000_000) {
  const state = { t: startMs };
  return { start: startMs, now: () => state.t, advance: (ms) => { state.t += ms; } };
}

function make(overrides = {}) {
  const c = clock();
  const deadline = createRunDeadline({ startMs: c.start, hardMs: HARD_MS, softMs: SOFT_MS, now: c.now, ...overrides });
  return { c, deadline };
}

/**
 * Il ciclo dei tentativi di create-article in miniatura: prima di ogni NUOVO
 * tentativo (altro topic o rigenerazione) si chiede alla scadenza se puo'
 * aprirsi; ogni tentativo dura `durationMs` e supera o meno i gate.
 */
function runAttempts({ deadline, c }, attempts) {
  const started = [];
  for (const [index, attempt] of attempts.entries()) {
    if (deadline.newAttemptBlocked()) return { started, stoppedBefore: index };
    started.push(index);
    c.advance(attempt.durationMs);
    if (attempt.passesGates) deadline.markConverging();
  }
  return { started, stoppedBefore: null };
}

test('default: morbida 1380000 ms, letta da env solo se intera e positiva', () => {
  assert.equal(DEFAULT_SOFT_WALL_MS, 1_380_000);
  assert.equal(parseWallMs(undefined, 5), 5);
  assert.equal(parseWallMs('', 5), 5);
  assert.equal(parseWallMs('abc', 5), 5);
  assert.equal(parseWallMs('-3', 5), 5);
  assert.equal(parseWallMs('900000', 5), 900000);
});

test('run non convergente: la morbida impedisce un nuovo tentativo e dichiara `soft`', () => {
  const run = make();
  const out = runAttempts(run, [
    { durationMs: 12 * MIN, passesGates: false },
    { durationMs: 12 * MIN, passesGates: false }, // finisce a 24 min > 23
    { durationMs: 12 * MIN, passesGates: false },
  ]);
  assert.deepEqual(out.started, [0, 1]);
  assert.equal(out.stoppedBefore, 2);
  assert.equal(run.deadline.applied, 'soft');
  assert.equal(run.deadline.converging, false);
  assert.deepEqual(run.deadline.snapshot(), {
    softWallMs: SOFT_MS, hardWallMs: HARD_MS, draftPassedGates: false, deadlineApplied: 'soft',
  });
});

test('run convergente: nessun taglio prima della dura, poi `hard`', () => {
  const run = make();
  const out = runAttempts(run, [
    { durationMs: 10 * MIN, passesGates: true }, // bozza oltre i gate a 10 min (fact-check poi la boccia)
    { durationMs: 14 * MIN, passesGates: true }, // 24 min: oltre la morbida
    { durationMs: 14 * MIN, passesGates: true }, // 38 min: sotto la dura (39 min)
    { durationMs: 5 * MIN, passesGates: true },  // 43 min
    { durationMs: 1 * MIN, passesGates: true },
  ]);
  assert.deepEqual(out.started, [0, 1, 2, 3], 'dopo la morbida un run in convergenza continua');
  assert.equal(out.stoppedBefore, 4, 'oltre i 39 min si ferma la dura');
  assert.equal(run.deadline.applied, 'hard');
  assert.equal(run.deadline.snapshot().draftPassedGates, true);
});

test('convergenza raggiunta dopo la morbida non e\' piu\' un taglio se la bozza e\' gia\' in volo', () => {
  const run = make();
  // Il tentativo parte a 20 min (prima della morbida), supera i gate a 26 min.
  run.c.advance(20 * MIN);
  assert.equal(run.deadline.newAttemptBlocked(), false);
  run.c.advance(6 * MIN);
  run.deadline.markConverging();
  assert.equal(run.deadline.newAttemptBlocked(), false, 'fact-check/rigenerazione dopo la morbida restano permessi');
  assert.equal(run.deadline.applied, null);
});

test('la dura vale per ogni fase e non dipende dalla convergenza', () => {
  const run = make();
  run.c.advance(HARD_MS - 1);
  assert.equal(run.deadline.hardExceeded(), false);
  run.c.advance(2);
  assert.equal(run.deadline.hardExceeded(), true);
  assert.equal(run.deadline.applied, 'hard');
  // un run non convergente che arriva alla dura senza aver mai controllato la morbida
  const other = make();
  other.c.advance(HARD_MS + 1);
  assert.equal(other.deadline.newAttemptBlocked(), true);
  assert.equal(other.deadline.applied, 'hard');
});

test('SIGTERM cooperativo: ferma ogni fase e si dichiara `sigterm`', () => {
  let stop = false;
  const run = make({ stopRequested: () => stop });
  assert.equal(run.deadline.hardExceeded(), false);
  stop = true;
  assert.equal(run.deadline.hardExceeded(), true);
  assert.equal(run.deadline.applied, 'sigterm');
  assert.equal(run.deadline.newAttemptBlocked(), true);
});

test('la scadenza che ha fermato il run resta la prima dichiarata', () => {
  const run = make();
  run.c.advance(SOFT_MS + 1);
  assert.equal(run.deadline.newAttemptBlocked(), true);
  run.c.advance(HARD_MS);
  assert.equal(run.deadline.hardExceeded(), true);
  assert.equal(run.deadline.applied, 'soft');
});

test('la morbida non supera mai la dura (cap corti: le due coincidono)', () => {
  const c = clock();
  const deadline = createRunDeadline({ startMs: c.start, hardMs: 10 * MIN, softMs: SOFT_MS, now: c.now });
  assert.equal(deadline.softMs, 10 * MIN);
  c.advance(10 * MIN + 1);
  assert.equal(deadline.newAttemptBlocked(), true);
});

test('nazionale: il secondo tentativo coi sibling parte sotto la morbida, non dopo se nessuna bozza e\' passata', () => {
  // Pool nazionale: tentativo 1 sul candidato principale, tentativo 2 sui sibling.
  const early = make();
  const a = runAttempts(early, [
    { durationMs: 15 * MIN, passesGates: false },
    { durationMs: 7 * MIN, passesGates: false }, // sibling, parte a 15 min: ammesso
  ]);
  assert.deepEqual(a.started, [0, 1]);

  const late = make();
  const b = runAttempts(late, [
    { durationMs: 24 * MIN, passesGates: false }, // il primo tentativo consuma la morbida
    { durationMs: 7 * MIN, passesGates: false },  // sibling: non parte
  ]);
  assert.deepEqual(b.started, [0]);
  assert.equal(b.stoppedBefore, 1);
  assert.equal(late.deadline.applied, 'soft');

  const converging = make();
  const c2 = runAttempts(converging, [
    { durationMs: 24 * MIN, passesGates: true },  // una bozza ha passato i gate
    { durationMs: 7 * MIN, passesGates: false },  // il secondo tentativo coi sibling parte
  ]);
  assert.deepEqual(c2.started, [0, 1]);
});

// Cablaggio minimo: la logica sta nel modulo; qui si controlla che create-article la usi
// per i tentativi nuovi e segni la convergenza dopo i gate, e che i default del workflow
// restino quelli storici (dura invariata).
const SRC = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');

test('create-article: tentativi nuovi sulla morbida, convergenza dopo i gate, report con le due scadenze', () => {
  assert.match(SRC, /RUN_SOFT_WALL_MS = parseWallMs\(process\.env\.CREATE_ARTICLE_SOFT_WALL_MS, DEFAULT_SOFT_WALL_MS\)/);
  assert.equal((SRC.match(/if \(newAttemptWallExceeded\(\)\) \{/g) || []).length, 2, 'topic news + evergreen');
  assert.match(SRC, /if \(attempt < maxAttempts && newAttemptWallExceeded\(\)\) \{/);
  assert.match(SRC, /lastFactCheckErrors = null;\n\s+\/\/ F3\.A\.5[^\n]*\n\s+markRunConverging\(\);/);
  assert.match(SRC, /syncDeadlineReport\(\);\n\s+Object\.assign\(RUN_REPORT, extra/);
  assert.match(SRC, /draftPassedGates: false,\n\s+deadlineApplied: null,/);
});
