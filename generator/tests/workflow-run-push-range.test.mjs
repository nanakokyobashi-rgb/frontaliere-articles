import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { resolvePushRange } from '../../scripts/ci/resolve-workflow-run-push-range.mjs';

const HEAD = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const workflow = fs.readFileSync(new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url), 'utf8');
const resolver = fs.readFileSync(new URL('../../scripts/ci/resolve-workflow-run-push-range.mjs', import.meta.url), 'utf8');

test('workflow_run push range: usa il PushEvent della repository quando disponibile', () => {
  assert.deepEqual(resolvePushRange({
    headSha: HEAD,
    events: [
      { type: 'PushEvent', payload: { ref: 'refs/heads/other', head: HEAD, before: OTHER } },
      { type: 'PushEvent', payload: { ref: 'refs/heads/main', head: HEAD, before: BEFORE } },
    ],
  }), {
    before: BEFORE,
    after: HEAD,
    source: 'repository-events',
  });
});

test('workflow_run push range: usa il run API precedente quando manca il PushEvent', () => {
  assert.deepEqual(resolvePushRange({
    headSha: HEAD,
    workflowRunId: '200',
    workflowRuns: [
      { id: 200, event: 'push', head_sha: HEAD, created_at: '2026-10-19T10:00:00Z' },
      { id: 199, event: 'push', head_sha: BEFORE, created_at: '2026-10-19T09:59:00Z' },
    ],
  }), {
    before: BEFORE,
    after: HEAD,
    source: 'workflow-history',
  });
});

test('workflow_run push range: la storia ambigua resta fail-closed', () => {
  assert.equal(resolvePushRange({
    headSha: HEAD,
    workflowRunId: '200',
    workflowRuns: [{ id: 200, event: 'push', head_sha: HEAD, created_at: '2026-10-19T10:00:00Z' }],
  }), null);
  assert.equal(resolvePushRange({
    headSha: HEAD,
    workflowRunId: 'missing',
    workflowRuns: [{ id: 199, event: 'push', head_sha: BEFORE, created_at: '2026-10-19T09:59:00Z' }],
  }), null);
});

test('fast-publish-section: non usa l endpoint inesistente per gli eventi del commit', () => {
  assert.match(workflow, /resolve-workflow-run-push-range\.mjs/);
  assert.match(resolver, /actions\/workflows\/publish-api\.yml\/runs/);
  assert.doesNotMatch(workflow, /commits\/\$WORKFLOW_RUN_HEAD_SHA\/events/);
  assert.doesNotMatch(resolver, /commits\/\$WORKFLOW_RUN_HEAD_SHA\/events/);
});
