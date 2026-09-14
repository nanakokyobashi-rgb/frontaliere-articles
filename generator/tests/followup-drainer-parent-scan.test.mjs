/**
 * Contratti della scansione PARENT-CLOSE (#7645).
 *
 * Il cursore deve sopravvivere a dispatch nello stesso bucket, cron irregolari,
 * riordinamenti della lista GitHub e a un budget che si esaurisce dentro la
 * finestra. Il test resta dependency-free e non chiama GitHub.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rotateForScan, scanWindowOffset } from '../../scripts/ci/followup-drainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRAINER = readFileSync(path.join(ROOT, 'scripts/ci/followup-drainer.mjs'), 'utf8');
const periodMs = 20 * 60_000;
const issue = (number) => ({ number });
const stable = (parent) => parent.number;

test('il cursore usa il run number, non il bucket dell orologio', () => {
  const sameBucket = { scanMax: 5, periodMs, now: periodMs * 900, advanceBy: 1 };
  assert.equal(scanWindowOffset(39, { ...sameBucket, runNumber: 12 }), 12);
  assert.equal(scanWindowOffset(39, { ...sameBucket, runNumber: 13 }), 13);

  // Il cron può saltare un intervallo: la run successiva conserva il proprio
  // numero sequenziale e non salta una finestra insieme all orologio.
  assert.equal(
    scanWindowOffset(39, {
      scanMax: 5,
      periodMs,
      now: periodMs * 904,
      runNumber: 14,
      advanceBy: 1,
    }),
    14,
  );
});

test('ordine e pool mutabili non cambiano l ancora stabile', () => {
  const opts = {
    scanMax: 3,
    periodMs,
    now: 0,
    runNumber: 2,
    advanceBy: 1,
    stableKey: stable,
  };
  const first = rotateForScan([issue(80), issue(20), issue(50), issue(10)], opts);
  const mutated = rotateForScan([issue(50), issue(90), issue(10), issue(80), issue(20)], opts);

  assert.deepEqual(first.map((parent) => parent.number), [50, 80, 10, 20]);
  assert.deepEqual(mutated.map((parent) => parent.number), [50, 80, 90, 10, 20]);
  assert.deepEqual(
    rotateForScan([issue(20), issue(80), issue(10), issue(50)], opts).map((parent) => parent.number),
    first.map((parent) => parent.number),
  );
});

test('un budget parziale non lascia buchi permanenti nella finestra', () => {
  const pool = Array.from({ length: 39 }, (_, index) => issue(index + 1));
  const seen = new Set();

  // Due esami effettivi per run su un cap di cinque: il passo unitario fa
  // scorrere la finestra sovrapposta e copre tutti i 39 padri.
  for (let runNumber = 0; runNumber < pool.length; runNumber += 1) {
    const window = rotateForScan(pool, {
      scanMax: 5,
      periodMs,
      now: 0,
      runNumber,
      advanceBy: 1,
      stableKey: stable,
    });
    for (const parent of window.slice(0, 2)) seen.add(parent.number);
  }

  assert.equal(seen.size, pool.length);
});

test('il cursore parent-close non arretra quando cambia il budget', () => {
  const fullBudget = scanWindowOffset(39, {
    scanMax: 5,
    periodMs,
    now: 0,
    runNumber: 100,
    advanceBy: 1,
  });
  const partialBudget = scanWindowOffset(39, {
    scanMax: 5,
    periodMs,
    now: 0,
    runNumber: 101,
    advanceBy: 1,
  });

  assert.equal(fullBudget, 22);
  assert.equal(partialBudget, (fullBudget + 1) % 39);
});

test('parent-dequeue è bounded e riserva il budget al parent-close', () => {
  const parentStage = DRAINER.slice(
    DRAINER.indexOf('// --- PARENT-CLOSE:'),
    DRAINER.indexOf('// --- PRODUCTION-PROOF:'),
  );

  assert.match(parentStage, /PARENT_DEQUEUE_MAX_PER_RUN/);
  assert.match(parentStage, /budget\.take\(`#\$\{p\.number\} \(parent-dequeue\)/);
  assert.match(parentStage, /parentCloseReserveMs/);
  assert.match(parentStage, /runNumber: process\.env\.GITHUB_RUN_NUMBER/);
  assert.match(parentStage, /advanceBy: 1/);
  assert.doesNotMatch(parentStage, /parentCloseAdvance/);
  assert.match(parentStage, /stableKey: \(parent\) => parent\?\.number/);
  assert.doesNotMatch(parentStage, /for \(const p of parents\.filter/);
});
