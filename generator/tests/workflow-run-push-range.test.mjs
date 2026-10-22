import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  compareProvesDirectParent,
  flattenWorkflowRunPages,
  parsePushRangeRunTitle,
  resolvePushRange,
} from '../../scripts/ci/resolve-workflow-run-push-range.mjs';

const HEAD = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const workflow = fs.readFileSync(new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url), 'utf8');
const resolver = fs.readFileSync(new URL('../../scripts/ci/resolve-workflow-run-push-range.mjs', import.meta.url), 'utf8');
const publishApi = fs.readFileSync(new URL('../../.github/workflows/publish-api.yml', import.meta.url), 'utf8');

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

test('workflow_run push range: usa il confine persistito nel titolo della run API', () => {
  const title = 'Publish article data API (automatic) / range=' + BEFORE + '..' + HEAD;
  assert.deepEqual(parsePushRangeRunTitle(title), { before: BEFORE, after: HEAD });
  assert.deepEqual(resolvePushRange({
    headSha: HEAD,
    workflowRunId: '200',
    workflowRuns: [
      { id: 200, event: 'push', head_sha: HEAD, display_title: title, created_at: '2026-10-19T10:00:00Z' },
      { id: 199, event: 'push', head_sha: OTHER, created_at: '2026-10-19T09:59:00Z' },
    ],
  }), {
    before: BEFORE,
    after: HEAD,
    source: 'workflow-run-title',
  });
  assert.equal(parsePushRangeRunTitle('Publish article data API / range=none..' + HEAD), null);
  assert.equal(parsePushRangeRunTitle('Publish article data API / range=' + BEFORE + '..' + OTHER)?.after, OTHER);
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

test('workflow_run push range: conserva tutte le pagine della cronologia Actions', () => {
  const workflowRuns = flattenWorkflowRunPages([
    { workflow_runs: [{ id: 200, event: 'push', head_sha: HEAD, created_at: '2026-10-19T10:00:00Z' }] },
    { workflow_runs: [{ id: 199, event: 'push', head_sha: BEFORE, created_at: '2026-10-19T09:59:00Z' }] },
  ]);
  assert.deepEqual(resolvePushRange({
    headSha: HEAD,
    workflowRunId: '200',
    workflowRuns,
  }), {
    before: BEFORE,
    after: HEAD,
    source: 'workflow-history',
  });
});

test('workflow_run push range: accetta il fallback solo se il commit precedente è il parent diretto', () => {
  const range = { before: BEFORE, after: HEAD };
  assert.equal(compareProvesDirectParent(range, {
    status: 'ahead',
    ahead_by: 1,
    behind_by: 0,
    merge_base_commit: BEFORE,
  }), true);
  assert.equal(compareProvesDirectParent(range, {
    status: 'ahead',
    ahead_by: 2,
    behind_by: 0,
    merge_base_commit: BEFORE,
  }), false);
  assert.equal(compareProvesDirectParent(range, {
    status: 'ahead',
    ahead_by: 1,
    behind_by: 1,
    merge_base_commit: BEFORE,
  }), false);
  assert.equal(compareProvesDirectParent(range, {
    status: 'ahead',
    ahead_by: 1,
    behind_by: 0,
    merge_base_commit: OTHER,
  }), false);
});

test('fast-publish-section: non usa l endpoint inesistente per gli eventi del commit', () => {
  assert.match(workflow, /resolve-workflow-run-push-range\.mjs/);
  assert.match(resolver, /actions\/workflows\/publish-api\.yml\/runs/);
  assert.match(resolver, /display_title/);
  assert.match(resolver, /workflow-run-title/);
  assert.match(publishApi, /run-name:[\s\S]*github\.event\.before[\s\S]*github\.event\.after/);
  assert.match(resolver, /compare\/\$\{range\.before\}\.\.\.\$\{range\.after\}/);
  assert.match(resolver, /merge_base_commit: \.merge_base_commit\.sha/);
  assert.match(resolver, /WORKFLOW_RUN_PAGE_SIZE = 100/);
  assert.match(resolver, /per_page=\$\{WORKFLOW_RUN_PAGE_SIZE\}&page=\$\{page\}/);
  assert.doesNotMatch(workflow, /commits\/\$WORKFLOW_RUN_HEAD_SHA\/events/);
  assert.doesNotMatch(resolver, /commits\/\$WORKFLOW_RUN_HEAD_SHA\/events/);
  assert.match(resolver, /compareProvesDirectParent\(range, comparison\)/);
  assert.doesNotMatch(resolver, /compareProvesAncestor/);
});
