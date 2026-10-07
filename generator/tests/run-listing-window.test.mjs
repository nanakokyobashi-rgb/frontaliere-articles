/**
 * run-listing-window.test.mjs — equivalente in node:test della parte unitaria
 * del test vitest del sito (`tests/run-listing-created-window.test.ts`).
 *
 * `scripts/ci/lib/run-listing-window.mjs` e' un gemello `identical`: il
 * comportamento si prova anche qui perche' il drift check confronta i byte dei
 * due file, non l'esistenza di un osservatore da ciascun lato. Il modulo e'
 * registrato prima del suo importatore (`close-recovered-failure-issues.mjs`),
 * che sul sito lo usa per dare a ogni elenco di run per branch una finestra
 * `created`: senza finestra l'API restituisce a tratti un elenco fermo a
 * settimane prima.
 */
import './lib/stdout-off-runner-pipe.mjs'; // stdout e' la pipe dei frame di node:test (issue 1819)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createdSince,
  createdSinceFilter,
  createdSinceQuery,
  newestFirst,
} from '../../scripts/ci/lib/run-listing-window.mjs';

const NOW = Date.UTC(2030, 0, 10, 12, 0, 0);

test('createdSince tronca al giorno UTC e non accorcia mai la finestra', () => {
  assert.equal(createdSince(9, NOW), '2030-01-01');
  assert.equal(createdSince(0.5, NOW), '2030-01-10');
  assert.equal(createdSince(3, NOW), '2030-01-07');
  assert.throws(() => createdSince(0, NOW), TypeError);
  assert.throws(() => createdSince(Number.NaN, NOW), TypeError);
  assert.throws(() => createdSince(-1, NOW), TypeError);
});

test('filtro per `gh run list --created` e parametro REST gia\' codificato', () => {
  assert.equal(createdSinceFilter(9, NOW), '>=2030-01-01');
  assert.equal(createdSinceQuery(9, NOW), 'created=%3E%3D2030-01-01');
});

test('newestFirst ordina le due forme di run e non muta l\'ingresso', () => {
  const rest = [
    { id: 1, created_at: '2030-01-01T00:00:00Z' },
    { id: 2, created_at: '2030-01-03T00:00:00Z' },
  ];
  assert.deepEqual(newestFirst(rest).map((run) => run.id), [2, 1]);
  assert.deepEqual(rest.map((run) => run.id), [1, 2]);

  const cli = [
    { databaseId: 1, createdAt: '2030-01-02T00:00:00Z' },
    { databaseId: 2 },
    { databaseId: 3, createdAt: '2030-01-05T00:00:00Z' },
  ];
  // Una run senza data valida finisce in fondo, non in testa.
  assert.deepEqual(newestFirst(cli).map((run) => run.databaseId), [3, 1, 2]);
  assert.deepEqual(newestFirst(null), []);
});
