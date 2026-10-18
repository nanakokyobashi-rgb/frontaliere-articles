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
  const issue = (labels) => ({
    title: 'follow-up(#1): ordinary triage candidate',
    body: '',
    labels,
  });
  assert.equal(isTriagedButNotRouted(issue([{ name: 'backlog' }])), false);
  assert.equal(isTriagedButNotRouted(issue([{ name: 'needs-human' }])), false);
  assert.equal(isTriagedButNotRouted(issue([{ name: 'automation-deferred' }])), false);
  assert.equal(isTriagedButNotRouted(issue([{ name: 'operations-audit-review' }])), false);
  assert.equal(isTriagedButNotRouted(issue([{ name: 'keep-open' }])), false);
  assert.equal(isTriagedButNotRouted(issue([{ name: 'agent:no-age-out' }])), false);
  assert.equal(isTriagedButNotRouted(issue([])), true);
  assert.equal(isTriagedButNotRouted(issue([{ name: 'agent:fix' }])), false);
});
