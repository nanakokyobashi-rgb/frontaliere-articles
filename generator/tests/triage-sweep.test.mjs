/**
 * Regressione per il caricamento del triage sweep.
 *
 * Il run schedulato deve poter linkare il predicato esportato dal
 * classificatore: un named import mancante rompe il modulo prima di eseguire
 * qualsiasi recupero di issue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTriagedButNotRouted } from '../../scripts/ci/triage-sweep.mjs';

test('triage-sweep si importa e non riesamina i pin locali senza routing', () => {
  assert.equal(isTriagedButNotRouted({ labels: [{ name: 'backlog' }] }), false);
  assert.equal(isTriagedButNotRouted({ labels: [{ name: 'needs-human' }] }), false);
  assert.equal(isTriagedButNotRouted({ labels: [] }), true);
  assert.equal(isTriagedButNotRouted({ labels: [{ name: 'agent:fix' }] }), false);
});
