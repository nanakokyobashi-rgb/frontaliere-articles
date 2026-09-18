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
  // Ordine naturale della Search API: dal più recente.
  const searchApiOrder = [
    { number: 1572, mergedAt: '2026-09-18T12:00:00Z' },
    { number: 1560, mergedAt: '2026-09-18T06:00:00Z' },
    { number: 1552, mergedAt: '2026-09-17T23:00:00Z' },
    { number: 1545, mergedAt: '2026-09-17T08:00:00Z' },
    { number: 1530, mergedAt: '2026-09-17T01:00:00Z' },
  ];
  const ordered = orderCandidatesFifo(searchApiOrder);
  assert.deepEqual(ordered.map((p) => p.number), [1530, 1545, 1552, 1560, 1572]);
  const session = selectFollowupSessionBatch(ordered.map((p) => p.number));
  assert.equal(session.length, FOLLOWUP_SESSION_BATCH_LIMIT);
  assert.deepEqual(session, [1530, 1545, 1552, 1560]);
  assert.equal(deferredCount(ordered, session), 1);
  // L'input non viene mutato e una data illeggibile non fa esplodere l'ordine.
  const snapshot = searchApiOrder.map((p) => p.number);
  orderCandidatesFifo([...searchApiOrder, { number: 9, mergedAt: 'nope' }]);
  assert.deepEqual(searchApiOrder.map((p) => p.number), snapshot);
  assert.deepEqual(orderCandidatesFifo(null), []);
});

test('deferredCount: conta il residuo del cap senza inventarlo', () => {
  assert.equal(deferredCount([1, 2, 3, 4, 5, 6], [1, 2, 3, 4]), 2);
  assert.equal(deferredCount([1, 2], [1, 2]), 0);
  assert.equal(deferredCount(null, [1]), 0);
  assert.equal(deferredCount([1], [1, 2]), 0);
});
