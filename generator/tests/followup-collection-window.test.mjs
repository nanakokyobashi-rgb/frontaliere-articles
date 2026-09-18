/**
 * followup-collection-window.test.mjs — il rinvio pianificato non deve più
 * essere indistinguibile da un errore di raccolta, e la finestra non deve più
 * poter crescere senza limite.
 *
 * Il guasto misurato il 2026-09-18: `collection_ok` portava DUE fatti con esiti
 * opposti sul watermark — «le sorgenti erano leggibili» e «la finestra è stata
 * drenata in una sessione». Poiché il watermark è l'inizio dell'ultima run di
 * SUCCESSO, un troncamento (batch > cap) rendeva la run rossa, il watermark
 * restava fermo, la finestra cresceva, il troncamento diventava certo: un
 * ratchet. Su questo repo 34 run rosse consecutive (157,7 h), 110 PR rinviate a
 * ogni giro; sul sito 35 run (161,6 h) con 483 PR e una finestra di 8 giorni.
 *
 * I due test sotto sono la falsificazione delle due metà della fix: togli il
 * `Math.max` del tetto e il primo rompe; rimetti il vecchio predicato
 * `batch.length === sessionBatch.length` al posto di `deferredCount` e il
 * secondo perde il suo significato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWatermarkISO,
  deferredCount,
  selectFollowupSessionBatch,
  FOLLOWUP_SESSION_BATCH_LIMIT,
} from '../../scripts/ci/collect-followup-batch.mjs';

test('computeWatermarkISO: un successo più antico del tetto non allarga la finestra', () => {
  // Replay del corpus bloccato: ultimo successo schedulato molto indietro.
  const now = Date.parse('2026-09-18T13:19:41Z');
  const stuck = JSON.stringify([
    { event: 'schedule', startedAt: '2026-09-12T00:57:02Z', status: 'completed', conclusion: 'success' },
  ]);
  assert.equal(
    computeWatermarkISO(stuck, now),
    new Date(now - 48 * 3600_000).toISOString(),
    'oltre il tetto la finestra non è ri-copribile in una sessione: il watermark deve essere clampato',
  );
});

test('computeWatermarkISO: il tetto è un limite, non un pavimento — un successo recente vince', () => {
  const now = Date.parse('2026-09-18T13:19:41Z');
  const recent = JSON.stringify([
    { event: 'schedule', startedAt: '2026-09-18T10:00:00Z', status: 'completed', conclusion: 'success' },
  ]);
  assert.equal(computeWatermarkISO(recent, now), '2026-09-18T10:00:00.000Z');
  // E un tetto esplicito più stretto resta rispettato.
  assert.equal(
    computeWatermarkISO(recent, now, 6, 1),
    new Date(now - 1 * 3600_000).toISOString(),
  );
});

test('deferredCount: conta il residuo del cap senza inventarlo', () => {
  const candidates = [1, 2, 3, 4, 5, 6];
  const session = selectFollowupSessionBatch(candidates);
  assert.equal(session.length, FOLLOWUP_SESSION_BATCH_LIMIT);
  assert.equal(deferredCount(candidates, session), candidates.length - FOLLOWUP_SESSION_BATCH_LIMIT);
  assert.equal(deferredCount([1, 2], [1, 2]), 0);
  // Input non validi non devono produrre un residuo fantasma.
  assert.equal(deferredCount(null, [1]), 0);
  assert.equal(deferredCount([1], null), 0);
  // Né un residuo negativo se la sessione fosse (per errore) più lunga.
  assert.equal(deferredCount([1], [1, 2]), 0);
});
