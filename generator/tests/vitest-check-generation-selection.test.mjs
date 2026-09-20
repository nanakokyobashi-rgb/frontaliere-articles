/**
 * vitest-check-generation-selection.test.mjs — il verdetto segue la
 * generazione del check-run, non l'ordine di completamento del runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VITEST_CHECK_NAME } from '../../scripts/ci/lib/constants.mjs';
import {
  RUN_SELECTION_STATES,
  latestCompletedConclusionByName,
  latestCompletedRunByName,
  latestCompletedRunSelectionByName,
} from '../../scripts/ci/lib/vitestCheck.mjs';

const HEAD = 'a'.repeat(40);

function run({
  id,
  conclusion = null,
  status = 'completed',
  createdAt,
  completedAt = createdAt,
  headSha = HEAD,
  runAttempt,
  workflowRunId,
} = {}) {
  const value = {
    id,
    name: VITEST_CHECK_NAME,
    status,
    conclusion,
    head_sha: headSha,
    created_at: createdAt,
    completed_at: completedAt,
  };
  if (runAttempt !== undefined) value.run_attempt = runAttempt;
  if (workflowRunId !== undefined) {
    value.created_at = null;
    value.details_url = `https://github.com/owner/repo/actions/runs/${workflowRunId}/job/${id}`;
    value.check_suite = { id };
    value.external_id = `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
  }
  return value;
}

test('la generazione nuova vince quando il rerun vecchio conclude dopo', () => {
  const newer = run({
    id: 200,
    conclusion: 'success',
    createdAt: '2026-09-20T10:05:00Z',
    completedAt: '2026-09-20T10:06:00Z',
  });
  const oldRerun = run({
    id: 199,
    conclusion: 'failure',
    createdAt: '2026-09-20T10:00:00Z',
    completedAt: '2026-09-20T10:07:00Z',
  });

  const selection = latestCompletedRunSelectionByName([newer, oldRerun], VITEST_CHECK_NAME);
  assert.equal(selection.state, RUN_SELECTION_STATES.SELECTED);
  assert.equal(selection.run, newer);
  assert.equal(latestCompletedConclusionByName([newer, oldRerun], VITEST_CHECK_NAME), 'success');
});

test('una generazione nuova pending impedisce di usare il verdetto vecchio', () => {
  const oldSuccess = run({
    id: 300,
    conclusion: 'success',
    createdAt: '2026-09-20T11:00:00Z',
    completedAt: '2026-09-20T11:01:00Z',
  });
  const newerPending = run({
    id: 301,
    status: 'in_progress',
    createdAt: '2026-09-20T11:05:00Z',
    completedAt: null,
  });

  const selection = latestCompletedRunSelectionByName([oldSuccess, newerPending], VITEST_CHECK_NAME);
  assert.equal(selection.state, RUN_SELECTION_STATES.PENDING);
  assert.equal(latestCompletedRunByName([oldSuccess, newerPending], VITEST_CHECK_NAME), null);
  assert.equal(latestCompletedConclusionByName([oldSuccess, newerPending], VITEST_CHECK_NAME), '');
});

test('run_attempt precede l id quando la creazione è la stessa', () => {
  const firstAttempt = run({
    id: 402,
    conclusion: 'failure',
    createdAt: '2026-09-20T12:00:00Z',
    completedAt: '2026-09-20T12:02:00Z',
    runAttempt: 1,
  });
  const rerun = run({
    id: 401,
    conclusion: 'success',
    createdAt: '2026-09-20T12:00:00Z',
    completedAt: '2026-09-20T12:01:00Z',
    runAttempt: 2,
  });

  assert.equal(
    latestCompletedRunByName([firstAttempt, rerun], VITEST_CHECK_NAME),
    rerun,
  );
});

test('metadati di generazione parziali non ricadono sull id del check-run', () => {
  const sameTimestamp = '2026-09-20T12:30:00Z';
  const withAttemptAndWorkflow = {
    ...run({
      id: 503,
      conclusion: 'failure',
      createdAt: sameTimestamp,
      completedAt: '2026-09-20T12:32:00Z',
      runAttempt: 1,
    }),
    details_url: 'https://github.com/owner/repo/actions/runs/3001/job/503?attempt=1#summary',
  };
  const withoutAttemptOrWorkflow = run({
    id: 502,
    conclusion: 'success',
    createdAt: sameTimestamp,
    completedAt: '2026-09-20T12:31:00Z',
  });

  for (const checkRuns of [
    [withAttemptAndWorkflow, withoutAttemptOrWorkflow],
    [withoutAttemptOrWorkflow, withAttemptAndWorkflow],
  ]) {
    const selection = latestCompletedRunSelectionByName(checkRuns, VITEST_CHECK_NAME);
    assert.equal(selection.state, RUN_SELECTION_STATES.AMBIGUOUS);
    assert.equal(selection.reason, 'incomparable-generation-metadata');
    assert.equal(latestCompletedRunByName(checkRuns, VITEST_CHECK_NAME), null);
  }
});

test('la forma REST senza timestamp usa l ID del workflow, non l id del check-run', () => {
  const newer = run({
    id: 701,
    workflowRunId: '2002',
    conclusion: 'success',
    createdAt: null,
    completedAt: '2026-09-20T12:06:00Z',
  });
  const oldRerun = run({
    id: 799,
    workflowRunId: '2001',
    conclusion: 'failure',
    createdAt: null,
    completedAt: '2026-09-20T12:07:00Z',
  });

  const selection = latestCompletedRunSelectionByName([newer, oldRerun], VITEST_CHECK_NAME);
  assert.equal(selection.state, RUN_SELECTION_STATES.SELECTED);
  assert.equal(selection.run, newer);
});

test('head SHA misti, id duplicato o metadati invalidi sono ambiguous e fail-closed', () => {
  const valid = run({
    id: 500,
    conclusion: 'success',
    createdAt: '2026-09-20T13:00:00Z',
  });
  const cases = [
    [valid, run({ id: 501, conclusion: 'failure', createdAt: '2026-09-20T13:01:00Z', headSha: 'b'.repeat(40) })],
    [valid, { ...valid, conclusion: 'failure' }],
    [valid, { ...valid, details_url: 'https://github.com/owner/repo/actions/runs/2001/job/501' }],
    [valid, { ...valid, external_id: '00000000-0000-4000-8000-000000000501' }],
    [{ ...valid, created_at: 'not-a-date' }],
    [{ ...valid, created_at: null }],
    [{ ...valid, external_id: 'not-a-uuid' }],
    [{ ...valid, id: undefined }],
  ];

  for (const checkRuns of cases) {
    const selection = latestCompletedRunSelectionByName(checkRuns, VITEST_CHECK_NAME);
    assert.equal(selection.state, RUN_SELECTION_STATES.AMBIGUOUS, JSON.stringify(checkRuns));
    assert.equal(latestCompletedRunByName(checkRuns, VITEST_CHECK_NAME), null);
    assert.equal(latestCompletedConclusionByName(checkRuns, VITEST_CHECK_NAME), '');
  }
});

test('mancanza del check o solo skipped è pending, non un verdetto vecchio', () => {
  assert.equal(
    latestCompletedRunSelectionByName([], VITEST_CHECK_NAME).state,
    RUN_SELECTION_STATES.PENDING,
  );
  assert.equal(
    latestCompletedRunSelectionByName([
      run({ id: 600, conclusion: 'skipped', createdAt: '2026-09-20T14:00:00Z' }),
    ], VITEST_CHECK_NAME).state,
    RUN_SELECTION_STATES.PENDING,
  );
});
