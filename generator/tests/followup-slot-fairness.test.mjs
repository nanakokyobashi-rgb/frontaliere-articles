/**
 * followup-slot-fairness.test.mjs — equità dello slot `issue-fix` (follow-up
 * #973, item 3 di #913).
 *
 * Il re-queue gratuito di una consegna (ramo DELIVERED, #733) è un bound di
 * TERMINAZIONE: dice che una issue che consegna non consuma tentativi. Non dice
 * niente su chi tiene lo slot. Con l'ordinamento `prio || createdAt` una
 * aggregata che consegna a ogni ciclo rientra in coda con il suo `createdAt` —
 * il più vecchio della sua classe — e si ri-prende l'unico slot serializzato al
 * tick successivo, indefinitamente: nessun'altra issue avanza, e ogni singolo
 * tick preso da solo è corretto, quindi la starvation non lascia traccia.
 *
 * Questi test fissano il round-robin che la chiude: chi ha tenuto lo slot più
 * di recente passa dietro, chi non lo ha mai tenuto passa davanti, la classe di
 * priorità non si scavalca mai e la finestra misurata resta bounded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SLOT_FAIRNESS_SCAN_MAX,
  slotFairnessWindow,
  slotFairnessOrder,
} from '../../scripts/ci/followup-drainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRAINER = path.join(ROOT, 'scripts/ci/followup-drainer.mjs');

const T0 = Date.parse('2026-09-06T09:00:00Z');
const H = 3_600_000;
const iss = (number, { prio = 'low', createdAt = T0 } = {}) => ({
  number,
  createdAt: new Date(createdAt).toISOString(),
  labels: [{ name: 'follow-up' }, { name: `fu-prio:${prio}` }],
});
const nums = (list) => list.map((i) => i.number);

test('la finestra copre solo la classe di priorità della testa', () => {
  const q = [iss(1, { prio: 'high' }), iss(2, { prio: 'high' }), iss(3, { prio: 'low' })];
  assert.deepEqual(nums(slotFairnessWindow(q)), [1, 2]);
});

test('la finestra è bounded a scanMax', () => {
  const q = [1, 2, 3, 4, 5, 6, 7].map((n) => iss(n));
  assert.equal(slotFairnessWindow(q, { scanMax: 3 }).length, 3);
  assert.equal(slotFairnessWindow(q).length, SLOT_FAIRNESS_SCAN_MAX);
});

test('coda con un solo candidato: nessuna finestra, nessuna rotazione', () => {
  const q = [iss(1)];
  assert.deepEqual(slotFairnessWindow(q), []);
  assert.deepEqual(nums(slotFairnessOrder(q, new Map([[1, T0]]))), [1]);
});

test('una testa che ha appena tenuto lo slot passa dietro a chi lo ha tenuto prima', () => {
  // #10 è la più vecchia (aggregata che consegna a ogni ciclo) e senza rotazione
  // resterebbe in testa per sempre.
  const q = [iss(10, { createdAt: T0 }), iss(20, { createdAt: T0 + H })];
  const promoted = new Map([[10, T0 + 20 * H], [20, T0 + 2 * H]]);
  assert.deepEqual(nums(slotFairnessOrder(q, promoted)), [20, 10]);
});

test('chi non ha mai tenuto lo slot passa davanti a chi lo ha tenuto', () => {
  const q = [iss(10), iss(20), iss(30)];
  const promoted = new Map([[10, T0 + 20 * H], [20, null], [30, T0 + 2 * H]]);
  assert.deepEqual(nums(slotFairnessOrder(q, promoted)), [20, 30, 10]);
});

test('un `promotedAt` illeggibile vale «mai promossa» — fail-safe verso il giro fuori turno, mai la starvation', () => {
  const q = [iss(10), iss(20)];
  // #20 assente dalla mappa (glitch `gh api events`): non deve restare dietro
  // in eterno solo perché la sua misura è mancata.
  assert.deepEqual(nums(slotFairnessOrder(q, new Map([[10, T0 + H]]))), [20, 10]);
});

test('a parità di `promotedAt` sopravvive l ordine `createdAt` pre-esistente (sort stabile)', () => {
  const q = [iss(10), iss(20), iss(30)];
  const promoted = new Map([[10, T0], [20, T0], [30, T0]]);
  assert.deepEqual(nums(slotFairnessOrder(q, promoted)), [10, 20, 30]);
});

test('una `fu-prio:low` non scavalca mai una `fu-prio:high`, per quanto la high sia recidiva', () => {
  const q = [iss(10, { prio: 'high' }), iss(20, { prio: 'low' })];
  const promoted = new Map([[10, T0 + 20 * H], [20, null]]);
  assert.deepEqual(nums(slotFairnessOrder(q, promoted)), [10, 20]);
});

test('la coda oltre la finestra resta intatta', () => {
  const q = [10, 20, 30, 40, 50, 60].map((n) => iss(n));
  const promoted = new Map([[10, T0 + 5 * H], [20, T0], [30, T0 + H]]);
  const out = slotFairnessOrder(q, promoted, { scanMax: 3 });
  assert.deepEqual(nums(out), [20, 30, 10, 40, 50, 60]);
});

test('round-robin: due cicli consecutivi non danno lo slot alla stessa issue', () => {
  const q = [iss(10), iss(20)];
  const promoted = new Map([[10, T0], [20, null]]);
  const first = slotFairnessOrder(q, promoted);
  assert.equal(first[0].number, 20);
  // #20 ha appena tenuto lo slot → al tick successivo tocca a #10.
  promoted.set(20, T0 + H);
  assert.equal(slotFairnessOrder(q, promoted)[0].number, 10);
});

test('il DRAIN misura la finestra e usa l ordine ruotato', () => {
  const src = fs.readFileSync(DRAINER, 'utf8');
  const drain = src.slice(src.indexOf('const fairWindow = slotFairnessWindow(queued)'));
  assert.ok(drain.length, 'il DRAIN deve calcolare la finestra di equità');
  const head = drain.slice(0, 2000);
  assert.match(head, /fixPromotion\(iss\.number\)\.at/, 'la misura è l ultima promozione `agent:fix`');
  assert.match(head, /queued = rotated/, 'la coda usata dal loop di promozione è quella ruotata');
  assert.match(head, /budget\.canAfford/, 'la finestra si misura solo se il budget la copre INTERA');
  assert.match(head, /no silent cap/, 'una rotazione saltata per budget va dichiarata nel log');
});
