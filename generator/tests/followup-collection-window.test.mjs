/**
 * followup-collection-window.test.mjs — la finestra di raccolta non deve
 * dipendere dall'esito delle run, e il residuo del cap deve restare
 * raggiungibile.
 *
 * Il guasto misurato il 2026-09-18: `collection_ok` portava DUE fatti con esiti
 * opposti sul watermark — «le sorgenti erano leggibili» e «la finestra è stata
 * drenata in una sessione» — e il watermark era l'inizio dell'ultima run di
 * SUCCESSO. Quella definizione sbaglia in ENTRAMBI i versi:
 *
 *  - run troncata dal cap che esce ROSSA → il watermark non avanza ma la
 *    finestra cresce senza limite, e il verde diventa irraggiungibile: 34 run
 *    rosse consecutive su questo repo (157,7 h), 35 sul sito (161,6 h, finestra
 *    di 8,0 giorni e 737 PR candidate);
 *  - run troncata che esce VERDE → il watermark avanza all'inizio della run e
 *    le PR oltre il prefisso di `FOLLOWUP_SESSION_BATCH_LIMIT` non rientrano
 *    più in nessuna finestra: perdita silenziosa (finding 🔴 della review sul
 *    gemello del sito).
 *
 * Il cursore durevole per-PR è il commento marker, non il watermark: quindi la
 * finestra è un lookback FISSO e i candidati si servono dal più VECCHIO.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectionWindowStartISO,
  positiveHours,
  deferredCount,
  orderCandidatesFifo,
  selectFollowupSessionBatch,
  FOLLOWUP_SESSION_BATCH_LIMIT,
} from '../../scripts/ci/collect-followup-batch.mjs';

test('la finestra e un lookback fisso, indipendente dallo storico delle run', () => {
  const now = Date.parse('2026-09-18T13:19:41Z');
  assert.equal(collectionWindowStartISO(now), new Date(now - 48 * 3600_000).toISOString());
  assert.equal(collectionWindowStartISO(now, 3), new Date(now - 3 * 3600_000).toISOString());
});

test('un override malformato non sposta il confine nel futuro', () => {
  const now = Date.parse('2026-09-18T13:19:41Z');
  const fallback = new Date(now - 48 * 3600_000).toISOString();
  for (const bad of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY, 'abc']) {
    const got = collectionWindowStartISO(now, bad);
    assert.equal(got, fallback, `override ${String(bad)} non deve essere accettato`);
    assert.ok(Date.parse(got) < now, 'il confine deve restare nel passato');
  }
  assert.equal(positiveHours('12', 48), 12);
  assert.equal(positiveHours('-1', 48), 48);
  assert.equal(positiveHours('Infinity', 48), 48);
});

test('ordine FIFO: il cap rinvia le PR recenti, non quelle vecchie', () => {
  // Ordine naturale della Search API: dal più recente. Una PR oltre il cap,
  // così il test resta vero qualunque sia il valore di FOLLOWUP_SESSION_BATCH_LIMIT.
  const total = FOLLOWUP_SESSION_BATCH_LIMIT + 1;
  const base = Date.parse('2026-09-17T00:00:00Z');
  const searchApiOrder = Array.from({ length: total }, (_, i) => ({
    number: 2000 - i,
    mergedAt: new Date(base + (total - i) * 3600_000).toISOString(),
  }));
  const ordered = orderCandidatesFifo(searchApiOrder);
  assert.deepEqual(
    ordered.map((p) => p.number),
    searchApiOrder.map((p) => p.number).reverse(),
  );
  const session = selectFollowupSessionBatch(ordered.map((p) => p.number));
  assert.equal(session.length, FOLLOWUP_SESSION_BATCH_LIMIT);
  // Le più VECCHIE entrano in sessione; la più recente (#2000) è quella rinviata.
  assert.ok(!session.includes(2000));
  assert.equal(session[0], 2000 - FOLLOWUP_SESSION_BATCH_LIMIT);
  assert.equal(deferredCount(ordered, session), 1);
  // L'input non viene mutato e una data illeggibile non fa esplodere l'ordine.
  const snapshot = searchApiOrder.map((p) => p.number);
  orderCandidatesFifo([...searchApiOrder, { number: 9, mergedAt: 'nope' }]);
  assert.deepEqual(searchApiOrder.map((p) => p.number), snapshot);
  assert.deepEqual(orderCandidatesFifo(null), []);
});

// Capacità vs flusso (2026-09-27). Con cap 4 la coda non si smaltiva: ~5 run
// reali/giorno (cron ogni 3h, gap mediano misurato 4,9h) = ~20 PR/giorno contro
// rinvii di 29-146 PR a ogni run. Il cap deve coprire il picco misurato dei
// candidati del sito (~80/giorno: 110 merge x ~72% oltre i gate) alla cadenza
// REALE, e il caso peggiore per PR misurato sul corpus (399 s/PR, bootstrap
// incluso) moltiplicato per il cap deve stare sotto il watchdog Codex del
// workflow. Alzare il cap senza il watchdog (o viceversa) rompe questo test.
const MEASURED_RUNS_PER_DAY = 5;
const PEAK_CANDIDATES_PER_DAY = 80;
const WORST_SECONDS_PER_PR = 399;

test('il cap di sessione copre il picco di candidati alla cadenza reale', () => {
  assert.ok(
    FOLLOWUP_SESSION_BATCH_LIMIT * MEASURED_RUNS_PER_DAY >= PEAK_CANDIDATES_PER_DAY,
    `cap ${FOLLOWUP_SESSION_BATCH_LIMIT} x ${MEASURED_RUNS_PER_DAY} run/giorno < ${PEAK_CANDIDATES_PER_DAY}`,
  );
});

test('il cap di sessione x il caso peggiore per PR sta sotto il watchdog Codex', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/post-merge-followup.yml', import.meta.url),
    'utf8',
  );
  const watchdog = Number(/exec_timeout_seconds: '(\d+)'/u.exec(workflow)?.[1]);
  assert.ok(watchdog > 0, 'exec_timeout_seconds non trovato nel workflow');
  assert.ok(
    FOLLOWUP_SESSION_BATCH_LIMIT * WORST_SECONDS_PER_PR <= watchdog,
    `cap ${FOLLOWUP_SESSION_BATCH_LIMIT} x ${WORST_SECONDS_PER_PR}s > watchdog ${watchdog}s`,
  );
});

test('deferredCount: conta il residuo del cap senza inventarlo', () => {
  assert.equal(deferredCount([1, 2, 3, 4, 5, 6], [1, 2, 3, 4]), 2);
  assert.equal(deferredCount([1, 2], [1, 2]), 0);
  assert.equal(deferredCount(null, [1]), 0);
  assert.equal(deferredCount([1], [1, 2]), 0);
});
