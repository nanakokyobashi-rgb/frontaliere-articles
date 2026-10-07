import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { releaseLeaseWithRetry } from '../../scripts/ci/release-quota-lease.mjs';
import {
  isRetryableGitHubMutationError,
  quotaLeaseFailureMarker,
} from '../../scripts/ci/requeue-quota-lease.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK_SCRIPT = path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs');

function ghError(stderr, status = 1) {
  const error = new Error('Command failed: node');
  error.status = status;
  error.stderr = stderr;
  return error;
}

test('releaseLeaseWithRetry ritenta una release transient e conserva il strict mode', () => {
  const calls = [];
  const sleeps = [];
  const logs = [];
  const result = releaseLeaseWithRetry({
    nodeBin: 'node',
    checkScript: CHECK_SCRIPT,
    maxAttempts: 3,
    retryDelayMs: 10,
    env: { ...process.env, QUOTA_LEASE_ACTION: 'release' },
    sleep: (ms) => sleeps.push(ms),
    log: (line) => logs.push(line),
    exec: (_bin, args, options) => {
      calls.push({ args, options });
      if (calls.length < 3) throw ghError('GraphQL: Something went wrong while executing your query');
      return 'lease_released=true\n';
    },
  });

  assert.equal(result, 'lease_released=true\n');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(logs.length, 2);
  assert.deepEqual(calls[0].args, [CHECK_SCRIPT]);
  assert.equal(calls[0].options.env.QUOTA_LEASE_STRICT_RELEASE, '1');
  assert.equal(calls[0].options.env.QUOTA_LEASE_ACTION, 'release');
});

test('il wrapper ritenta il marker del gate anche quando il body ha nascosto il dettaglio', () => {
  const calls = [];
  const sleeps = [];
  const githubError = ghError('gh: HTTP 503 Service Unavailable', 503);
  const childError = Object.assign(
    new Error(`Command failed: node issue comment --body ${'lease-body '.repeat(80)}`),
    {
      status: 1,
      stdout: `::error::${quotaLeaseFailureMarker(githubError)} quota lease fail-closed`,
      stderr: '',
    },
  );

  const result = releaseLeaseWithRetry({
    maxAttempts: 2,
    retryDelayMs: 10,
    sleep: (ms) => sleeps.push(ms),
    exec: () => {
      calls.push(true);
      if (calls.length === 1) throw childError;
      return 'lease_released=true\n';
    },
  });

  assert.equal(result, 'lease_released=true\n');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [10]);
});

test('il classificatore tratta 429 e secondary rate limit come transient, non auth o permessi', () => {
  assert.equal(isRetryableGitHubMutationError(ghError('HTTP 429 Too Many Requests', 429)), true);
  assert.equal(isRetryableGitHubMutationError(ghError('You have exceeded a secondary rate limit. Please wait')), true);
  assert.equal(isRetryableGitHubMutationError(ghError('HTTP 401 Bad credentials', 401)), false);
  assert.equal(isRetryableGitHubMutationError(ghError('HTTP 403 Resource not accessible by integration', 403)), false);
});

test('releaseLeaseWithRetry non nasconde un errore permanente', () => {
  let calls = 0;
  const error = ghError('HTTP 403 Resource not accessible by integration');
  assert.throws(
    () => releaseLeaseWithRetry({
      maxAttempts: 3,
      sleep: () => assert.fail('sleep inatteso'),
      exec: () => {
        calls += 1;
        throw error;
      },
    }),
    (caught) => caught === error,
  );
  assert.equal(calls, 1);
});

test('il quota gate espone un errore release al wrapper senza alterare il preflight', () => {
  const baseEnv = {
    ...process.env,
    GITHUB_OUTPUT: '/dev/null',
    GH_REPO: '',
    QUOTA_LEASE_ACTION: 'release',
    QUOTA_LEASE_ROLE: 'issue-fix',
    QUOTA_LEASE_OWNER: 'issue-fix',
    QUOTA_LEASE_TARGET_TYPE: 'issue',
    QUOTA_LEASE_TARGET: '',
    QUOTA_LEASE_TOKEN: 'token',
  };
  const strict = spawnSync(process.execPath, [CHECK_SCRIPT], {
    env: { ...baseEnv, QUOTA_LEASE_STRICT_RELEASE: '1' },
    encoding: 'utf8',
  });
  assert.equal(strict.status, 1, strict.stderr);

  const normal = spawnSync(process.execPath, [CHECK_SCRIPT], {
    env: { ...baseEnv, QUOTA_LEASE_STRICT_RELEASE: '' },
    encoding: 'utf8',
  });
  assert.equal(normal.status, 0, normal.stderr);
});

test('tutti i consumer del lease passano dal release wrapper retryable', () => {
  const workflows = [
    '.github/workflows/issue-fix.yml',
    '.github/workflows/issue-decompose.yml',
    '.github/workflows/pr-redflag-fixer.yml',
    '.github/workflows/pr-redcheck-fixer.yml',
  ];

  for (const file of workflows) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const start = source.indexOf('QUOTA_LEASE_ACTION: release');
    const end = source.indexOf('\n      - name:', start + 1);
    const step = source.slice(start, end < 0 ? source.length : end);
    assert.ok(start >= 0, `${file}: release step mancante`);
    assert.match(step, /node scripts\/ci\/release-quota-lease\.mjs/, `${file}: wrapper release mancante`);
    assert.doesNotMatch(step, /node scripts\/ci\/check-quota-backoff\.mjs/, `${file}: release diretto non retryable`);
  }
});
