#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FULL_SHA_RE = /^[a-f0-9]{40}$/u;
const ZERO_SHA = '0'.repeat(40);

function isFullSha(value) {
  return FULL_SHA_RE.test(String(value ?? ''));
}

function validBefore(value) {
  return value === ZERO_SHA || isFullSha(value);
}

/**
 * Resolve the push range for a completed API workflow without using the
 * non-existent `commits/<sha>/events` endpoint. If GitHub omits a bot push
 * from the public event feed, the preceding API workflow run identifies the
 * exact previous main head; histories that cannot prove that boundary remain
 * fail-closed.
 */
export function resolvePushRange({
  headSha,
  events = [],
  workflowRuns = [],
  workflowRunId = null,
  ref = 'refs/heads/main',
}) {
  if (!isFullSha(headSha)) throw new Error(`head SHA non valido: ${headSha}`);

  const event = (Array.isArray(events) ? events : []).find((candidate) => {
    const payload = candidate?.payload;
    const eventHead = payload?.head ?? payload?.after;
    return candidate?.type === 'PushEvent'
      && payload?.ref === ref
      && eventHead === headSha
      && validBefore(payload?.before);
  });
  if (event) {
    return {
      before: event.payload.before,
      after: headSha,
      source: 'repository-events',
    };
  }

  const currentRun = (Array.isArray(workflowRuns) ? workflowRuns : []).find(
    (run) => String(run?.id ?? '') === String(workflowRunId ?? ''),
  );
  if (currentRun) {
    const currentCreatedAt = Date.parse(currentRun.created_at ?? '');
    const currentId = Number(currentRun.id);
    const previousRun = workflowRuns
      .filter((run) => run?.event === 'push' && isFullSha(run?.head_sha) && run.head_sha !== headSha)
      .filter((run) => {
        const createdAt = Date.parse(run.created_at ?? '');
        const id = Number(run.id);
        return (Number.isFinite(currentCreatedAt) && Number.isFinite(createdAt) && createdAt < currentCreatedAt)
          || (createdAt === currentCreatedAt && Number.isFinite(currentId) && Number.isFinite(id) && id < currentId);
      })
      .sort((left, right) => {
        const byDate = Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? '');
        return byDate || Number(right.id) - Number(left.id);
      })[0];
    if (previousRun) {
      return {
        before: previousRun.head_sha,
        after: headSha,
        source: 'workflow-history',
      };
    }
  }

  return null;
}

function readApiJson(endpoint, query = '.') {
  const output = execFileSync('gh', ['api', endpoint, '--jq', query], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function main() {
  const repo = String(process.env.REPO ?? '').trim();
  const headSha = String(process.env.WORKFLOW_RUN_HEAD_SHA ?? '').trim();
  const workflowRunId = String(process.env.WORKFLOW_RUN_ID ?? '').trim();
  if (!repo) throw new Error('REPO assente');
  if (!isFullSha(headSha)) throw new Error(`WORKFLOW_RUN_HEAD_SHA non valido: ${headSha}`);

  const events = readApiJson(
    `repos/${repo}/events?per_page=100`,
    '[.[] | select(.type == "PushEvent") | {type, payload: {ref: .payload.ref, head: .payload.head, after: .payload.after, before: .payload.before}}]',
  );
  let range = resolvePushRange({ headSha, events, workflowRunId });
  if (!range) {
    const workflowRuns = readApiJson(
      `repos/${repo}/actions/workflows/publish-api.yml/runs?branch=main&event=push&per_page=100`,
      '{workflow_runs: [.workflow_runs[] | {id, event, head_sha, created_at}]}',
    );
    range = resolvePushRange({
      headSha,
      workflowRuns: workflowRuns?.workflow_runs,
      workflowRunId,
    });
  }
  if (!range) {
    throw new Error(`before della push originaria non trovato per workflow_run head ${headSha}`);
  }

  console.log(`before=${range.before}`);
  console.log(`after=${range.after}`);
  console.log(`source=${range.source}`);
}

if ((() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})()) {
  try {
    main();
  } catch (error) {
    console.error(`resolve-workflow-run-push-range: ${error?.message ?? error}`);
    process.exit(1);
  }
}
