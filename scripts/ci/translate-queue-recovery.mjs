#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPORT_SCHEMA = 'translate-queue-recovery-watchdog/v1';
export const TARGET_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
export const TARGET_WORKFLOW_ID = 342441975;
export const TARGET_WORKFLOW_PATH = '.github/workflows/translate-pending.yml';
export const TARGET_WORKFLOW_BLOB_SHA = 'f782b4b2761ab87ba7792d256b64ab09c2e206ea';
export const TARGET_BRANCH = 'main';
export const QUEUE_MAX_BOUNDARY_SHA = '5e5114b73f37a0c47625f00baff13942fe8b186b';
export const RECOVERY_PROOF_CUTOFF = '2026-09-01T17:20:00.000Z';
export const MAX_RUN_PAGES = 2;
export const RUNS_PER_PAGE = 100;
export const MAX_DEEP_CANDIDATES = 20;
export const MAX_TOTAL_GET_REQUESTS = 30;
export const BOOTSTRAP_GET_REQUESTS = 1;
export const MAX_GET_REQUESTS = MAX_TOTAL_GET_REQUESTS - BOOTSTRAP_GET_REQUESTS;
export const MAX_SAMPLE_RUN_IDS = 5;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_REPORT_BYTES = 16 * 1024;

const API_ROOT = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 8_000;
const SHA_RE = /^[a-f0-9]{40}$/;
const RUN_ID_RE = /^[1-9][0-9]{0,19}$/;
const ALLOWED_EVENTS = new Set(['schedule', 'workflow_dispatch']);
const ACTIVE_STATUSES = new Set(['in_progress']);
const PENDING_STATUSES = new Set(['pending', 'queued', 'requested', 'waiting']);

export const REASON_CODES = Object.freeze([
  'active_pending_present',
  'already_recovered_not_evaluated',
  'api_http_error',
  'api_incomplete',
  'api_invalid_json',
  'api_network_error',
  'api_rate_limited',
  'api_response_too_large',
  'boundary_non_descendant',
  'boundary_unknown',
  'cancelled_job_zero_candidate',
  'cancelled_with_jobs',
  'claim_state_not_evaluated',
  'deep_candidate_limit_exceeded',
  'invalid_created_at',
  'invalid_head_sha',
  'invalid_mode',
  'invalid_repository',
  'malformed_run',
  'missing_token',
  'no_active_pending',
  'pagination_inconclusive',
  'queue_age_observed_no_threshold',
  'query_budget_exhausted',
  'recovery_schedule_blocked_not_proven',
  'wrong_blob',
  'wrong_conclusion',
  'wrong_event',
  'wrong_head_branch',
  'wrong_path',
  'wrong_status',
  'wrong_workflow',
  'wrong_attempt',
]);

class ObservationFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function createReasonState() {
  return {
    counts: Object.fromEntries(REASON_CODES.map((code) => [code, 0])),
    samples: Object.fromEntries(REASON_CODES.map((code) => [code, []])),
  };
}

function addReason(state, code, runId = null) {
  if (!Object.hasOwn(state.reasons.counts, code)) throw new TypeError('unknown_reason_code');
  state.reasons.counts[code] += 1;
  if (runId !== null && state.reasons.samples[code].length < MAX_SAMPLE_RUN_IDS) {
    state.reasons.samples[code].push(runId);
  }
}

function validRunId(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
  const text = String(value ?? '');
  return RUN_ID_RE.test(text) ? text : null;
}

function validTimestamp(value) {
  const milliseconds = Date.parse(String(value ?? ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function compareRuns(left, right) {
  const leftCreated = validTimestamp(left?.created_at) ?? -1;
  const rightCreated = validTimestamp(right?.created_at) ?? -1;
  if (leftCreated !== rightCreated) return rightCreated - leftCreated;
  const leftId = validRunId(left?.id) ?? '';
  const rightId = validRunId(right?.id) ?? '';
  return rightId.localeCompare(leftId, 'en', { numeric: true });
}

function makeInitialState(nowMs) {
  return {
    nowMs,
    reasons: createReasonState(),
    scannedRuns: 0,
    deepCandidates: 0,
    deepInspected: 0,
    activeRunIds: [],
    pendingRunIds: [],
    queueCreatedMs: [],
    complete: true,
  };
}

function failClosed(state, code, runId = null) {
  state.complete = false;
  addReason(state, code, runId);
}

export function createReadOnlyGithubClient({ fetchImpl, token }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('invalid_fetch');
  let usedGets = 0;
  let exhausted = false;

  return {
    budget() {
      return { exhausted, maxGets: MAX_GET_REQUESTS, usedGets };
    },

    async getJson(apiPath) {
      if (usedGets >= MAX_GET_REQUESTS) {
        exhausted = true;
        throw new ObservationFailure('query_budget_exhausted');
      }
      usedGets += 1;

      let response;
      try {
        response = await fetchImpl(`${API_ROOT}${apiPath}`, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'translate-queue-recovery-watchdog-v1',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
      } catch {
        throw new ObservationFailure('api_network_error');
      }

      const remaining = response?.headers?.get?.('x-ratelimit-remaining');
      if (response?.status === 429 || (response?.status === 403 && remaining === '0')) {
        throw new ObservationFailure('api_rate_limited');
      }
      if (!response?.ok) throw new ObservationFailure('api_http_error');

      const declaredLength = Number(response?.headers?.get?.('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new ObservationFailure('api_response_too_large');
      }
      let text = '';
      try {
        if (typeof response?.body?.getReader === 'function') {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let receivedBytes = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedBytes += value.byteLength;
            if (receivedBytes > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new ObservationFailure('api_response_too_large');
            }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } else {
          text = await response.text();
          if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
            throw new ObservationFailure('api_response_too_large');
          }
        }
      } catch (error) {
        if (error instanceof ObservationFailure) throw error;
        throw new ObservationFailure('api_incomplete');
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new ObservationFailure('api_invalid_json');
      }
    },
  };
}

async function listAllBoundedRuns(client, state) {
  const collected = [];
  let declaredTotal = null;

  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const query = new URLSearchParams({
      branch: TARGET_BRANCH,
      page: String(page),
      per_page: String(RUNS_PER_PAGE),
    });
    const payload = await client.getJson(
      `/repos/${TARGET_REPOSITORY}/actions/workflows/${TARGET_WORKFLOW_ID}/runs?${query}`,
    );
    if (!Number.isSafeInteger(payload?.total_count) || payload.total_count < 0
        || !Array.isArray(payload?.workflow_runs)
        || payload.workflow_runs.length > RUNS_PER_PAGE) {
      throw new ObservationFailure('api_incomplete');
    }
    if (declaredTotal === null) declaredTotal = payload.total_count;
    if (payload.total_count !== declaredTotal) throw new ObservationFailure('pagination_inconclusive');
    collected.push(...payload.workflow_runs);
    if (collected.length >= declaredTotal) break;
  }

  const ids = collected.map((run) => validRunId(run?.id));
  if (declaredTotal > MAX_RUN_PAGES * RUNS_PER_PAGE
      || collected.length !== declaredTotal
      || ids.some((id) => id === null)
      || new Set(ids).size !== ids.length) {
    failClosed(state, 'pagination_inconclusive');
  }
  return collected.slice(0, MAX_RUN_PAGES * RUNS_PER_PAGE).sort(compareRuns);
}

function collectShallowFacts(run, state, candidates) {
  const runId = validRunId(run?.id);
  if (runId === null || run === null || typeof run !== 'object' || Array.isArray(run)) {
    addReason(state, 'malformed_run');
    return;
  }

  let eligible = true;
  if (run.workflow_id !== TARGET_WORKFLOW_ID) {
    addReason(state, 'wrong_workflow', runId);
    eligible = false;
  }
  if (run.path !== TARGET_WORKFLOW_PATH) {
    addReason(state, 'wrong_path', runId);
    eligible = false;
  }
  if (run.head_branch !== TARGET_BRANCH) {
    addReason(state, 'wrong_head_branch', runId);
    eligible = false;
  }
  if (!ALLOWED_EVENTS.has(run.event)) {
    addReason(state, 'wrong_event', runId);
    eligible = false;
  }
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt !== 1) {
    addReason(state, 'wrong_attempt', runId);
    eligible = false;
  }
  if (typeof run.head_sha !== 'string' || !SHA_RE.test(run.head_sha)) {
    addReason(state, 'invalid_head_sha', runId);
    eligible = false;
  }

  const isActive = ACTIVE_STATUSES.has(run.status);
  const isPending = PENDING_STATUSES.has(run.status);
  if (isActive || isPending) {
    if (run.conclusion !== null) {
      addReason(state, 'wrong_conclusion', runId);
      return;
    }
    const createdMs = validTimestamp(run.created_at);
    if (createdMs === null) {
      addReason(state, 'invalid_created_at', runId);
      return;
    }
    if (isActive) state.activeRunIds.push(runId);
    if (isPending) state.pendingRunIds.push(runId);
    state.queueCreatedMs.push(createdMs);
    return;
  }

  if (run.status !== 'completed') {
    addReason(state, 'wrong_status', runId);
    return;
  }
  if (run.conclusion !== 'cancelled') {
    addReason(state, 'wrong_conclusion', runId);
    return;
  }
  if (validTimestamp(run.created_at) === null) {
    addReason(state, 'invalid_created_at', runId);
    return;
  }
  if (eligible) candidates.push({ headSha: run.head_sha, runId });
}

async function inspectCandidate(client, state, candidate) {
  let ancestry;
  try {
    ancestry = await client.getJson(
      `/repos/${TARGET_REPOSITORY}/compare/${QUEUE_MAX_BOUNDARY_SHA}...${candidate.headSha}`,
    );
  } catch (error) {
    addReason(state, 'boundary_unknown', candidate.runId);
    throw error;
  }
  if (!['ahead', 'identical', 'behind', 'diverged'].includes(ancestry?.status)) {
    failClosed(state, 'boundary_unknown', candidate.runId);
    return;
  }
  if (ancestry.status === 'behind' || ancestry.status === 'diverged') {
    addReason(state, 'boundary_non_descendant', candidate.runId);
    return;
  }

  const blob = await client.getJson(
    `/repos/${TARGET_REPOSITORY}/contents/${TARGET_WORKFLOW_PATH}?ref=${candidate.headSha}`,
  );
  if (blob?.type !== 'file' || typeof blob?.sha !== 'string') {
    throw new ObservationFailure('api_incomplete');
  }
  if (blob.sha !== TARGET_WORKFLOW_BLOB_SHA) {
    addReason(state, 'wrong_blob', candidate.runId);
    return;
  }

  const jobs = await client.getJson(
    `/repos/${TARGET_REPOSITORY}/actions/runs/${candidate.runId}/jobs?filter=latest&per_page=1&page=1`,
  );
  if (!Number.isSafeInteger(jobs?.total_count) || jobs.total_count < 0
      || !Array.isArray(jobs?.jobs) || jobs.jobs.length > 1
      || (jobs.total_count === 0 && jobs.jobs.length !== 0)
      || (jobs.total_count > 0 && jobs.jobs.length !== 1)) {
    throw new ObservationFailure('api_incomplete');
  }
  state.deepInspected += 1;
  addReason(
    state,
    jobs.total_count === 0 ? 'cancelled_job_zero_candidate' : 'cancelled_with_jobs',
    candidate.runId,
  );
}

function buildReport(state, client) {
  const activePendingCount = state.activeRunIds.length + state.pendingRunIds.length;
  if (activePendingCount > 0) {
    state.reasons.counts.active_pending_present = activePendingCount;
    state.reasons.samples.active_pending_present = [
      ...state.activeRunIds,
      ...state.pendingRunIds,
    ].slice(0, MAX_SAMPLE_RUN_IDS);
    addReason(state, 'queue_age_observed_no_threshold');
  } else {
    addReason(state, 'no_active_pending');
  }
  addReason(state, 'already_recovered_not_evaluated');
  addReason(state, 'claim_state_not_evaluated');
  addReason(state, 'recovery_schedule_blocked_not_proven');

  const oldestCreatedMs = state.queueCreatedMs.length > 0
    ? Math.min(...state.queueCreatedMs)
    : null;
  const nonEmptySamples = Object.fromEntries(
    Object.entries(state.reasons.samples).filter(([, runIds]) => runIds.length > 0),
  );
  const report = {
    capabilities: {
      alreadyRecovered: { state: 'not_evaluated' },
      claimState: { state: 'not_evaluated' },
      recoverySchedule: {
        proofCutoff: RECOVERY_PROOF_CUTOFF,
        reason: 'rerun_preservation_not_proven',
        state: 'blocked',
      },
    },
    complete: state.complete,
    counts: {
      active: state.activeRunIds.length,
      byReason: state.reasons.counts,
      deepCandidates: state.deepCandidates,
      deepInspected: state.deepInspected,
      pending: state.pendingRunIds.length,
      scannedRuns: state.scannedRuns,
    },
    decision: 'observe_only',
    failClosed: !state.complete,
    observedAt: new Date(state.nowMs).toISOString(),
    queryBudget: client.budget(),
    queue: {
      activePendingPresent: activePendingCount > 0,
      oldestAgeSeconds: oldestCreatedMs === null
        ? null
        : Math.max(0, Math.floor((state.nowMs - oldestCreatedMs) / 1000)),
      oldestCreatedAt: oldestCreatedMs === null ? null : new Date(oldestCreatedMs).toISOString(),
      staleThreshold: 'not_evaluated',
    },
    reasonCodes: REASON_CODES.filter((code) => state.reasons.counts[code] > 0),
    samples: nonEmptySamples,
    schema: REPORT_SCHEMA,
    target: {
      branch: TARGET_BRANCH,
      queueMaxBoundarySha: QUEUE_MAX_BOUNDARY_SHA,
      workflowBlobSha: TARGET_WORKFLOW_BLOB_SHA,
      workflowId: TARGET_WORKFLOW_ID,
      workflowPath: TARGET_WORKFLOW_PATH,
    },
  };
  const json = `${canonicalJson(report)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_REPORT_BYTES) {
    throw new TypeError('watchdog_report_too_large');
  }
  return { json, report };
}

export async function observeTranslateQueue({
  fetchImpl = globalThis.fetch,
  mode = 'dry-run',
  now = Date.now(),
  repository = TARGET_REPOSITORY,
  token = '',
} = {}) {
  if (!Number.isFinite(now)) throw new TypeError('invalid_now');
  const state = makeInitialState(now);
  const client = createReadOnlyGithubClient({ fetchImpl, token });

  if (mode !== 'dry-run') {
    failClosed(state, 'invalid_mode');
    return buildReport(state, client);
  }
  if (repository !== TARGET_REPOSITORY) {
    failClosed(state, 'invalid_repository');
    return buildReport(state, client);
  }
  if (typeof token !== 'string' || token.length === 0) {
    failClosed(state, 'missing_token');
    return buildReport(state, client);
  }

  try {
    const runs = await listAllBoundedRuns(client, state);
    state.scannedRuns = runs.length;
    if (!state.complete) return buildReport(state, client);

    const candidates = [];
    for (const run of runs) collectShallowFacts(run, state, candidates);
    state.deepCandidates = candidates.length;
    if (candidates.length > MAX_DEEP_CANDIDATES) {
      failClosed(state, 'deep_candidate_limit_exceeded');
    }
    for (const candidate of candidates.slice(0, MAX_DEEP_CANDIDATES)) {
      await inspectCandidate(client, state, candidate);
    }
  } catch (error) {
    const code = error instanceof ObservationFailure ? error.code : 'api_incomplete';
    failClosed(state, code);
  }
  return buildReport(state, client);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  observeTranslateQueue({
    mode: process.env.RECOVERY_MODE,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
  }).then(({ json, report }) => {
    process.stdout.write(json);
    if (report.failClosed) process.exitCode = 1;
  }).catch(() => {
    console.error('translate_queue_recovery_watchdog_error:internal_failure');
    process.exitCode = 1;
  });
}
