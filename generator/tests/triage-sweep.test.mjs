/**
 * Regressione per il caricamento del triage sweep.
 *
 * Il run schedulato deve poter linkare il predicato esportato dal
 * classificatore: un named import mancante rompe il modulo prima di eseguire
 * qualsiasi recupero di issue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIssue } from '../../scripts/lib/classify-issue.mjs';
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

test('triage conserva automation-deferred e l evidenza dei domini di rischio', () => {
  const deferred = {
    title: 'Workflow Failure: crawler transport',
    body: '',
    labels: [{ name: 'automation-deferred' }],
  };
  assert.equal(classifyIssue(deferred.title, deferred.labels, deferred.body).route, 'none');
  assert.equal(isTriagedButNotRouted(deferred), false, 'automation-deferred non deve rientrare nel routing');

  const risk = {
    title: 'Aggiornare il workflow di deploy del service account con permessi',
    body: '',
    labels: [{ name: 'follow-up' }],
  };
  const decision = classifyIssue(risk.title, risk.labels, risk.body);
  assert.equal(decision.riskBlocked, false, 'i domini sono evidenza, come nel sito');
  assert.deepEqual(decision.riskDomains, [
    'deploy-workflow-functions',
    'secrets-roles-permissions',
  ]);
  assert.equal(isTriagedButNotRouted(risk), true, 'un rischio evidenziato resta nella coda ordinaria');
});
