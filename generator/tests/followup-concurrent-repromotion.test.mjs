/**
 * followup-concurrent-repromotion.test.mjs — una consegna reale letta come run
 * morta perché `agent:fix` ha PIÙ writer (follow-up #973, item 2 di #913).
 *
 * `isDeliveredThisRun` lega la consegna alla run corrente con tre timestamp, e
 * il primo è `promotedAt`: l'ULTIMA aggiunta di `agent:fix` nella timeline. Ma
 * quella label non la scrive solo il DRAIN — la scrivono anche
 * `scripts/ci/triage-sweep.mjs` (route diretta dei crawler) e
 * `.github/workflows/recycle-stale-prs.yml` (remove + add). Una loro scrittura
 * dopo il merge sposta `promotedAt` oltre marker e merge: il ramo DELIVERED
 * cade, la consegna riuscita consuma un tentativo, e il sintomo di #733 rientra
 * — fail-closed, quindi bounded, ma SENZA una riga nei log.
 *
 * Questi test fissano l'attribuzione della promozione (`lastFixPromotion`) e il
 * predicato che rende visibile il caso (`isConcurrentRepromotion`). L'attore
 * non discrimina — tutti e tre i writer usano il PAT del progetto — quindi la
 * firma è la FORMA: il drain promuove con una sola `gh issue edit` che aggiunge
 * `agent:fix` e toglie `agent:fix-queued`, gli altri due non hanno niente da
 * togliere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROMOTION_PAIR_WINDOW_SEC,
  lastFixPromotion,
  isConcurrentRepromotion,
  isDeliveredThisRun,
} from '../../scripts/ci/followup-drainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRAINER = path.join(ROOT, 'scripts/ci/followup-drainer.mjs');

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-09-06T09:00:00Z');
const MIN = 60_000;
const labeled = (name, at) => ({ event: 'labeled', label: { name }, created_at: iso(at) });
const unlabeled = (name, at) => ({ event: 'unlabeled', label: { name }, created_at: iso(at) });

// La promozione del DRAIN: `edit(cand, { add: [LBL_FIX], remove: [LBL_QUEUED] })`
// → i due eventi arrivano dalla stessa chiamata, a un secondo di distanza.
const drainPromotion = (at) => [unlabeled('agent:fix-queued', at), labeled('agent:fix', at + 1000)];

test('la promozione del drain si riconosce dalla coppia add agent:fix + remove agent:fix-queued', () => {
  const p = lastFixPromotion(drainPromotion(T0));
  assert.equal(p.at, T0 + 1000);
  assert.equal(p.byDrainer, true);
});

test('una `agent:fix` senza `agent:fix-queued` tolta è di un writer concorrente', () => {
  // triage-sweep: `--add-label agent:fix` su una issue senza label di routing.
  const p = lastFixPromotion([labeled('agent:fix', T0)]);
  assert.equal(p.at, T0);
  assert.equal(p.byDrainer, false);
});

test('recycle-stale-prs (remove + add di agent:fix) non è la firma del drainer', () => {
  const p = lastFixPromotion([
    unlabeled('agent:fix', T0),
    labeled('agent:fix', T0 + 2000),
  ]);
  assert.equal(p.at, T0 + 2000);
  assert.equal(p.byDrainer, false);
});

test('un `agent:fix-queued` tolto in un ciclo PRECEDENTE non attribuisce la promozione al drainer', () => {
  const stale = T0 - (PROMOTION_PAIR_WINDOW_SEC + 60) * 1000;
  const p = lastFixPromotion([unlabeled('agent:fix-queued', stale), labeled('agent:fix', T0)]);
  assert.equal(p.byDrainer, false);
});

test('timeline vuota / senza promozione → `at` null, che il ramo DELIVERED legge fail-closed', () => {
  assert.deepEqual(lastFixPromotion([]), { at: null, byDrainer: false });
  assert.deepEqual(lastFixPromotion([labeled('follow-up', T0)]), { at: null, byDrainer: false });
  assert.equal(isDeliveredThisRun({
    outcome: 'pr-created', outcomeAt: T0, mergedAt: T0 + MIN, promotedAt: null,
  }), false);
});

test('writer concorrente dopo il merge: consegna reale, DELIVERED falso, caso segnalato', () => {
  // Promozione del drain → marker → merge → ri-etichettatura concorrente.
  const promoted = T0;
  const outcomeAt = T0 + 30 * MIN;
  const mergedAt = T0 + 40 * MIN;
  const concurrent = T0 + 50 * MIN;
  const events = [
    ...drainPromotion(promoted),
    labeled('agent:fix', concurrent), // triage-sweep / recycle: nessun `agent:fix-queued` da togliere
  ];
  const promotion = lastFixPromotion(events);
  assert.equal(promotion.at, concurrent);
  assert.equal(promotion.byDrainer, false);
  assert.equal(isDeliveredThisRun({
    outcome: 'pr-created', outcomeAt, mergedAt, promotedAt: promotion.at,
  }), false, 'fail-closed: il tentativo si consuma');
  assert.equal(isConcurrentRepromotion({
    outcome: 'pr-created', outcomeAt, mergedAt, promotion,
  }), true, 'ma il caso non deve restare silenzioso');
});

test('il ciclo NORMALE (drain ri-accoda, run successiva morta) non è un falso positivo', () => {
  // Consegna del ciclo 1, poi il drain ri-promuove: marker e merge precedono la
  // promozione esattamente come nel caso concorrente — è `byDrainer` a separarli.
  const outcomeAt = T0 + 30 * MIN;
  const mergedAt = T0 + 40 * MIN;
  const promotion = lastFixPromotion([
    ...drainPromotion(T0),
    ...drainPromotion(T0 + 50 * MIN),
  ]);
  assert.equal(promotion.byDrainer, true);
  assert.equal(isConcurrentRepromotion({
    outcome: 'pr-created', outcomeAt, mergedAt, promotion,
  }), false);
});

test('nessun warning senza una consegna vera: marker non-DELIVERED, merge assente, o consegna DOPO la promozione', () => {
  const promotion = { at: T0 + 50 * MIN, byDrainer: false };
  assert.equal(isConcurrentRepromotion({
    outcome: 'no-root-cause', outcomeAt: T0, mergedAt: T0 + MIN, promotion,
  }), false, 'nessuna PR consegnata');
  assert.equal(isConcurrentRepromotion({
    outcome: 'pr-created', outcomeAt: T0, mergedAt: null, promotion,
  }), false, 'PR chiusa senza merge: non è atterrato niente');
  assert.equal(isConcurrentRepromotion({
    outcome: 'pr-created', outcomeAt: T0 + 60 * MIN, mergedAt: T0 + 70 * MIN, promotion,
  }), false, 'consegna DOPO la promozione → è `isDeliveredThisRun` a gestirla');
  assert.equal(isConcurrentRepromotion({
    outcome: 'pr-created', outcomeAt: T0, mergedAt: T0 + MIN, promotion: { at: null, byDrainer: false },
  }), false, 'promozione illeggibile → nessuna diagnosi');
});

test('entrambi i rescue (queue-managed e crawler) segnalano il caso, non solo uno', () => {
  // Il gemello del crawler è la metà che resta indietro per abitudine: qui il
  // warning deve esserci in tutti e due i pass.
  const src = fs.readFileSync(DRAINER, 'utf8');
  const hits = src.match(/if \(isConcurrentRepromotion\(\{/g) || [];
  assert.equal(hits.length, 2, 'il predicato va usato in entrambi i rescue');
  const warns = src.match(/::warning::.*writer concorrente/g) || [];
  assert.equal(warns.length, 2, 'ogni rescue emette il proprio warning');
});
