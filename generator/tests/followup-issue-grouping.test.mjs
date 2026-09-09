import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ISSUE_GROUP_MAX_SIZE,
  groupIssueQueue,
  issueGroupingKey,
} from '../../scripts/ci/followup-drainer.mjs';

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
