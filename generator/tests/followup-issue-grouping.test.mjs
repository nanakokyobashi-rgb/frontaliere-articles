import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ISSUE_GROUP_MAX_SIZE,
  activeGroupDigests,
  groupIssueQueue,
  isIssueGroupable,
  issueGroupInstanceLabels,
  issueGroupingKey,
} from '../../scripts/ci/followup-drainer.mjs';

const DRAINER_SOURCE = readFileSync(
  new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url),
  'utf8',
);

const targetIssue = (number, body = 'Suggested action: `scripts/ci/followup-drainer.mjs`') => ({
  number,
  title: `Follow-up ${number}`,
  body,
  labels: [],
  createdAt: `2026-09-0${number}T00:00:00Z`,
});

test('issue con la stessa chiave produce un solo gruppo entro il tetto', () => {
  const groups = groupIssueQueue(
    [targetIssue(1), targetIssue(2), targetIssue(3)],
    { repository: 'owner/repo' },
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, ISSUE_GROUP_MAX_SIZE);
  assert.ok(groups[0].size <= ISSUE_GROUP_MAX_SIZE);
});

test('una chiave oltre il tetto viene spezzata senza crescere', () => {
  const groups = groupIssueQueue(
    [1, 2, 3, 4, 5].map((number) => targetIssue(number)),
    { repository: 'owner/repo' },
  );

  assert.deepEqual(groups.map((group) => group.size), [3, 2]);
  assert.ok(groups.every((group) => group.size <= ISSUE_GROUP_MAX_SIZE));
});

test('un issue senza chiave risolvibile resta fuori dai gruppi', () => {
  const groups = groupIssueQueue([
    { ...targetIssue(1), body: 'La descrizione non nomina un punto di riparazione.' },
    { ...targetIssue(2), body: 'La descrizione non nomina un punto di riparazione.' },
  ], { repository: 'owner/repo' });

  assert.deepEqual(groups, []);
  assert.equal(issueGroupingKey(targetIssue(1), { repository: 'owner/repo' }), 'target-file:owner/repo:scripts/ci/followup-drainer.mjs');
  assert.equal(issueGroupingKey({ ...targetIssue(1), body: 'La descrizione non nomina un punto di riparazione.' }, { repository: 'owner/repo' }), null);
});

test('la stessa firma non attraversa il confine di repository', () => {
  const groups = groupIssueQueue([
    targetIssue(1),
    { ...targetIssue(2), body: 'Target repository: other/repo\nSuggested action: `scripts/ci/followup-drainer.mjs`' },
  ], { repository: 'owner/repo' });

  assert.deepEqual(groups, []);
});

test('la firma automatica usa i primi 60 caratteri e richiede una prova strutturata', () => {
  const stable = 'Workflow Failure: ' + 'deploy-validation-monitor '.repeat(3);
  const automatic = (number, suffix) => ({
    ...targetIssue(number),
    title: `${stable}${suffix}`,
    body: '**Workflow:** deploy-validation.yml',
  });

  const first = automatic(1, ' instance-a');
  const second = automatic(2, ' instance-b');
  assert.equal(issueGroupingKey(first, { repository: 'owner/repo' }), issueGroupingKey(second, { repository: 'owner/repo' }));
  assert.equal(issueGroupingKey({ ...first, body: 'Testo umano senza marker del monitor.' }, { repository: 'owner/repo' }), null);
  assert.equal(groupIssueQueue([first, second], { repository: 'owner/repo' })[0].source, 'auto-title');
});

test('un marker automatico riconosciuto senza scope non ricade sul prefisso del titolo', () => {
  const issue = {
    ...targetIssue(1, '## Build fallito\nIl monitor non ha prodotto una destinazione leggibile.'),
    title: 'Workflow Failure: deploy-validation.yml — run 123',
  };

  assert.equal(issueGroupingKey(issue, { repository: 'owner/repo' }), null);
  assert.deepEqual(groupIssueQueue([issue, { ...issue, number: 2 }], { repository: 'owner/repo' }), []);
});

test('awaiting-production-proof esclude una issue dal preflight di raggruppamento', () => {
  const issue = {
    ...targetIssue(1),
    labels: [{ name: 'awaiting-production-proof' }],
  };

  assert.equal(isIssueGroupable(issue, {
    repository: 'owner/repo',
    canPushWorkflows: true,
  }), false);
});

test('un gruppo resta attivo finché la PR del leader è aperta, anche senza agent:fix', () => {
  const digest = '0123456789ab';
  const instanceLabel = `agent:fix-group:${digest}-42`;
  const member = {
    ...targetIssue(2),
    labels: [{ name: instanceLabel }],
  };

  assert.deepEqual(
    [...activeGroupDigests([member], [{ head: { ref: 'fix/issue-42' } }])],
    [digest],
  );
  assert.deepEqual([...activeGroupDigests([member], [])], []);
  assert.deepEqual(
    [...activeGroupDigests([{ ...member, labels: [{ name: instanceLabel }, { name: 'agent:fix' }] }], [])],
    [digest],
  );
  assert.deepEqual(
    issueGroupInstanceLabels({ labels: [{ name: instanceLabel }, { name: 'agent:fix-group:malformed' }] }),
    [instanceLabel, 'agent:fix-group:malformed'],
  );
});

test('il rescue rimuove i marker B19 prima di ogni riarmo o park', () => {
  const queueStart = DRAINER_SOURCE.indexOf('// --- RESCUE + PARK: agent:fix');
  const crawlerStart = DRAINER_SOURCE.indexOf('// --- CRAWLER RESCUE + PARK (non-queue-managed');
  const decomposeStart = DRAINER_SOURCE.indexOf('// --- DECOMPOSE-RESCUE + DECOMPOSE-DRAIN');
  const queueRescue = DRAINER_SOURCE.slice(queueStart, crawlerStart);
  const crawlerRescue = DRAINER_SOURCE.slice(crawlerStart, decomposeStart);

  assert.ok(queueStart >= 0 && crawlerStart > queueStart && decomposeStart > crawlerStart);
  assert.match(queueRescue, /if \(!clearIssueGroupLabels\(iss\)\)/);
  assert.match(crawlerRescue, /if \(!clearIssueGroupLabels\(iss\)\)/);
});
