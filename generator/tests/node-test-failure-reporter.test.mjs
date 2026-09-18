import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComment } from '../../scripts/ci/report-node-test-failure.mjs';
import { buildReport, normalizeFailure } from '../../scripts/ci/node-test-failure-reporter.mjs';

test('il reporter strutturato conserva file, riga, nome ed errore', () => {
  const failure = normalizeFailure({
    file: 'generator/tests/example.test.mjs',
    line: 12,
    name: 'suite fails',
    type: 'test',
    details: { error: { stack: 'AssertionError: expected 1 to be 2' } },
  });
  const report = buildReport([failure], []);

  assert.deepEqual(report, {
    failedTests: 1,
    failedSuites: 0,
    failures: [failure],
    suiteFailures: [],
  });
});

test('il commento della PR espone il test fallito e il link alla run', () => {
  const body = buildComment({
    failedTests: 1,
    failedSuites: 1,
    failures: [{
      file: 'generator/tests/example.test.mjs',
      line: 12,
      test: 'suite fails',
      error: 'AssertionError: expected 1 to be 2',
    }],
    suiteFailures: [],
  }, {
    runUrl: 'https://github.com/o/r/actions/runs/42',
    runId: '42',
    headSha: 'abcdef123456789',
  });

  assert.match(body, /node-test-failure-report/);
  assert.match(body, /generator\/tests\/example\.test\.mjs:12/);
  assert.match(body, /suite fails/);
  assert.match(body, /AssertionError/);
  assert.match(body, /actions\/runs\/42/);
});
