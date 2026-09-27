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
  FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_DURATION_MS,
  FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_PR_COUNT,
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

// Capacità vs flusso (2026-09-27). Con cap 4 e cron ogni 3h la coda non si
// smaltiva: GitHub esegue ~62% dei cron nominali (5,1 run reali/giorno su 8,
// gap mediano 4,9h) = ~20 PR/giorno contro rinvii di 29-146 PR a ogni run.
// Tre vincoli, letti dal workflow reale così che cap, watchdog, step e cron non
// possano divergere in silenzio:
//  1. cap <= PR della sessione COMPLETATA misurata (36352293610: 14 PR,
//     1.502.814 ms, triage_complete=true), e quella durata sotto il watchdog.
//     Si confronta la sessione intera: la media per PR non è un upper bound, e
//     >=451 s/PR di 36009410204 è censurato (run uccisa), non un bound;
//  2. watchdog + setup/kill grace/coda (300 s) STRETTAMENTE sotto lo step;
//  3. cap x run reali/giorno (cron nominali x 62%) >= picco di ~80 candidati
//     al giorno (sito: 110 merge x ~72% oltre i gate).
const CODEX_SETUP_AND_TAIL_SECONDS = 300;
const CRON_EXECUTED_RATIO = 0.62;
const PEAK_CANDIDATES_PER_DAY = 80;

function workflowBudget() {
  const workflow = readFileSync(
    new URL('../../.github/workflows/post-merge-followup.yml', import.meta.url),
    'utf8',
  );
  const watchdog = Number(/exec_timeout_seconds: '(\d+)'/u.exec(workflow)?.[1]);
  const stepAt = workflow.indexOf('id: followup\n');
  const stepHead = workflow.slice(workflow.lastIndexOf('      - name:', stepAt), stepAt);
  const stepMinutes = Number(/timeout-minutes: (\d+)/u.exec(stepHead)?.[1]);
  const hours = Number(/cron: '\d+ \*\/(\d+) \* \* \*'/u.exec(workflow)?.[1]);
  return { watchdog, stepMinutes, cronPerDay: 24 / hours };
}

test('la sessione completata dimensiona il cap sotto watchdog e step', () => {
  const { watchdog, stepMinutes } = workflowBudget();
  assert.ok(watchdog > 0 && stepMinutes > 0, 'watchdog o timeout dello step non trovati');
  assert.ok(
    FOLLOWUP_SESSION_BATCH_LIMIT <= FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_PR_COUNT,
    `cap ${FOLLOWUP_SESSION_BATCH_LIMIT} oltre la sessione completata misurata`,
  );
  assert.ok(
    FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_DURATION_MS < watchdog * 1000,
    `sessione misurata ${FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_DURATION_MS}ms oltre il watchdog ${watchdog}s`,
  );
  assert.ok(
    watchdog + CODEX_SETUP_AND_TAIL_SECONDS < stepMinutes * 60,
    `watchdog ${watchdog}s + ${CODEX_SETUP_AND_TAIL_SECONDS}s non sta sotto lo step da ${stepMinutes} min`,
  );
});

test('il cap alla cadenza reale del cron copre il picco di candidati', () => {
  const { cronPerDay } = workflowBudget();
  assert.ok(Number.isFinite(cronPerDay), 'cron */N non trovato nel workflow');
  const capacity = FOLLOWUP_SESSION_BATCH_LIMIT * cronPerDay * CRON_EXECUTED_RATIO;
  assert.ok(
    capacity >= PEAK_CANDIDATES_PER_DAY,
    `capacità ${capacity.toFixed(1)} PR/giorno < picco ${PEAK_CANDIDATES_PER_DAY}`,
  );
});

test('deferredCount: conta il residuo del cap senza inventarlo', () => {
  assert.equal(deferredCount([1, 2, 3, 4, 5, 6], [1, 2, 3, 4]), 2);
  assert.equal(deferredCount([1, 2], [1, 2]), 0);
  assert.equal(deferredCount(null, [1]), 0);
  assert.equal(deferredCount([1], [1, 2]), 0);
});
