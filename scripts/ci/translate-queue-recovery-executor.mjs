#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_PHASE_GET_REQUESTS,
  PROCESS_TIMEOUT_MS,
  RecoveryFailure,
  buildRecoveryReport,
  inspectRecoveryTarget,
  validTargetRunId,
} from './translate-queue-recovery-claim.mjs';
import { TARGET_REPOSITORY } from './translate-queue-recovery.mjs';

export const MAX_EXECUTOR_POST_REQUESTS = 1;

const API_ROOT = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export function createRecoveryExecutorClient({
  clock = Date.now,
  deadlineAt,
  fetchImpl = globalThis.fetch,
  token,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('invalid_fetch');
  let usedPosts = 0;
  return {
    budget() {
      return { maxPosts: MAX_EXECUTOR_POST_REQUESTS, usedPosts };
    },
    async rerun(targetRunId) {
      if (!validTargetRunId(targetRunId)) throw new TypeError('invalid_target_run_id');
      if (usedPosts >= MAX_EXECUTOR_POST_REQUESTS) {
        throw new RecoveryFailure('mutation_outcome_unknown_or_failed');
      }
      const remaining = deadlineAt - clock();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new RecoveryFailure('mutation_outcome_unknown_or_failed');
      }
      usedPosts += 1;
      let response;
      try {
        response = await fetchImpl(
          `${API_ROOT}/repos/${TARGET_REPOSITORY}/actions/runs/${targetRunId}/rerun`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(Math.max(
              1,
              Math.min(REQUEST_TIMEOUT_MS, Math.floor(remaining)),
            )),
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${token}`,
              'User-Agent': 'translate-queue-recovery-v2',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );
      } catch {
        throw new RecoveryFailure('mutation_outcome_unknown_or_failed');
      }
      return { status: response?.status };
    },
  };
}

export async function runRecoveryExecutor({
  claimCommitSha,
  claimKey,
  clock = Date.now,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  repository = TARGET_REPOSITORY,
  targetRunId,
  token = '',
  workflowRunAttempt,
} = {}) {
  const deadlineAt = clock() + PROCESS_TIMEOUT_MS;
  const invalidBinding = !validTargetRunId(targetRunId)
    || typeof claimKey !== 'string' || !SHA256_RE.test(claimKey)
    || typeof claimCommitSha !== 'string' || !SHA_RE.test(claimCommitSha)
    || workflowRunAttempt !== '1';
  if (invalidBinding) {
    const inspection = {
      claim: null,
      complete: false,
      eligible: false,
      failClosed: true,
      primaryReason: 'invalid_input',
      queryBudget: { maxGets: MAX_PHASE_GET_REQUESTS, usedGets: 0 },
      queue: { active: null, pending: null, state: 'unknown' },
      reasonCodes: ['invalid_input'],
      target: null,
    };
    return buildRecoveryReport({
      claimCommitSha,
      decision: 'blocked',
      inspection,
      mode: 'claim_and_rerun',
      mutationBudget: {
        maxPosts: MAX_EXECUTOR_POST_REQUESTS,
        maxPuts: 0,
        usedPosts: 0,
        usedPuts: 0,
      },
      now,
      phase: 'executor',
      primaryReason: 'invalid_input',
    });
  }

  const inspection = await inspectRecoveryTarget({
    acceptedClaimKey: claimKey,
    clock,
    deadlineAt,
    fetchImpl,
    now,
    repository,
    targetRunId,
    token,
  });
  if (!inspection.eligible) {
    return buildRecoveryReport({
      claimCommitSha,
      decision: 'blocked',
      inspection,
      mode: 'claim_and_rerun',
      mutationBudget: {
        maxPosts: MAX_EXECUTOR_POST_REQUESTS,
        maxPuts: 0,
        usedPosts: 0,
        usedPuts: 0,
      },
      now,
      phase: 'executor',
      primaryReason: 'post_claim_state_changed',
      reasonCodes: ['post_claim_state_changed'],
    });
  }

  const client = createRecoveryExecutorClient({ clock, deadlineAt, fetchImpl, token });
  try {
    const result = await client.rerun(targetRunId);
    if (result.status !== 201) {
      throw new RecoveryFailure('mutation_outcome_unknown_or_failed');
    }
    return buildRecoveryReport({
      claimCommitSha,
      decision: 'rerun_requested',
      inspection,
      mode: 'claim_and_rerun',
      mutationBudget: {
        ...client.budget(),
        maxPuts: 0,
        usedPuts: 0,
      },
      now,
      phase: 'executor',
      primaryReason: 'rerun_requested',
      reasonCodes: ['rerun_authorized', 'rerun_requested'],
    });
  } catch {
    inspection.complete = false;
    inspection.failClosed = true;
    return buildRecoveryReport({
      claimCommitSha,
      decision: 'blocked',
      inspection,
      mode: 'claim_and_rerun',
      mutationBudget: {
        ...client.budget(),
        maxPuts: 0,
        usedPuts: 0,
      },
      now,
      phase: 'executor',
      primaryReason: 'mutation_outcome_unknown_or_failed',
      reasonCodes: ['rerun_authorized', 'mutation_outcome_unknown_or_failed'],
    });
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runRecoveryExecutor({
    claimCommitSha: process.env.CLAIM_COMMIT_SHA,
    claimKey: process.env.CLAIM_KEY,
    repository: process.env.GITHUB_REPOSITORY,
    targetRunId: process.env.TARGET_RUN_ID,
    token: process.env.GITHUB_TOKEN,
    workflowRunAttempt: process.env.RECOVERY_WORKFLOW_RUN_ATTEMPT,
  }).then(({ json, report }) => {
    process.stdout.write(json);
    if (report.failClosed) process.exitCode = 1;
  }).catch(() => {
    console.error('translate_queue_recovery_executor_error:internal_failure');
    process.exitCode = 1;
  });
}
