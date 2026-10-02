import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isRetryableGitHubMutationError,
  requeueArguments,
  retryGitHubMutation,
  requeueQuotaLease,
} from '../../scripts/ci/requeue-quota-lease.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function ghError(stderr) {
  const error = new Error(`Command failed: gh\n${stderr}`);
  error.stderr = stderr;
  return error;
}

test('riconosce il transient GraphQL osservato nel run e non confonde i permessi', () => {
  assert.equal(
    isRetryableGitHubMutationError(ghError('GraphQL: Something went wrong while executing your query')),
    true,
  );
  assert.equal(isRetryableGitHubMutationError(ghError('HTTP 503 Service Unavailable')), true);
  assert.equal(isRetryableGitHubMutationError(ghError('HTTP 500 Internal Server Error')), true);
  assert.equal(isRetryableGitHubMutationError(ghError('500 Internal Server Error')), true);
  assert.equal(isRetryableGitHubMutationError(ghError('HTTP 403 Resource not accessible by integration')), false);
  assert.equal(isRetryableGitHubMutationError(ghError('GraphQL: Could not resolve to an issue or pull request')), false);
});

test('una mutazione transient viene ritentata con backoff bounded', () => {
  let calls = 0;
  const sleeps = [];
  const logs = [];
  const result = retryGitHubMutation(() => {
    calls += 1;
    if (calls < 3) throw ghError('GraphQL: Something went wrong while executing your query');
    return 'ok';
  }, {
    maxAttempts: 3,
    retryDelayMs: 100,
    sleep: (ms) => sleeps.push(ms),
    log: (line) => logs.push(line),
  });

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [100, 200]);
  assert.equal(logs.length, 2);
});

test('un errore permanente non viene ritentato', () => {
  let calls = 0;
  const error = ghError('HTTP 403 Resource not accessible by integration');
  assert.throws(
    () => retryGitHubMutation(() => {
      calls += 1;
      throw error;
    }, { sleep: () => assert.fail('sleep inatteso') }),
    (caught) => caught === error,
  );
  assert.equal(calls, 1);
});

test('la transizione requeue resta una singola mutazione idempotente', () => {
  assert.deepEqual(
    requeueArguments({
      issue: '307',
      repo: 'owner/repo',
      addLabel: 'agent:decompose-queued',
      removeLabels: ['agent:decompose', 'automation-deferred'],
    }),
    [
      'issue', 'edit', '307', '--repo', 'owner/repo',
      '--add-label', 'agent:decompose-queued',
      '--remove-label', 'agent:decompose',
      '--remove-label', 'automation-deferred',
    ],
  );

  const calls = [];
  const sleeps = [];
  requeueQuotaLease({
    issue: '307',
    repo: 'owner/repo',
    addLabel: 'agent:fix-queued',
    removeLabels: ['agent:fix', 'automation-deferred'],
    exec: (_bin, args) => {
      calls.push(args);
      if (calls.length === 1) throw ghError('GraphQL: Something went wrong while executing your query');
      return '';
    },
    retryDelayMs: 1,
    sleep: (ms) => sleeps.push(ms),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(sleeps, [1]);
});

test('entrambi i consumer di lease usano il writer con retry condiviso', () => {
  const workflows = [
    ['.github/workflows/issue-decompose.yml', 'agent:decompose-queued', 'agent:decompose'],
    ['.github/workflows/issue-fix.yml', 'agent:fix-queued', 'agent:fix'],
  ];
  for (const [file, queued, active] of workflows) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const marker = 'Shared Codex lane quota lease unavailable (requeue zero-agent)';
    const start = source.indexOf(`- name: ${marker}`);
    assert.ok(start >= 0, `${file}: step requeue mancante`);
    const end = source.indexOf('\n      - name:', start + 1);
    const step = source.slice(start, end < 0 ? source.length : end);
    assert.match(step, /node scripts\/ci\/requeue-quota-lease\.mjs/);
    assert.match(step, new RegExp(`--add-label ${queued}`));
    assert.match(step, new RegExp(`--remove-label ${active}`));
    assert.doesNotMatch(step, /gh issue edit/);
  }
});
