/**
 * parked-pr-detector.test.mjs — la selezione delle PR parcheggiate.
 *
 * Il difetto che copre non è in una riga di codice, è nella SOMMA di sei skip
 * corretti: ogni strato del ciclo salta le draft con una buona ragione, e
 * insieme lasciano una draft aperta fuori da tutto. La PR #33 di questo repo
 * è rimasta così, e ci è voluto un umano che ci inciampasse.
 *
 * `nowMs` è iniettato: una soglia temporale testata contro l'orologio reale è
 * un test che cambia risposta a seconda di quando gira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectParkedPrs, DEFAULT_PARKED_HOURS } from '../../scripts/ci/parked-pr-detector.mjs';

const NOW = Date.parse('2026-08-08T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const nums = (prs) => prs.map((p) => p.number);

test('una draft ferma oltre la soglia è parcheggiata', () => {
  const prs = [{ number: 33, isDraft: true, updatedAt: hoursAgo(72), labels: [] }];
  assert.deepEqual(nums(selectParkedPrs(prs, NOW)), [33]);
});

test('una draft recente non lo è (il WIP di ieri sera non va etichettato)', () => {
  const prs = [{ number: 33, isDraft: true, updatedAt: hoursAgo(3), labels: [] }];
  assert.deepEqual(nums(selectParkedPrs(prs, NOW)), []);
});

test('una PR non-draft non lo è mai, per quanto vecchia', () => {
  // Coperta da stale-pr-rescuer → stale-review → recycle-stale-prs. Segnalarla
  // anche qui produrrebbe due segnali per lo stesso stallo.
  const prs = [{ number: 10, isDraft: false, updatedAt: hoursAgo(1000), labels: [] }];
  assert.deepEqual(nums(selectParkedPrs(prs, NOW)), []);
});

test('idempotenza: chi ha già needs-human non viene ri-selezionato', () => {
  const prs = [{
    number: 33, isDraft: true, updatedAt: hoursAgo(72),
    labels: [{ name: 'needs-human' }],
  }];
  assert.deepEqual(nums(selectParkedPrs(prs, NOW)), []);
});

test('altre label non immunizzano', () => {
  const prs = [{
    number: 33, isDraft: true, updatedAt: hoursAgo(72),
    labels: [{ name: 'collision-risk' }, { name: 'automation' }],
  }];
  assert.deepEqual(nums(selectParkedPrs(prs, NOW)), [33]);
});

test('updatedAt assente o illeggibile → NON parcheggiata (in dubbio si tace)', () => {
  const prs = [
    { number: 1, isDraft: true, labels: [] },
    { number: 2, isDraft: true, updatedAt: 'boh', labels: [] },
    { number: 3, isDraft: true, updatedAt: null, labels: [] },
  ];
  assert.deepEqual(nums(selectParkedPrs(prs, NOW)), []);
});

test('entry malformate non fanno esplodere lo scan', () => {
  const prs = [
    null,
    { isDraft: true, updatedAt: hoursAgo(72), labels: [] },
    { number: 'x', isDraft: true, updatedAt: hoursAgo(72), labels: [] },
    { number: 9, isDraft: true, updatedAt: hoursAgo(72) },
  ];
  assert.deepEqual(nums(selectParkedPrs(prs, NOW)), [9]);
});

test('input non-array o vuoto → []', () => {
  assert.deepEqual(selectParkedPrs(undefined, NOW), []);
  assert.deepEqual(selectParkedPrs([], NOW), []);
});

test('la soglia è configurabile e il default è 48h', () => {
  assert.equal(DEFAULT_PARKED_HOURS, 48);
  const pr = { number: 33, isDraft: true, updatedAt: hoursAgo(30), labels: [] };
  assert.deepEqual(nums(selectParkedPrs([pr], NOW)), [], '30h < 48h di default');
  assert.deepEqual(nums(selectParkedPrs([pr], NOW, 24)), [33], 'con soglia 24h rientra');
});

test('il confine della soglia non è inclusivo: esattamente 48h non è ancora parcheggiata', () => {
  const pr = { number: 33, isDraft: true, updatedAt: hoursAgo(48), labels: [] };
  assert.deepEqual(nums(selectParkedPrs([pr], NOW)), []);
  const older = { number: 34, isDraft: true, updatedAt: hoursAgo(48.1), labels: [] };
  assert.deepEqual(nums(selectParkedPrs([older], NOW)), [34]);
});

test('sceglie solo le parcheggiate da un elenco misto', () => {
  const prs = [
    { number: 30, isDraft: false, updatedAt: hoursAgo(500), labels: [] },        // non-draft
    { number: 31, isDraft: true, updatedAt: hoursAgo(2), labels: [] },           // recente
    { number: 32, isDraft: true, updatedAt: hoursAgo(96), labels: [{ name: 'needs-human' }] }, // già etichettata
    { number: 33, isDraft: true, updatedAt: hoursAgo(96), labels: [] },          // ← questa
  ];
  assert.deepEqual(nums(selectParkedPrs(prs, NOW)), [33]);
});
