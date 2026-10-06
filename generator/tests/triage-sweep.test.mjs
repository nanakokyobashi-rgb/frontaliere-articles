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
  assert.equal(isTriagedButNotRouted({ labels: [{ name: 'automation-deferred' }] }), false);
  assert.equal(isTriagedButNotRouted({ labels: [{ name: 'operations-audit-review' }] }), false);
  assert.equal(isTriagedButNotRouted({ labels: [{ name: 'keep-open' }] }), false);
  assert.equal(isTriagedButNotRouted({ labels: [{ name: 'agent:no-age-out' }] }), false);
  // Un record senza titolo non è un'issue instradabile: la guardia fail-closed
  // del sito evita di riesaminarlo come se avesse perso solo la routing label.
  assert.equal(isTriagedButNotRouted({ labels: [] }), false);
  assert.equal(isTriagedButNotRouted({ labels: [{ name: 'agent:fix' }] }), false);
});
