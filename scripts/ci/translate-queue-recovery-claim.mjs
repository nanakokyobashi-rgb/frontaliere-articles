#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUEUE_MAX_BOUNDARY_SHA,
  MAX_LIVENESS_GET_REQUESTS,
  RERUN_PRESERVATION_PROOF,
  TARGET_BRANCH,
  TARGET_REPOSITORY,
  TARGET_WORKFLOW_BLOB_SHA,
  TARGET_WORKFLOW_ID,
  TARGET_WORKFLOW_PATH,
  observeTranslateQueue,
  observeTranslateQueueLiveness,
} from './translate-queue-recovery.mjs';

export const MUTATION_REPORT_SCHEMA = 'translate-queue-recovery-mutation/v1';
export const CLAIM_SCHEMA = 'translate-queue-recovery-claim/v1';
export const CLAIM_ROOT = 'data/translation-queue-recovery/claims/v1';
export const MAX_CLAIM_BYTES = 4096;
export const MAX_PHASE_GET_REQUESTS = 36;
export const MAX_PHASE_PUT_REQUESTS = 1;
export const MAX_MUTATION_REPORT_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
export const PROCESS_TIMEOUT_MS = 240_000;
export const TARGET_EXECUTION_CAPABILITY_SCHEMA = 'translate-target-execution-capability/v1';
export const TARGET_EXECUTION_CAPABILITY = Object.freeze({
  executionDedupeProtocolVersion: 0,
  schema: TARGET_EXECUTION_CAPABILITY_SCHEMA,
  workflowBlobSha: TARGET_WORKFLOW_BLOB_SHA,
});

const API_ROOT = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RUN_ID_RE = /^[1-9][0-9]{0,19}$/;
const SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CLAIM_PATH_RE = new RegExp(`^${CLAIM_ROOT}/[a-f0-9]{64}\\.json$`);
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
const MODES = new Set(['observe_only', 'claim_and_rerun']);
const PHASES = new Set(['observe', 'claim']);

export const RECOVERY_REASON_CODES = Object.freeze([
  'active_and_pending_present',
  'active_present',
  'already_claimed_no_retry',
  'already_recovered_observed',
  'api_http_error',
  'api_incomplete',
  'api_invalid_json',
  'api_network_error',
  'api_rate_limited',
  'api_response_too_large',
  'boundary_non_descendant',
  'boundary_unknown',
  'cancelled_with_jobs',
  'claim_conflict',
  'claim_created',
  'claim_verified',
  'eligible_observe_only',
  'event_not_recoverable',
  'head_branch_mismatch',
  'head_sha_mismatch',
  'invalid_input',
  'invalid_mode',
  'invalid_phase',
  'invalid_repository',
  'liveness_census_inconclusive',
  'missing_token',
  'mutation_outcome_unknown_or_failed',
  'observation_incomplete',
  'path_mismatch',
  'pending_present',
  'post_claim_state_changed',
  'query_budget_exhausted',
  'queue_empty',
  'rerun_authorized',
  'rerun_requested',
  'target_state_not_recoverable',
  'target_execution_dedupe_not_live',
  'workflow_blob_mismatch',
  'workflow_mismatch',
]);

export class RecoveryFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_json_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('non_json_value');
  return `{${Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new TypeError('undefined_json_value');
    return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
  }).join(',')}}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  return new Date(milliseconds).toISOString() === canonical;
}

export function validTargetRunId(value) {
  return typeof value === 'string' && RUN_ID_RE.test(value);
}

function validTargetCapability(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 3
    && keys[0] === 'executionDedupeProtocolVersion'
    && keys[1] === 'schema'
    && keys[2] === 'workflowBlobSha'
    && value.schema === TARGET_EXECUTION_CAPABILITY_SCHEMA
    && [0, 1].includes(value.executionDedupeProtocolVersion)
    && typeof value.workflowBlobSha === 'string'
    && SHA_RE.test(value.workflowBlobSha);
}

function normalizeApiRunId(value) {
  if (typeof value === 'string') return RUN_ID_RE.test(value) ? value : null;
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const text = String(value);
  return RUN_ID_RE.test(text) ? text : null;
}

function orderedReasons(reasons) {
  return RECOVERY_REASON_CODES.filter((code) => reasons.has(code));
}

function requestSignal(deadlineAt, clock) {
  const remaining = deadlineAt - clock();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new RecoveryFailure('observation_incomplete');
  }
  return AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, Math.floor(remaining))));
}

async function readBoundedJson(response) {
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new RecoveryFailure('api_response_too_large');
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new RecoveryFailure('api_incomplete');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new RecoveryFailure('api_response_too_large');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RecoveryFailure('api_invalid_json');
  }
}

function createRequestCore({ clock, deadlineAt, fetchImpl, maxGets, token }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('invalid_fetch');
  let usedGets = 0;

  async function request(method, apiPath, { body, allowNotFound = false } = {}) {
    if (typeof apiPath !== 'string'
        || !apiPath.startsWith(`/repos/${TARGET_REPOSITORY}/`)) {
      throw new TypeError('invalid_api_path');
    }
    if (method === 'GET') {
      if (usedGets >= maxGets) throw new RecoveryFailure('query_budget_exhausted');
      usedGets += 1;
    }

    let response;
    try {
      response = await fetchImpl(`${API_ROOT}${apiPath}`, {
        method,
        redirect: 'error',
        signal: requestSignal(deadlineAt, clock),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'User-Agent': 'translate-queue-recovery-v2',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (error instanceof RecoveryFailure) throw error;
      throw new RecoveryFailure('api_network_error');
    }

    const remaining = response?.headers?.get?.('x-ratelimit-remaining');
    if (response?.status === 429 || (response?.status === 403 && remaining === '0')) {
      throw new RecoveryFailure('api_rate_limited');
    }
    if (allowNotFound && response?.status === 404) return { payload: null, status: 404 };
    return { response, status: response?.status };
  }

  return {
    budget() { return { maxGets, usedGets }; },
    request,
  };
}

export function createRecoveryReadClient({
  clock = Date.now,
  deadlineAt,
  fetchImpl = globalThis.fetch,
  maxGets,
  token,
}) {
  const core = createRequestCore({ clock, deadlineAt, fetchImpl, maxGets, token });
  return {
    budget: core.budget,
    async getJson(apiPath, { allowNotFound = false } = {}) {
      const result = await core.request('GET', apiPath, { allowNotFound });
      if (result.status === 404) return result;
      if (!result.response?.ok) throw new RecoveryFailure('api_http_error');
      return { payload: await readBoundedJson(result.response), status: result.status };
    },
  };
}

export function createClaimGithubClient({
  clock = Date.now,
  deadlineAt,
  fetchImpl = globalThis.fetch,
  maxGets,
  token,
}) {
  const core = createRequestCore({ clock, deadlineAt, fetchImpl, maxGets, token });
  let usedPuts = 0;
  return {
    budget() {
      return { ...core.budget(), maxPuts: MAX_PHASE_PUT_REQUESTS, usedPuts };
    },
    async getJson(apiPath, options) {
      const result = await core.request('GET', apiPath, options);
      if (result.status === 404) return result;
      if (!result.response?.ok) throw new RecoveryFailure('api_http_error');
      return { payload: await readBoundedJson(result.response), status: result.status };
    },
    async createClaim({ bytes, claimPath, targetRunId }) {
      if (usedPuts >= MAX_PHASE_PUT_REQUESTS) throw new RecoveryFailure('claim_conflict');
      if (!validTargetRunId(targetRunId)
          || typeof claimPath !== 'string'
          || !CLAIM_PATH_RE.test(claimPath)
          || !Buffer.isBuffer(bytes)
          || bytes.length > MAX_CLAIM_BYTES) {
        throw new TypeError('invalid_claim_request');
      }
      usedPuts += 1;
      const encodedPath = claimPath.split('/').map(encodeURIComponent).join('/');
      const body = canonicalJson({
        branch: TARGET_BRANCH,
        content: bytes.toString('base64'),
        message: `ci: claim translate queue recovery ${targetRunId}`,
      });
      const result = await core.request(
        'PUT',
        `/repos/${TARGET_REPOSITORY}/contents/${encodedPath}`,
        { body },
      );
      if (![201, 409, 422].includes(result.status)) {
        throw new RecoveryFailure('api_http_error');
      }
      if (result.status !== 201) return { payload: null, status: result.status };
      return { payload: await readBoundedJson(result.response), status: result.status };
    },
  };
}

export function createRecoveryClaim({
  headSha,
  targetCapability = TARGET_EXECUTION_CAPABILITY,
  targetRunId,
}) {
  if (!validTargetRunId(targetRunId) || typeof headSha !== 'string' || !SHA_RE.test(headSha)
      || !validTargetCapability(targetCapability)) {
    throw new TypeError('invalid_claim_tuple');
  }
  const tuple = {
    branch: TARGET_BRANCH,
    executionDedupeProtocolVersion: targetCapability.executionDedupeProtocolVersion,
    maxMutationRequests: 1,
    mutation: 'rerun_same_run',
    queueMaxBoundarySha: QUEUE_MAX_BOUNDARY_SHA,
    repository: TARGET_REPOSITORY,
    schema: CLAIM_SCHEMA,
    sourceEvent: 'workflow_dispatch',
    sourceHeadSha: headSha,
    sourceRunAttempt: 1,
    targetRunId,
    workflowBlobSha: targetCapability.workflowBlobSha,
    workflowId: TARGET_WORKFLOW_ID,
    workflowPath: TARGET_WORKFLOW_PATH,
  };
  const claimKey = sha256(Buffer.from(canonicalJson(tuple), 'utf8'));
  const document = { ...tuple, claimKey };
  const bytes = Buffer.from(`${canonicalJson(document)}\n`, 'utf8');
  if (bytes.length > MAX_CLAIM_BYTES) throw new TypeError('claim_too_large');
  return {
    bytes,
    claimKey,
    claimPath: `${CLAIM_ROOT}/${claimKey}.json`,
    document,
    documentDigest: sha256(bytes),
    gitBlobSha: gitBlobSha(bytes),
  };
}

function decodeContentPayload(payload) {
  if (payload?.type !== 'file'
      || payload.encoding !== 'base64'
      || typeof payload.content !== 'string'
      || !Number.isSafeInteger(payload.size)
      || payload.size < 0
      || payload.size > MAX_CLAIM_BYTES
      || typeof payload.sha !== 'string'
      || !SHA_RE.test(payload.sha)) {
    throw new RecoveryFailure('claim_conflict');
  }
  const compact = payload.content.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new RecoveryFailure('claim_conflict');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length !== payload.size || bytes.length > MAX_CLAIM_BYTES) {
    throw new RecoveryFailure('claim_conflict');
  }
  return bytes;
}

async function readClaim(client, claim) {
  const encodedPath = claim.claimPath.split('/').map(encodeURIComponent).join('/');
  const result = await client.getJson(
    `/repos/${TARGET_REPOSITORY}/contents/${encodedPath}?ref=${TARGET_BRANCH}`,
    { allowNotFound: true },
  );
  if (result.status === 404) return { state: 'absent' };
  const bytes = decodeContentPayload(result.payload);
  if (!bytes.equals(claim.bytes)
      || result.payload.sha !== claim.gitBlobSha
      || sha256(bytes) !== claim.documentDigest) {
    throw new RecoveryFailure('claim_conflict');
  }
  return { state: 'exact' };
}

function validTargetMetadata(run, targetRunId) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) return null;
  const runId = normalizeApiRunId(run.id);
  if (runId !== targetRunId
      || !Number.isSafeInteger(run.workflow_id) || run.workflow_id <= 0
      || typeof run.path !== 'string'
      || typeof run.head_branch !== 'string'
      || typeof run.head_sha !== 'string'
      || typeof run.event !== 'string'
      || typeof run.status !== 'string'
      || (run.conclusion !== null && typeof run.conclusion !== 'string')
      || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || !validTimestamp(run.created_at)) {
    return null;
  }
  return {
    conclusion: run.conclusion,
    createdAt: run.created_at,
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    path: run.path,
    runAttempt: run.run_attempt,
    runId,
    status: run.status,
    workflowId: run.workflow_id,
  };
}

function failureInspection({ code, observerGets = 0, reasons = [], usedGets = 0 }) {
  const reasonSet = new Set(reasons);
  reasonSet.add(code);
  return {
    claim: null,
    complete: false,
    eligible: false,
    failClosed: true,
    primaryReason: code,
    queryBudget: {
      maxGets: MAX_PHASE_GET_REQUESTS,
      usedGets: observerGets + usedGets,
    },
    queue: { active: null, pending: null, state: 'unknown' },
    reasonCodes: orderedReasons(reasonSet),
    target: null,
  };
}

export async function inspectRecoveryTarget({
  acceptedClaimKey = null,
  clock = Date.now,
  deadlineAt = clock() + PROCESS_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  repository = TARGET_REPOSITORY,
  requireExecutionDedupe = false,
  targetCapability = TARGET_EXECUTION_CAPABILITY,
  targetRunId,
  token = '',
} = {}) {
  if (!validTargetRunId(targetRunId)) return failureInspection({ code: 'invalid_input' });
  if (typeof requireExecutionDedupe !== 'boolean' || !validTargetCapability(targetCapability)) {
    return failureInspection({ code: 'invalid_input' });
  }
  if (repository !== TARGET_REPOSITORY) return failureInspection({ code: 'invalid_repository' });
  if (typeof token !== 'string' || token.length === 0) {
    return failureInspection({ code: 'missing_token' });
  }
  if (acceptedClaimKey !== null && !SHA256_RE.test(acceptedClaimKey)) {
    return failureInspection({ code: 'claim_conflict' });
  }

  const preflightClient = createRecoveryReadClient({
    clock,
    deadlineAt,
    fetchImpl,
    maxGets: 1,
    token,
  });
  let target;
  try {
    const runResult = await preflightClient.getJson(
      `/repos/${TARGET_REPOSITORY}/actions/runs/${targetRunId}`,
    );
    target = validTargetMetadata(runResult.payload, targetRunId);
  } catch (error) {
    const specific = error instanceof RecoveryFailure ? error.code : 'api_incomplete';
    return failureInspection({
      code: 'observation_incomplete',
      reasons: [specific],
      usedGets: preflightClient.budget().usedGets,
    });
  }
  const early = (code, complete) => ({
    claim: null,
    complete,
    eligible: false,
    failClosed: !complete,
    primaryReason: code,
    queryBudget: {
      maxGets: MAX_PHASE_GET_REQUESTS,
      usedGets: preflightClient.budget().usedGets,
    },
    queue: { active: null, pending: null, state: 'unknown' },
    reasonCodes: orderedReasons(new Set([code])),
    target,
  });
  if (target === null) return early('observation_incomplete', false);
  if (!SHA_RE.test(target.headSha)) return early('head_sha_mismatch', false);
  if (target.workflowId !== TARGET_WORKFLOW_ID) return early('workflow_mismatch', true);
  if (target.path !== TARGET_WORKFLOW_PATH) return early('path_mismatch', true);
  if (target.headBranch !== TARGET_BRANCH) return early('head_branch_mismatch', true);
  if (target.event !== 'workflow_dispatch') return early('event_not_recoverable', true);
  if (target.runAttempt > 1) return early('already_recovered_observed', true);
  if (target.status !== 'completed' || target.conclusion !== 'cancelled') {
    return early('target_state_not_recoverable', true);
  }

  const reasons = new Set();
  let observer;
  try {
    observer = await observeTranslateQueue({
      fetchImpl,
      mode: 'dry-run',
      now,
      repository,
      token,
    });
  } catch {
    return failureInspection({
      code: 'observation_incomplete',
      usedGets: preflightClient.budget().usedGets,
    });
  }
  const observerGets = observer?.report?.queryBudget?.usedGets;
  if (!Number.isSafeInteger(observerGets)
      || observerGets < 0
      || observerGets > MAX_PHASE_GET_REQUESTS
      || clock() >= deadlineAt
      || observer.report.complete !== true
      || observer.report.failClosed !== false) {
    const observerReasons = Array.isArray(observer?.report?.reasonCodes)
      ? observer.report.reasonCodes
      : [];
    const code = observerReasons.includes('invalid_head_sha')
      ? 'head_sha_mismatch'
      : observerReasons.includes('boundary_unknown')
        ? 'boundary_unknown'
        : 'observation_incomplete';
    return failureInspection({
      code,
      observerGets: Number.isSafeInteger(observerGets) ? observerGets : 0,
      usedGets: preflightClient.budget().usedGets,
    });
  }

  const client = createRecoveryReadClient({
    clock,
    deadlineAt,
    fetchImpl,
    maxGets: MAX_PHASE_GET_REQUESTS
      - observerGets
      - preflightClient.budget().usedGets
      - MAX_LIVENESS_GET_REQUESTS,
    token,
  });
  let finalLivenessGets = 0;
  let queueCounts = {
    active: observer.report.counts.active,
    pending: observer.report.counts.pending,
  };
  const finish = ({ claim = null, complete = true, eligible = false, primaryReason, target = null }) => ({
    claim,
    complete,
    eligible,
    failClosed: !complete,
    primaryReason,
    queryBudget: {
      maxGets: MAX_PHASE_GET_REQUESTS,
      usedGets: preflightClient.budget().usedGets
        + observerGets
        + client.budget().usedGets
        + finalLivenessGets,
    },
    queue: {
      active: queueCounts.active,
      pending: queueCounts.pending,
      state: queueCounts.active > 0 && queueCounts.pending > 0
        ? 'active_and_pending'
        : queueCounts.active > 0
          ? 'active'
          : queueCounts.pending > 0 ? 'pending' : 'empty',
    },
    reasonCodes: orderedReasons(reasons),
    target,
  });
  const block = (code, target = null) => {
    reasons.add(code);
    return finish({ primaryReason: code, target });
  };
  const fail = (code, target = null) => {
    reasons.add(code);
    return finish({ complete: false, primaryReason: code, target });
  };

  try {
    const ancestry = await client.getJson(
      `/repos/${TARGET_REPOSITORY}/compare/${QUEUE_MAX_BOUNDARY_SHA}...${target.headSha}`,
    );
    if (!['ahead', 'identical', 'behind', 'diverged'].includes(ancestry.payload?.status)) {
      return fail('boundary_unknown', target);
    }
    if (ancestry.payload.status === 'behind' || ancestry.payload.status === 'diverged') {
      return block('boundary_non_descendant', target);
    }

    const workflow = await client.getJson(
      `/repos/${TARGET_REPOSITORY}/contents/${TARGET_WORKFLOW_PATH}?ref=${target.headSha}`,
    );
    if (workflow.payload?.type !== 'file' || typeof workflow.payload?.sha !== 'string') {
      return fail('observation_incomplete', target);
    }
    if (workflow.payload.sha !== targetCapability.workflowBlobSha) {
      return block('workflow_blob_mismatch', target);
    }

    const jobs = await client.getJson(
      `/repos/${TARGET_REPOSITORY}/actions/runs/${targetRunId}/jobs?filter=latest&per_page=1&page=1`,
    );
    if (!Number.isSafeInteger(jobs.payload?.total_count)
        || jobs.payload.total_count < 0
        || !Array.isArray(jobs.payload?.jobs)
        || jobs.payload.jobs.length > 1
        || (jobs.payload.total_count === 0 && jobs.payload.jobs.length !== 0)
        || (jobs.payload.total_count > 0 && jobs.payload.jobs.length !== 1)) {
      return fail('observation_incomplete', target);
    }
    if (jobs.payload.total_count > 0) return block('cancelled_with_jobs', target);

    const finalLiveness = await observeTranslateQueueLiveness({
      fetchImpl,
      now,
      repository,
      token,
    });
    finalLivenessGets = finalLiveness.queryBudget.usedGets;
    if (finalLiveness.complete !== true || finalLiveness.failClosed !== false
        || finalLivenessGets !== MAX_LIVENESS_GET_REQUESTS) {
      for (const reason of finalLiveness.reasonCodes ?? []) {
        if (RECOVERY_REASON_CODES.includes(reason)) reasons.add(reason);
      }
      return fail('observation_incomplete', target);
    }
    queueCounts = finalLiveness.counts;
    const active = queueCounts.active;
    const pending = queueCounts.pending;
    if (active > 0 && pending > 0) return block('active_and_pending_present', target);
    if (active > 0) return block('active_present', target);
    if (pending > 0) return block('pending_present', target);
    reasons.add('queue_empty');

    if (requireExecutionDedupe && targetCapability.executionDedupeProtocolVersion !== 1) {
      return block('target_execution_dedupe_not_live', target);
    }

    const claim = createRecoveryClaim({ headSha: target.headSha, targetCapability, targetRunId });
    const claimState = await readClaim(client, claim);
    if (claimState.state === 'exact') {
      if (acceptedClaimKey === claim.claimKey) {
        reasons.add('claim_verified');
        return finish({ claim, eligible: true, primaryReason: 'claim_verified', target });
      }
      return block('already_claimed_no_retry', target);
    }
    if (acceptedClaimKey !== null) return fail('claim_conflict', target);
    return finish({ claim, eligible: true, primaryReason: 'queue_empty', target });
  } catch (error) {
    const specific = error instanceof RecoveryFailure ? error.code : 'api_incomplete';
    reasons.add(specific);
    const primaryReason = specific === 'claim_conflict' ? specific : 'observation_incomplete';
    reasons.add(primaryReason);
    return finish({ complete: false, primaryReason, target });
  }
}

export function buildRecoveryReport({
  claimCommitSha = null,
  decision,
  inspection,
  mode,
  mutationBudget = { maxPosts: 0, maxPuts: 0, usedPosts: 0, usedPuts: 0 },
  now,
  phase,
  primaryReason,
  reasonCodes = [],
}) {
  const combined = new Set([...inspection.reasonCodes, ...reasonCodes]);
  const report = {
    capabilities: {
      recoverySchedule: {
        preservation: 'verified',
        proof: RERUN_PRESERVATION_PROOF,
        reason: 'blocked_by_policy_and_target_dedupe',
        state: 'blocked',
      },
    },
    claim: inspection.claim === null ? null : {
      commitSha: claimCommitSha,
      documentDigest: inspection.claim.documentDigest,
      key: inspection.claim.claimKey,
      path: inspection.claim.claimPath,
    },
    complete: inspection.complete,
    decision,
    failClosed: inspection.failClosed,
    failureSemantics: 'at_most_once_claim_consumed_on_ambiguous_outcome',
    mode,
    mutationBudget,
    observedAt: new Date(now).toISOString(),
    phase,
    primaryReason,
    queryBudget: inspection.queryBudget,
    queue: inspection.queue,
    reasonCodes: orderedReasons(combined),
    schema: MUTATION_REPORT_SCHEMA,
    target: inspection.target,
  };
  const json = `${canonicalJson(report)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_MUTATION_REPORT_BYTES) {
    throw new TypeError('mutation_report_too_large');
  }
  return { json, report };
}

export async function runRecoveryClaim({
  clock = Date.now,
  fetchImpl = globalThis.fetch,
  mode = 'observe_only',
  now = Date.now(),
  phase = 'observe',
  repository = TARGET_REPOSITORY,
  targetCapability = TARGET_EXECUTION_CAPABILITY,
  targetRunId,
  token = '',
} = {}) {
  const deadlineAt = clock() + PROCESS_TIMEOUT_MS;
  if (!MODES.has(mode)) {
    const inspection = failureInspection({ code: 'invalid_mode' });
    return buildRecoveryReport({
      decision: 'blocked', inspection, mode, now, phase, primaryReason: 'invalid_mode',
    });
  }
  if (!PHASES.has(phase)) {
    const inspection = failureInspection({ code: 'invalid_phase' });
    return buildRecoveryReport({
      decision: 'blocked', inspection, mode, now, phase, primaryReason: 'invalid_phase',
    });
  }
  if (phase === 'claim' && mode !== 'claim_and_rerun') {
    const inspection = failureInspection({ code: 'invalid_mode' });
    return buildRecoveryReport({
      decision: 'blocked', inspection, mode, now, phase, primaryReason: 'invalid_mode',
    });
  }

  const inspection = await inspectRecoveryTarget({
    clock,
    deadlineAt,
    fetchImpl,
    now,
    repository,
    requireExecutionDedupe: mode === 'claim_and_rerun',
    targetCapability,
    targetRunId,
    token,
  });
  if (!inspection.eligible) {
    return buildRecoveryReport({
      decision: 'blocked', inspection, mode, now, phase, primaryReason: inspection.primaryReason,
    });
  }
  if (phase === 'observe') {
    const reason = mode === 'observe_only' ? 'eligible_observe_only' : 'queue_empty';
    return buildRecoveryReport({
      decision: mode === 'observe_only' ? 'observe_only' : 'eligible',
      inspection,
      mode,
      now,
      phase,
      primaryReason: reason,
      reasonCodes: mode === 'observe_only' ? ['eligible_observe_only'] : [],
    });
  }

  const client = createClaimGithubClient({
    clock,
    deadlineAt,
    fetchImpl,
    maxGets: MAX_PHASE_GET_REQUESTS - inspection.queryBudget.usedGets,
    token,
  });
  const mutationBudget = () => ({
    maxPosts: 0,
    maxPuts: MAX_PHASE_PUT_REQUESTS,
    usedPosts: 0,
    usedPuts: client.budget().usedPuts,
  });
  const inspectionGets = inspection.queryBudget.usedGets;
  const updateInspectionBudget = () => {
    inspection.queryBudget.usedGets = inspectionGets + client.budget().usedGets;
  };

  try {
    const created = await client.createClaim({
      bytes: inspection.claim.bytes,
      claimPath: inspection.claim.claimPath,
      targetRunId,
    });
    if (created.status !== 201) {
      const resolved = await readClaim(client, inspection.claim);
      updateInspectionBudget();
      if (resolved.state === 'exact') {
        return buildRecoveryReport({
          decision: 'blocked',
          inspection,
          mode,
          mutationBudget: mutationBudget(),
          now,
          phase,
          primaryReason: 'already_claimed_no_retry',
          reasonCodes: ['already_claimed_no_retry'],
        });
      }
      throw new RecoveryFailure('claim_conflict');
    }
    if (created.payload?.content?.path !== inspection.claim.claimPath
        || created.payload?.content?.sha !== inspection.claim.gitBlobSha
        || typeof created.payload?.commit?.sha !== 'string'
        || !SHA_RE.test(created.payload.commit.sha)) {
      throw new RecoveryFailure('claim_conflict');
    }
    const verified = await readClaim(client, inspection.claim);
    if (verified.state !== 'exact') throw new RecoveryFailure('claim_conflict');
    updateInspectionBudget();
    return buildRecoveryReport({
      claimCommitSha: created.payload.commit.sha,
      decision: 'claim_created',
      inspection,
      mode,
      mutationBudget: mutationBudget(),
      now,
      phase,
      primaryReason: 'claim_created',
      reasonCodes: ['claim_created'],
    });
  } catch (error) {
    updateInspectionBudget();
    inspection.complete = false;
    inspection.failClosed = true;
    const specific = error instanceof RecoveryFailure ? error.code : 'claim_conflict';
    return buildRecoveryReport({
      decision: 'blocked',
      inspection,
      mode,
      mutationBudget: mutationBudget(),
      now,
      phase,
      primaryReason: specific,
      reasonCodes: [specific],
    });
  }
}

function writeGithubOutputs(report, outputPath) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) return;
  const claimKey = report.claim?.key ?? '';
  const claimCommitSha = report.claim?.commitSha ?? '';
  appendFileSync(outputPath, [
    `claim_commit_sha=${claimCommitSha}`,
    `claim_created=${report.decision === 'claim_created'}`,
    `claim_key=${claimKey}`,
    `decision=${report.decision}`,
    `eligible=${report.decision === 'eligible'}`,
    '',
  ].join('\n'), 'utf8');
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runRecoveryClaim({
    mode: process.env.RECOVERY_MODE,
    phase: process.env.RECOVERY_PHASE,
    repository: process.env.GITHUB_REPOSITORY,
    targetRunId: process.env.TARGET_RUN_ID,
    token: process.env.GITHUB_TOKEN,
  }).then(({ json, report }) => {
    process.stdout.write(json);
    writeGithubOutputs(report, process.env.GITHUB_OUTPUT);
    if (report.failClosed) process.exitCode = 1;
  }).catch(() => {
    console.error('translate_queue_recovery_claim_error:internal_failure');
    process.exitCode = 1;
  });
}
