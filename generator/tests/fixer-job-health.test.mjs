import test from 'node:test';
import assert from 'node:assert/strict';
import { fixerJobStats } from '../../scripts/ci/loop-health-report.mjs';

const run = (databaseId, conclusion) => ({
  databaseId,
  conclusion,
  createdAt: '2026-11-06T00:00:00Z',
});

test('run issue-fix cancelled o skipped prima dei job resta misurabile', () => {
  const result = fixerJobStats(
    [run(1, 'cancelled'), run(2, 'skipped')],
    () => ({ jobs: [] }),
  );

  assert.equal(result.measured, true);
  assert.equal(result.reason, null);
  assert.equal(result.started, 0);
  assert.equal(result.cancelled, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.unknown, 0);
});

test('un run success senza job resta non misurabile', () => {
  const result = fixerJobStats(
    [run(1, 'success')],
    () => ({ jobs: [] }),
  );

  assert.equal(result.measured, false);
  assert.equal(result.reason, 'jobs-api-error-or-incomplete-response');
  assert.equal(result.unknown, 1);
  assert.equal(result.cancelled, 0);
  assert.equal(result.skipped, 0);
});
