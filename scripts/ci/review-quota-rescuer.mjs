#!/usr/bin/env node
/**
 * review-quota-rescuer.mjs — riavvia una review che ha perso il lease.
 *
 * Un consumer PR può terminare senza Claude perché il fixer issue possiede lo
 * slot condiviso. Senza un nuovo evento la PR resta nel gate rosso: questo
 * consumer zero-Claude ascolta la fine dei fixer e un cron di rete, riserva lo
 * slot quando è libero e rilancia SOLO il run sorgente sulla stessa HEAD. Il
 * workflow rilanciato adotta poi la reservation e la rilascia nel proprio
 * finally.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseReviewQuotaDeferredMarker,
  REVIEW_QUOTA_SOURCE_EVENTS_BY_ROLE,
  REVIEW_QUOTA_TRUSTED_ACTOR_RE,
  REVIEW_QUOTA_SOURCE_WORKFLOW_BY_ROLE,
  REVIEW_QUOTA_SOURCE_WORKFLOW_NAME_BY_ROLE,
  runQuotaLease,
} from './check-quota-backoff.mjs';
import {
  latestReviewClaims,
  reviewWasPosted,
} from './review-claim.mjs';
import { latestRedcheckFixClaims } from './redcheck-review-prefilter.mjs';
import { normalizeReviewInputRevision, PR_BODY_JQ } from './review-test-policy.mjs';

export const REVIEW_QUOTA_RETRY_MARKER = '<!-- REVIEW_QUOTA_RETRY:';
export const REVIEW_TRANSIENT_RETRY_MARKER = '<!-- REVIEW_TRANSIENT_RETRY:';
const REVIEW_QUOTA_RETRY_RE = /<!-- REVIEW_QUOTA_RETRY:\s*(\{[\s\S]*?\})\s*-->/;
const REVIEW_TRANSIENT_RETRY_RE = /<!-- REVIEW_TRANSIENT_RETRY:\s*(\{[\s\S]*?\})\s*-->/;
const PR_QUOTA_ROLES = new Set(['review', 'redflag', 'redcheck']);
const REVIEW_QUOTA_RETRY_STATES = new Set(['requested', 'confirmed', 'failed']);
const REVIEW_QUOTA_RETRY_ACTIVE_STATES = new Set(['requested', 'confirmed']);
const REVIEW_TRANSIENT_RETRY_STATES = new Set(['requested', 'confirmed', 'failed']);
const PR_HEAD_RE = /^[a-f0-9]{40}$/i;
const REVIEW_QUOTA_REQUEST_GRACE_SEC = positiveInt(
  process.env.REVIEW_QUOTA_RESCUER_REQUEST_GRACE_SEC,
  30 * 60,
);
const SOURCE_WORKFLOW_BY_ROLE = Object.freeze({
  review: 'tests',
  ...REVIEW_QUOTA_SOURCE_WORKFLOW_NAME_BY_ROLE,
});

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const MAX_PRS = positiveInt(process.env.REVIEW_QUOTA_RESCUER_MAX_PRS, 100);
const MAX_RETRIES = positiveInt(process.env.REVIEW_QUOTA_RESCUER_MAX_RETRIES, 1);
const MAX_TRANSIENT_RETRIES = positiveInt(process.env.REVIEW_TRANSIENT_RESCUER_MAX_RETRIES, 1);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
}

function parseJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function apiPages(path) {
  let raw;
  try {
    raw = gh(['api', '--paginate', '--slurp', path]);
  } catch (error) {
    throw new Error(`GitHub API non leggibile per ${path}: ${String(error?.message || error).slice(0, 180)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`GitHub API malformata per ${path}: JSON non valido`);
  }
  if (!Array.isArray(parsed) || parsed.some((page) => !Array.isArray(page))) {
    throw new Error(`GitHub API malformata per ${path}: attese pagine array`);
  }
  return parsed.flat();
}

function commentRank(comment, index) {
  const parsed = Date.parse(comment?.created_at ?? comment?.createdAt ?? '');
  return [Number.isFinite(parsed) ? parsed : 0, Number(comment?.id) || 0, index];
}

function laterRank(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? a : b;
  }
  return b;
}

function isTrustedAutomationComment(comment) {
  const login = String(comment?.user?.login || comment?.author?.login || '');
  return !login || REVIEW_QUOTA_TRUSTED_ACTOR_RE.test(login);
}

/** Parse one bounded retry for a transient review-gate failure. Pure. */
export function parseReviewTransientRetryMarker(body) {
  const match = String(body || '').match(REVIEW_TRANSIENT_RETRY_RE);
  if (!match) return null;
  let event;
  try { event = JSON.parse(match[1]); } catch { return null; }
  const sourceAttempt = Number(event?.sourceAttempt);
  const retryCount = Number(event?.retryCount);
  const issuedAt = Number(event?.issuedAt);
  const reviewRevision = normalizeReviewInputRevision(event?.reviewRevision);
  if (!event || event.version !== 1
      || !/^[a-f0-9]{40}$/i.test(String(event.head || ''))
      || !/^\d+$/.test(String(event.sourceRunId || ''))
      || !String(event.claimToken || '')
      || !String(event.runId || '')
      || reviewRevision === null || !reviewRevision
      || !Number.isSafeInteger(sourceAttempt) || sourceAttempt < 1
      || !Number.isSafeInteger(retryCount) || retryCount < 1
      || (event.issuedAt !== undefined && (!Number.isSafeInteger(issuedAt) || issuedAt < 1))
      || !REVIEW_TRANSIENT_RETRY_STATES.has(String(event.state || ''))) return null;
  return {
    ...event,
    head: String(event.head).toLowerCase(),
    sourceRunId: String(event.sourceRunId),
    claimToken: String(event.claimToken),
    runId: String(event.runId),
    reviewRevision,
    // Markers emitted before the timestamp field was introduced remain
    // parseable; latestReviewTransientRetry fills their timestamp from the
    // trusted GitHub comment time. New markers always persist issuedAt.
    issuedAt: Number.isSafeInteger(issuedAt) && issuedAt > 0 ? issuedAt : 0,
    sourceAttempt,
    retryCount,
    state: String(event.state),
  };
}

/** Durable marker body for the one-shot review recovery. Pure. */
export function reviewTransientRetryBody({
  head, reviewRevision, claimToken, sourceRunId, sourceAttempt, runId,
  retryCount, state = 'confirmed', issuedAt = Math.floor(Date.now() / 1000),
}) {
  const event = {
    version: 1,
    head: String(head),
    reviewRevision: String(reviewRevision),
    claimToken: String(claimToken),
    sourceRunId: String(sourceRunId),
    sourceAttempt: Number(sourceAttempt),
    runId: String(runId),
    retryCount: Number(retryCount),
    state: String(state),
    issuedAt: Number(issuedAt),
  };
  return `${REVIEW_TRANSIENT_RETRY_MARKER} ${JSON.stringify(event)} -->\n`
    + `_Review gate transient rescuer zero-Claude: rerun bounded ${event.retryCount} su `
    + `PR HEAD ${event.head.slice(0, 12)} dopo claim ${event.claimToken}._`;
}

function retryEntryRank(entry) {
  return [Number(entry?.commentAt) || 0, Number(entry?.commentId) || 0, Number(entry?.commentOrder) || 0];
}

function compareRanks(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/** Latest transient retry marker for one PR HEAD/review-body revision. Pure. */
export function latestReviewTransientRetry(
  comments = [],
  { head = '', reviewRevision = '' } = {},
) {
  const expectedRevision = normalizeReviewInputRevision(reviewRevision);
  if (expectedRevision === null || !expectedRevision) return null;
  let best = null;
  for (const [index, comment] of (comments || []).entries()) {
    if (!isTrustedAutomationComment(comment)) continue;
    const event = parseReviewTransientRetryMarker(comment?.body);
    if (!event || event.head !== String(head).toLowerCase()
        || event.reviewRevision !== expectedRevision) continue;
    const entry = {
      event: event.issuedAt > 0 || !Number.isFinite(Date.parse(comment?.created_at ?? comment?.createdAt ?? ''))
        ? event
        : { ...event, issuedAt: Math.floor(Date.parse(comment?.created_at ?? comment?.createdAt) / 1000) },
      commentAt: Date.parse(comment?.created_at ?? comment?.createdAt ?? '') / 1000,
      commentId: Number(comment?.id) || index,
      commentOrder: index,
    };
    if (!best || compareRanks(retryEntryRank(best), retryEntryRank(entry)) < 0) best = entry;
  }
  return best?.event || null;
}

/**
 * Return the latest failed-transient review claim eligible for one bounded
 * rerun. A current active/terminal claim, a different body revision, or a
 * consumed retry closes admission. Pure and fail-closed.
 */
export function pendingReviewTransientClaim({
  head = '', reviewRevision = '', comments = [],
  nowSec = Math.floor(Date.now() / 1000), maxRetries = MAX_TRANSIENT_RETRIES,
} = {}) {
  const normalizedHead = String(head).toLowerCase();
  const expectedRevision = normalizeReviewInputRevision(reviewRevision);
  const retryLimit = positiveInt(maxRetries, MAX_TRANSIENT_RETRIES);
  if (!/^[a-f0-9]{40}$/i.test(normalizedHead) || !expectedRevision) return null;

  const claims = latestReviewClaims(comments).filter((claim) => (
    claim.headSha === normalizedHead && claim.reviewRevision === expectedRevision
  ));
  if (!claims.length) return null;
  if (claims.some((claim) => claim.state === 'completed' || claim.state === 'failed-terminal')) return null;
  if (claims.some((claim) => claim.state === 'active' && Number(claim.expiresAt) > Number(nowSec))) return null;

  const failed = claims
    .filter((claim) => claim.state === 'failed-transient')
    .sort((a, b) => compareRanks(retryEntryRank(a), retryEntryRank(b)));
  const claim = failed.at(-1);
  if (!claim) return null;

  const retry = latestReviewTransientRetry(comments, {
    head: normalizedHead,
    reviewRevision: expectedRevision,
  });
  const retryCount = Number(retry?.retryCount) || 0;
  // A requested marker at the limit is not a new retry to admit: it is a
  // durable lease whose source run still needs reconciliation.  Do not let
  // the retry cap strand it forever; only suppress new requests after the
  // limit, while `reconcileTransientRetry` can still observe requested.
  if (String(retry?.state || '') === 'confirmed'
      || (String(retry?.state || '') !== 'requested' && retryCount >= retryLimit)) return null;
  return { claim, retry, retryCount: retryCount + 1 };
}

/** Return the newest valid deferral marker, with its comment timestamp. Pure. */
export function latestReviewQuotaDeferred(comments = []) {
  let best = null;
  let bestRank = [0, 0, -1];
  for (const [index, comment] of (comments || []).entries()) {
    if (!isTrustedAutomationComment(comment)) continue;
    const event = parseReviewQuotaDeferredMarker(comment?.body);
    if (!event) continue;
    const rank = commentRank(comment, index);
    const selected = laterRank(bestRank, rank);
    if (selected === rank) {
      best = {
        ...event,
        commentId: Number(comment?.id) || null,
        createdAt: comment?.created_at ?? comment?.createdAt ?? '',
      };
      bestRank = rank;
    }
  }
  return best;
}

/** Parse one retry marker. Pure. */
export function parseReviewQuotaRetryMarker(body) {
  const match = String(body || '').match(REVIEW_QUOTA_RETRY_RE);
  if (!match) return null;
  let event;
  try { event = JSON.parse(match[1]); } catch { return null; }
  // I marker v1 emessi prima della riconciliazione non avevano `state`: erano
  // scritti dopo un rerun riuscito, quindi il valore retrocompatibile è
  // `confirmed`.
  const state = String(event?.state || 'confirmed');
  const sourceAttempt = event?.sourceAttempt === undefined
    ? undefined
    : Number(event.sourceAttempt);
  if (!event || event.version !== 1
      || !/^[a-f0-9]{40}$/i.test(String(event.head || ''))
      || !PR_QUOTA_ROLES.has(String(event.role || ''))
      || !String(event.deferredRunId || '')
      || !String(event.sourceRunId || '')
      || !String(event.runId || '')
      || !REVIEW_QUOTA_RETRY_STATES.has(state)
      || (sourceAttempt !== undefined
        && (!Number.isSafeInteger(sourceAttempt) || sourceAttempt < 1))) return null;
  return {
    ...event,
    head: String(event.head),
    role: String(event.role),
    deferredRunId: String(event.deferredRunId),
    sourceRunId: String(event.sourceRunId),
    runId: String(event.runId),
    state,
    ...(sourceAttempt === undefined ? {} : { sourceAttempt }),
  };
}

/** Ultimo stato del retry per questa deferral, con il rank del commento. */
function latestReviewQuotaRetryEntry(
  comments = [],
  { head = '', role = '', deferredRunId = '' } = {},
) {
  let best = null;
  let bestRank = [0, 0, -1];
  for (const [index, comment] of (comments || []).entries()) {
    if (!isTrustedAutomationComment(comment)) continue;
    const event = parseReviewQuotaRetryMarker(comment?.body);
    if (!event
        || event.head !== String(head)
        || (role && event.role !== String(role))
        || event.deferredRunId !== String(deferredRunId)) continue;
    const rank = commentRank(comment, index);
    if (laterRank(bestRank, rank) === rank) {
      best = { event, rank };
      bestRank = rank;
    }
  }
  return best;
}

/** Ultimo stato del retry per questa deferral. Pure e append-only. */
export function latestReviewQuotaRetry(comments = [], options = {}) {
  return latestReviewQuotaRetryEntry(comments, options)?.event || null;
}

function rankAfter(a, b) {
  for (let i = 0; i < Math.max(a?.length || 0, b?.length || 0); i += 1) {
    const av = Number(a?.[i]) || 0;
    const bv = Number(b?.[i]) || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

/** True when this exact deferral has a newer active/confirmed retry. Pure. */
export function hasReviewQuotaRetry(comments = [], options = {}) {
  const latest = latestReviewQuotaRetryEntry(comments, options);
  const deferredRank = options?.deferredRank;
  return !!latest
    && REVIEW_QUOTA_RETRY_ACTIVE_STATES.has(latest.event.state)
    && (!Array.isArray(deferredRank) || rankAfter(latest.rank, deferredRank) > 0);
}

/**
 * Return every still-pending deferral on the current HEAD, one per
 * `(head, role, runId)`. A PR can have independent deferrals for review,
 * redflag and redcheck; looking only at the newest comment for the whole PR
 * would let a reconciled consumer hide an older one forever.
 * Pure and head-pinned.
 */
export function reviewQuotaDeferredCandidates({ head = '', comments = [] } = {}) {
  return pendingReviewQuotaDeferredEntries({ head, comments })
    .map(({ deferred }) => deferred);
}

/**
 * Return every deferral whose latest retry is not terminally reconciled.
 * includeRequested is used only by the rescuer itself: a requested marker
 * is a fence that must be reconciled against the source run before a new
 * rerun can be considered.
 */
function pendingReviewQuotaDeferredEntries({
  head = '',
  comments = [],
  includeRequested = false,
} = {}) {
  const grouped = new Map();
  for (const [index, comment] of (comments || []).entries()) {
    if (!isTrustedAutomationComment(comment)) continue;
    const event = parseReviewQuotaDeferredMarker(comment?.body);
    if (!event || event.head !== String(head)) continue;
    const rank = commentRank(comment, index);
    const key = `${event.head.toLowerCase()}\u0000${event.role}\u0000${event.runId}`;
    const previous = grouped.get(key);
    if (!previous || laterRank(previous.rank, rank) === rank) {
      grouped.set(key, {
        rank,
        deferred: {
          ...event,
          commentId: Number(comment?.id) || null,
          createdAt: comment?.created_at ?? comment?.createdAt ?? '',
        },
      });
    }
  }
  return [...grouped.values()]
    .map(({ deferred, rank }) => {
      const latestRetry = latestReviewQuotaRetryEntry(comments, {
        head,
        role: deferred.role,
        deferredRunId: deferred.runId,
      });
      const retry = latestRetry && rankAfter(latestRetry.rank, rank) > 0
        ? latestRetry
        : null;
      return { deferred, rank, retry };
    })
    .filter(({ retry }) => !retry
      || retry.event.state === 'failed'
      || (includeRequested && retry.event.state === 'requested'))
    .sort((a, b) => {
      const at = a.rank[0] || 0;
      const bt = b.rank[0] || 0;
      return at - bt || (a.rank[1] || 0) - (b.rank[1] || 0) || (a.rank[2] || 0) - (b.rank[2] || 0);
    })
}

/** Return the oldest pending retry candidate or null. Pure and head-pinned. */
export function deferredReviewCandidate({ head = '', comments = [] } = {}) {
  return reviewQuotaDeferredCandidates({ head, comments })[0] || null;
}

export function reviewQuotaRetryBody({
  head, deferredRunId, role, sourceRunId, runId, sourceAttempt, state = 'confirmed',
}) {
  const event = {
    version: 1,
    head: String(head),
    role: String(role),
    deferredRunId: String(deferredRunId),
    sourceRunId: String(sourceRunId),
    runId: String(runId),
    state: String(state),
  };
  const parsedAttempt = sourceAttempt === undefined || sourceAttempt === null
    ? undefined
    : Number(sourceAttempt);
  if (Number.isSafeInteger(parsedAttempt) && parsedAttempt > 0) {
    event.sourceAttempt = parsedAttempt;
  }
  return `${REVIEW_QUOTA_RETRY_MARKER} ${JSON.stringify(event)} -->\n`
    + `_Review quota rescuer zero-Claude: rilancio della run ${event.role} #${event.sourceRunId} `
    + `sulla HEAD ${event.head.slice(0, 12)} dopo il rilascio del lease._`;
}

function listOpenPullRequests() {
  const all = apiPages(`repos/${REPO}/pulls?state=open&per_page=100`);
  // Un elenco di pagine formalmente JSON ma senza i campi che il routing
  // consuma (`[[{}]]`, per esempio) non è «nessuna PR»: trasformarlo in una
  // coda vuota renderebbe il rescuer verde mentre osserva zero dati utili.
  if (!all.every((pr) => pr
      && typeof pr === 'object'
      && !Array.isArray(pr)
      && Number.isInteger(pr.number)
      && pr.number > 0
      && typeof pr.draft === 'boolean'
      && pr.head
      && typeof pr.head === 'object'
      && typeof pr.head.sha === 'string'
      && pr.head.sha.length > 0)) {
    throw new Error('elenco PR aperte malformato: campi di routing mancanti');
  }
  const eligible = all.filter((pr) => !pr.draft)
  const cursor = nonNegativeInt(
    process.env.REVIEW_QUOTA_RESCUER_CURSOR ?? process.env.GITHUB_RUN_NUMBER,
    0,
  );
  const selection = roundRobinWindow(eligible, { limit: MAX_PRS, cursor });
  if (selection.items.length < eligible.length) {
    console.log(
      `review-quota-rescuer: pool PR=${eligible.length}, finestra=${selection.items.length}, `
      + `round=${cursor}, start=${selection.start}; il prossimo run osserva una finestra diversa.`,
    );
  }
  return selection.items;
}

function nonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

export function roundRobinWindow(items, { limit = MAX_PRS, cursor = 0 } = {}) {
  const values = Array.isArray(items) ? items : [];
  const cap = positiveInt(limit, values.length || 1);
  if (values.length <= cap) return { items: values.slice(), start: 0 };
  const position = nonNegativeInt(cursor, 0);
  const start = ((position % values.length) * cap) % values.length;
  const rotated = values.slice(start).concat(values.slice(0, start));
  return { items: rotated.slice(0, cap), start };
}

function commentsForPr(number) {
  return apiPages(`repos/${REPO}/issues/${number}/comments?per_page=100`);
}

/** Hash exactly the API representation used by tests.yml, including its LF. */
function currentReviewRevision(number) {
  const body = gh([
    'api', `repos/${REPO}/pulls/${number}`, '--jq', PR_BODY_JQ,
  ], { allowFail: true });
  if (!body) return '';
  return `body:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

export function sourceWorkflowForRole(role) {
  return SOURCE_WORKFLOW_BY_ROLE[String(role)] || '';
}

export function sourceWorkflowPathForRole(role) {
  return REVIEW_QUOTA_SOURCE_WORKFLOW_BY_ROLE[String(role)] || '';
}

function sourceEventForRole(role, event) {
  return Array.isArray(REVIEW_QUOTA_SOURCE_EVENTS_BY_ROLE[String(role)])
    && REVIEW_QUOTA_SOURCE_EVENTS_BY_ROLE[String(role)].includes(String(event));
}

function sourceRunForTransientClaim(claim, head, { completedOnly = true } = {}) {
  const sourceRunId = String(claim?.runId || '');
  if (!/^\d+$/.test(sourceRunId)) return null;
  const raw = gh([
    'run', 'view', sourceRunId, '--repo', REPO,
    '--json', 'databaseId,headSha,status,workflowName,headBranch,event,attempt,conclusion',
  ], { allowFail: true });
  const run = parseJson(raw, null);
  if (!run
      || (completedOnly && run.status !== 'completed')
      || run.headSha !== String(head).toLowerCase()
      || run.workflowName !== SOURCE_WORKFLOW_BY_ROLE.review) return null;
  const attempt = Number(run.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  return {
    ...run,
    databaseId: String(run.databaseId || sourceRunId),
    attempt,
  };
}

function trustedSourceMarker(candidate) {
  const deferred = candidate?.deferred;
  if (deferred?.version !== 2) return true;
  const commentId = Number(deferred.commentId);
  if (!Number.isSafeInteger(commentId) || commentId < 1 || !Array.isArray(candidate?.comments)) return false;
  const comment = candidate.comments.find((item) => Number(item?.id) === commentId);
  const marker = parseReviewQuotaDeferredMarker(comment?.body);
  if (!marker
      || marker.version !== deferred.version
      || String(marker.head).toLowerCase() !== String(deferred.head).toLowerCase()
      || String(marker.runId) !== String(deferred.runId)
      || String(marker.role) !== String(deferred.role)
      || String(marker.prNumber) !== String(deferred.prNumber)
      || String(marker.sourceWorkflow) !== String(deferred.sourceWorkflow)
      || String(marker.sourceEvent) !== String(deferred.sourceEvent)
      || Number(marker.sourceAttempt) !== Number(deferred.sourceAttempt)) return false;
  const login = String(comment?.user?.login || comment?.author?.login || '');
  // `gh run view --json` has no actor field. The durable marker comment is
  // emitted by the fixer run itself, so its GitHub author is the provenance
  // actor we can verify without requesting an unsupported JSON property.
  return Boolean(login) && REVIEW_QUOTA_TRUSTED_ACTOR_RE.test(login);
}

function triggerRunForDeferred(candidate) {
  const triggerRunId = String(candidate?.deferred?.triggerRunId || '');
  if (!/^\d+$/.test(triggerRunId)) return null;
  const raw = gh([
    'run', 'view', triggerRunId, '--repo', REPO,
    '--json', 'databaseId,headSha,status,workflowName,event,attempt,conclusion',
  ], { allowFail: true });
  const run = parseJson(raw, null);
  if (!run || String(run.databaseId || triggerRunId) !== triggerRunId
      || String(run.workflowName || '') !== 'tests'
      || !['pull_request', 'workflow_dispatch'].includes(String(run.event || ''))
      || String(run.headSha || '').toLowerCase() !== String(candidate.head || '').toLowerCase()) return null;
  return {
    ...run,
    databaseId: triggerRunId,
    headSha: String(run.headSha).toLowerCase(),
  };
}

function sourceProvenanceForCandidate(candidate, run) {
  const deferred = candidate?.deferred;
  if (deferred?.version !== 2) {
    return { verified: String(run?.headSha || '').toLowerCase() === String(candidate?.head || '').toLowerCase() };
  }
  const role = String(deferred.role || '');
  if (String(deferred.prNumber || '') !== String(candidate?.pr?.number || '')
      || String(deferred.head || '').toLowerCase() !== String(candidate?.head || '').toLowerCase()
      || String(deferred.sourceWorkflow || '') !== sourceWorkflowPathForRole(role)
      || !sourceEventForRole(role, deferred.sourceEvent)
      || String(run?.workflowName || '') !== sourceWorkflowForRole(role)
      || String(run?.event || '') !== String(deferred.sourceEvent || '')) {
    return { verified: false, reason: 'fixer-provenance-mismatch' };
  }

  const runHead = String(run?.headSha || '').toLowerCase();
  const prHead = String(candidate?.head || '').toLowerCase();
  // workflow_run/dispatch children may legitimately report the workflow's
  // default branch. Their PR binding is proved by the triggering tests run;
  // only a direct pull_request_review run is required to carry the PR HEAD.
  if (deferred.sourceEvent === 'pull_request_review') {
    return runHead === prHead
      ? { verified: true }
      : { verified: false, reason: 'review-run-head-mismatch' };
  }
  if (deferred.sourceEvent === 'workflow_dispatch') {
    // Manual fixer runs are intentionally dispatched on the default branch,
    // so their own `headSha` is not the PR head. `currentTargetProof()` in the
    // caller verifies the trusted preflight intent against the live PR; the
    // allowlisted workflow/event/actor above binds that intent to this run.
    return { verified: true, dispatchIntent: true };
  }
  const trigger = triggerRunForDeferred(candidate);
  return trigger
    ? { verified: true, trigger }
    : { verified: false, reason: 'trigger-tests-head-unverified' };
}

export function sourceRunForCandidate(candidate, { completedOnly = true } = {}) {
  const sourceRunId = String(candidate?.deferred?.runId || '');
  const expectedWorkflow = sourceWorkflowForRole(candidate?.deferred?.role);
  if (!/^\d+$/.test(sourceRunId) || !expectedWorkflow) return null;
  const raw = gh([
    'run', 'view', sourceRunId, '--repo', REPO,
    '--json', 'databaseId,headSha,status,workflowName,headBranch,event,attempt,conclusion',
  ], { allowFail: true });
  const run = parseJson(raw, null);
  if (!run
      || (completedOnly && run.status !== 'completed')
      || String(run.databaseId || sourceRunId) !== sourceRunId
      || run.workflowName !== expectedWorkflow
      || !trustedSourceMarker(candidate)) return null;
  const provenance = sourceProvenanceForCandidate(candidate, run);
  if (!provenance.verified) return null;
  const attempt = Number(run.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  return {
    ...run,
    databaseId: String(run.databaseId || sourceRunId),
    attempt,
    provenanceVerified: true,
  };
}

/** Pure: an advanced fixer attempt needs evidence of real work, not just a new ID. */
export function sourceRunAlreadyHandled(candidate, run, evidence = run) {
  const deferredAttempt = Number(candidate?.deferred?.sourceAttempt);
  const runAttempt = Number(run?.attempt);
  const hasDeferredAttempt = Number.isSafeInteger(deferredAttempt) && deferredAttempt > 0;
  const autonomousAttempt = Number.isSafeInteger(runAttempt)
    && runAttempt > 0
    && (hasDeferredAttempt ? runAttempt > deferredAttempt : runAttempt > 1);
  if (candidate?.deferred?.version !== 2) return autonomousAttempt;
  if (!autonomousAttempt) return false;
  return evidence?.verified === true && evidence?.consumed === true;
}

const REDFLAG_FIX_STEP_NAME = 'Run Codex Luna Max 🔴-fix';

/** Pure evidence classifier for an advanced fixer attempt. */
export function fixerAttemptEvidence({ role, runId, prNumber, head, comments = [], jobs } = {}) {
  const normalizedRole = String(role || '');
  const normalizedHead = String(head || '').toLowerCase();
  const normalizedPr = String(prNumber || '');
  if (!['redflag', 'redcheck'].includes(normalizedRole)
      || !/^\d+$/.test(String(runId || ''))
      || !PR_HEAD_RE.test(normalizedHead)
      || !/^\d+$/.test(normalizedPr)) {
    return { verified: false, consumed: false, reason: 'fixer-evidence-context-invalid' };
  }
  if (normalizedRole === 'redcheck') {
    if (!Array.isArray(comments) || comments.some((comment) => !comment || typeof comment !== 'object')) {
      return { verified: false, consumed: false, reason: 'redcheck-claims-unreadable' };
    }
    const terminal = latestRedcheckFixClaims(comments).some((claim) => (
      String(claim.prNumber) === normalizedPr
      && String(claim.headSha).toLowerCase() === normalizedHead
      && String(claim.runId) === String(runId)
      && ['completed', 'failed-terminal'].includes(String(claim.state))
    ));
    return { verified: true, consumed: terminal, reason: terminal ? 'redcheck-claim-terminal' : 'redcheck-claim-not-terminal' };
  }
  if (!Array.isArray(jobs) || jobs.some((job) => !job || typeof job !== 'object' || !Array.isArray(job.steps))) {
    return { verified: false, consumed: false, reason: 'redflag-jobs-unreadable' };
  }
  const step = jobs.flatMap((job) => job.steps)
    .find((item) => item && item.name === REDFLAG_FIX_STEP_NAME);
  if (!step) return { verified: true, consumed: false, reason: 'redflag-fix-step-not-started' };
  const started = typeof step.startedAt === 'string' && step.startedAt.length > 0;
  const skipped = String(step.conclusion || '').toLowerCase() === 'skipped';
  return {
    verified: true,
    consumed: started && !skipped,
    reason: started && !skipped ? 'redflag-fix-step-started' : 'redflag-fix-step-skipped',
  };
}

function sourceRunEvidence(candidate, run) {
  if (candidate?.deferred?.version !== 2) return { verified: true, consumed: true };
  const role = String(candidate.deferred.role || '');
  if (role === 'redcheck') {
    return fixerAttemptEvidence({
      role,
      runId: run?.databaseId,
      prNumber: candidate?.pr?.number,
      head: candidate?.head,
      comments: candidate?.comments,
    });
  }
  const raw = gh([
    'run', 'view', String(run?.databaseId || ''), '--repo', REPO,
    '--json', 'jobs',
  ], { allowFail: true });
  const payload = parseJson(raw, null);
  return fixerAttemptEvidence({
    role,
    runId: run?.databaseId,
    prNumber: candidate?.pr?.number,
    head: candidate?.head,
    jobs: payload?.jobs,
  });
}

export function currentTargetProof(candidate) {
  if (candidate?.deferred?.version !== 2) return { verified: true, obsolete: false };
  const number = String(candidate?.pr?.number || '');
  const raw = gh(['api', `repos/${REPO}/pulls/${number}`], { allowFail: true });
  const pr = parseJson(raw, null);
  if (!pr || String(pr.number || '') !== number
      || !pr.head || typeof pr.head.sha !== 'string' || !PR_HEAD_RE.test(pr.head.sha)
      || !['open', 'closed'].includes(String(pr.state || '').toLowerCase())) return null;
  const headMatches = pr.head.sha.toLowerCase() === String(candidate.head || '').toLowerCase();
  if (!headMatches) return null;
  return {
    verified: true,
    obsolete: String(pr.state).toLowerCase() !== 'open',
  };
}

function releaseLease(prNumber, role, token, runId, owner = 'review-quota-rescuer') {
  if (!token || DRY_RUN) return;
  runQuotaLease({
    action: 'release',
    role,
    owner,
    targetType: 'pr',
    target: String(prNumber),
    token,
    runId,
    writeOutput: false,
    dryRun: DRY_RUN,
  });
}

function postRetryComment(number, body) {
  if (DRY_RUN) {
    console.log(`[dry] PR #${number}: non pubblicherei il marker retry.`);
    return false;
  }
  try {
    gh(['pr', 'comment', String(number), '--repo', REPO, '--body', body]);
    return true;
  } catch (error) {
    console.log(`::warning::commento retry review fallito su #${number}: ${String(error?.message || error).slice(0, 180)}`);
    return false;
  }
}

function postTransientRetryComment(number, body) {
  if (DRY_RUN) {
    console.log(`[dry] PR #${number}: non pubblicherei il marker transient review.`);
    return false;
  }
  try {
    gh(['pr', 'comment', String(number), '--repo', REPO, '--body', body]);
    return true;
  } catch (error) {
    console.log(`::warning::commento transient review fallito su #${number}: ${String(error?.message || error).slice(0, 180)}`);
    return false;
  }
}

function transientRetryFields(candidate, run, { state = 'confirmed' } = {}) {
  const previousIssuedAt = Number(candidate.retry?.issuedAt) || 0;
  const issuedAt = state === 'requested' && candidate.retry?.state !== 'requested'
    ? Math.floor(Date.now() / 1000)
    : previousIssuedAt || Math.floor(Date.now() / 1000);
  return {
    head: candidate.claim.headSha,
    reviewRevision: candidate.claim.reviewRevision,
    claimToken: candidate.claim.token,
    sourceRunId: String(run?.databaseId || candidate.claim.runId),
    sourceAttempt: Number(run?.attempt || 1),
    runId: process.env.GITHUB_RUN_ID || 'review-transient-rescuer',
    retryCount: candidate.retryCount,
    state,
    issuedAt,
  };
}

function transientRetryAgeMs(candidate) {
  const retry = candidate.retry;
  if (!retry) return null;
  const issuedAt = Number(retry.issuedAt) || 0;
  return issuedAt > 0 ? Math.max(0, Date.now() - issuedAt * 1000) : null;
}

function terminalRetryStateForRun(run) {
  if (String(run?.status || '').toLowerCase() !== 'completed') return null;
  return String(run?.conclusion || '').toLowerCase() === 'success' ? 'confirmed' : 'failed';
}

/** Classify a newer rerun only after its terminal outcome is known. Pure. */
export function retryStateForObservedAttempt({
  currentAttempt,
  requestedAttempt,
  status,
  conclusion,
} = {}) {
  const observed = Number(currentAttempt);
  const requested = Number(requestedAttempt);
  if (!Number.isSafeInteger(observed) || observed < 1
      || !Number.isSafeInteger(requested) || requested < 1
      || observed <= requested) return null;
  return terminalRetryStateForRun({ status, conclusion });
}

/** Backward-compatible pure classifier for transient retry consumers. */
export function transientRetryStateForRun(run) {
  return terminalRetryStateForRun(run);
}

/** Reconcile a requested transient rerun without issuing a duplicate. */
function reconcileTransientRetry(candidate, number) {
  const requested = candidate.retry;
  if (!requested || requested.state !== 'requested') return true;
  const run = sourceRunForTransientClaim(candidate.claim, candidate.claim.headSha, { completedOnly: false });
  if (!run) {
    console.log(`PR #${number}: marker transient requested sulla HEAD ${candidate.claim.headSha.slice(0, 12)}, stato rerun non verificabile.`);
    return true;
  }
  const state = retryStateForObservedAttempt({
    currentAttempt: run.attempt,
    requestedAttempt: requested.sourceAttempt,
    status: run.status,
    conclusion: run.conclusion,
  });
  if (run.attempt > requested.sourceAttempt) {
    if (!state) {
      console.log(`PR #${number}: transient rerun già osservato (attempt ${run.attempt}, stato ${run.status}); fence conservato finché termina.`);
      return true;
    }
    const body = reviewTransientRetryBody({
      ...transientRetryFields(candidate, run, { state }),
      state,
    });
    if (postTransientRetryComment(number, body)) {
      console.log(`PR #${number}: transient rerun riconciliato come ${state}, attempt ${run.attempt}.`);
    }
    return true;
  }
  if (run.status !== 'completed') {
    console.log(`PR #${number}: transient rerun ancora in corso (attempt ${run.attempt}, stato ${run.status}).`);
    return true;
  }
  const ageMs = transientRetryAgeMs(candidate);
  const graceMs = REVIEW_QUOTA_REQUEST_GRACE_SEC * 1000;
  if (ageMs === null || ageMs < graceMs) {
    console.log(`PR #${number}: marker transient requested recente senza attempt nuovo — fence conservato.`);
    return true;
  }
  const body = reviewTransientRetryBody({
    ...transientRetryFields(candidate, run, { state: 'failed' }),
    state: 'failed',
  });
  if (postTransientRetryComment(number, body)) {
    console.log(`PR #${number}: transient rerun non osservato dopo la grace period; nessun duplicato richiesto.`);
  }
  return true;
}

export function collectReviewQuotaCandidates(prs, commentsByPr = new Map()) {
  return (prs || []).flatMap((pr) => {
    const head = String(pr?.head?.sha || '');
    const comments = commentsByPr.get(Number(pr?.number)) || [];
    return pendingReviewQuotaDeferredEntries({ head, comments, includeRequested: true })
      .filter(({ deferred }) => deferred.version !== 2
        || String(deferred.prNumber || '') === String(pr?.number || ''))
      .map(({ deferred, retry }) => ({ pr, head, deferred, retry, comments }));
  }).sort((a, b) => {
    const at = Date.parse(a.deferred.createdAt || '') || 0;
    const bt = Date.parse(b.deferred.createdAt || '') || 0;
    return at - bt
      || Number(a.pr.number) - Number(b.pr.number)
      || String(a.deferred.role).localeCompare(String(b.deferred.role))
      || String(a.deferred.runId).localeCompare(String(b.deferred.runId));
  });
}

/**
 * Find one failed-transient review claim eligible for a bounded rerun. The
 * caller supplies the body revision from the trusted PR API; stale claims are
 * deliberately ignored.
 */
export function collectReviewTransientCandidates(
  prs,
  commentsByPr = new Map(),
  reviewRevisionByPr = new Map(),
  options = {},
) {
  const maxRetries = positiveInt(options.maxRetries, MAX_TRANSIENT_RETRIES);
  return (prs || []).flatMap((pr) => {
    const number = Number(pr?.number);
    const head = String(pr?.head?.sha || '').toLowerCase();
    const reviewRevision = reviewRevisionByPr.get(number) || '';
    const comments = commentsByPr.get(number) || [];
    const candidate = pendingReviewTransientClaim({
      head,
      reviewRevision,
      comments,
      maxRetries,
    });
    return candidate ? [{ pr, head, reviewRevision, comments, ...candidate }] : [];
  }).sort((a, b) => (
    Number(a.claim.commentAt || a.claim.issuedAt) - Number(b.claim.commentAt || b.claim.issuedAt)
      || Number(a.pr.number) - Number(b.pr.number)
  ));
}

function rescueTransientReview(candidate) {
  const number = Number(candidate.pr.number);
  if (candidate.retry?.state === 'requested') {
    if (DRY_RUN) {
      console.log(`[dry] PR #${number}: riconciliazione transient review richiesta saltata.`);
    } else {
      reconcileTransientRetry(candidate, number);
    }
    return false;
  }

  const run = sourceRunForTransientClaim(candidate.claim, candidate.head);
  if (!run) {
    console.log(`PR #${number}: claim failed-transient sulla HEAD ${candidate.head.slice(0, 12)}, run tests non verificabile/completata.`);
    return false;
  }
  // `run.attempt` alone is not a fence: GitHub keeps the same run ID across
  // manual/automatic reruns, and an attempt 2+ can itself have produced the
  // failed-transient claim we are rescuing.  The durable `requested` marker
  // below is the only proof that this rescuer already asked for a rerun; the
  // candidate collector has already excluded that marker from this branch.

  let posted = false;
  try {
    posted = reviewWasPosted(REPO, number, candidate.head, candidate.reviewRevision);
  } catch (error) {
    console.log(`::warning::PR #${number}: Reviews API non verificabile per transient recovery — nessuna azione (${String(error?.message || error).slice(0, 180)}).`);
    return false;
  }
  if (posted) {
    console.log(`PR #${number}: claim failed-transient ma review corrente osservabile; nessun rerun.`);
    return false;
  }

  const owner = 'review-transient-rescuer';
  const lease = runQuotaLease({
    action: 'reserve',
    role: 'review',
    owner,
    targetType: 'pr',
    target: String(number),
    ttlSec: positiveInt(process.env.REVIEW_QUOTA_LEASE_TTL_SEC, 60 * 60),
    scanMax: positiveInt(process.env.QUOTA_LEASE_SCAN_MAX, 20),
    runId: process.env.GITHUB_RUN_ID || owner,
    headSha: candidate.head,
    reservationRunId: run.databaseId,
    writeOutput: false,
    dryRun: DRY_RUN,
    emitReviewDeferredMarker: false,
  });
  if (!lease.allowed) {
    console.log(`PR #${number}: transient recovery lease non disponibile (${lease.reason || 'unknown'}) — defer al prossimo tick.`);
    return false;
  }
  if (DRY_RUN) {
    console.log(`[dry] PR #${number}: rilancerei tests #${run.databaseId} per claim failed-transient sulla HEAD ${candidate.head.slice(0, 12)}.`);
    return false;
  }

  const retryFields = transientRetryFields(candidate, run, { state: 'requested' });
  const requestedBody = reviewTransientRetryBody(retryFields);
  if (!postTransientRetryComment(number, requestedBody)) {
    releaseLease(number, 'review', lease.token, retryFields.runId, owner);
    console.log(`::warning::PR #${number}: marker transient non verificabile → rerun non richiesto.`);
    return false;
  }

  try {
    gh(['run', 'rerun', String(run.databaseId), '--repo', REPO]);
  } catch (error) {
    console.log(`::warning::rerun tests #${run.databaseId} fallito per PR #${number}: ${String(error?.message || error).slice(0, 180)}`);
    const failedBody = reviewTransientRetryBody({ ...retryFields, state: 'failed' });
    if (!postTransientRetryComment(number, failedBody)) {
      console.log(`::warning::PR #${number}: marker transient failed non pubblicabile; requested resta fence anti-duplicato.`);
    }
    releaseLease(number, 'review', lease.token, retryFields.runId, owner);
    return false;
  }

  // The rerun command only acknowledges the request; GitHub may queue, reject,
  // or never start it after this process exits.  Keep `requested` durable until
  // a later tick observes a strictly newer attempt in reconcileTransientRetry().
  // Publishing `confirmed` here would make an unstarted rerun look consumed and
  // permanently strand the failed-transient claim.
  console.log(`PR #${number}: tests #${run.databaseId} richiesto una volta per claim failed-transient sulla HEAD ${candidate.head.slice(0, 12)}; attendo un attempt nuovo osservabile.`);
  return true;
}

function retryFieldsForCandidate(candidate, run, { preserveRetry = false } = {}) {
  const retry = preserveRetry ? candidate.retry?.event : null;
  return {
    head: candidate.head,
    role: candidate.deferred.role,
    deferredRunId: candidate.deferred.runId,
    sourceRunId: retry?.sourceRunId || run?.databaseId,
    sourceAttempt: retry?.sourceAttempt ?? run?.attempt,
    runId: retry?.runId || process.env.GITHUB_RUN_ID || 'review-quota-rescuer',
  };
}

function retryCommentAgeMs(retry) {
  const createdAtMs = Number(retry?.rank?.[0]) || 0;
  return createdAtMs > 0 ? Math.max(0, Date.now() - createdAtMs) : null;
}

function closeAlreadyHandledDeferral(candidate, run, number) {
  const body = reviewQuotaRetryBody({
    ...retryFieldsForCandidate(candidate, run),
    sourceAttempt: run.attempt,
    state: 'confirmed',
  });
  if (postRetryComment(number, body)) {
    console.log(
      `PR #${number}: deferral ${candidate.deferred.role} chiusa senza quota; `
      + `run sorgente già avanzata (attempt ${run.attempt}).`,
    );
    return true;
  }
  console.log(
    `::warning::PR #${number}: run sorgente già gestita (attempt ${run.attempt}), `
    + 'ma il marker confirmed non è pubblicabile; nessun rerun viene richiesto.',
  );
  return false;
}

function reconcileRequestedRetry(candidate, number) {
  const requested = candidate.retry?.event;
  const requestedAttempt = Number(requested?.sourceAttempt);
  if (!requested || requested.state !== 'requested') {
    return true;
  }

  const run = sourceRunForCandidate(candidate, { completedOnly: false });
  if (!run || !Number.isSafeInteger(run.attempt) || run.attempt < 1) {
    console.log(`PR #${number}: marker requested ${candidate.deferred.role} sulla HEAD ${candidate.head.slice(0, 12)}, stato rerun non verificabile.`);
    return true;
  }

  const fields = retryFieldsForCandidate(candidate, run, { preserveRetry: true });
  const hasRequestedAttempt = Number.isSafeInteger(requestedAttempt) && requestedAttempt > 0;
  const ageMs = retryCommentAgeMs(candidate.retry);
  const graceMs = REVIEW_QUOTA_REQUEST_GRACE_SEC * 1000;
  if (!hasRequestedAttempt) {
    if (run.status !== 'completed' || ageMs === null || ageMs < graceMs) {
      console.log(`PR #${number}: marker requested legacy senza sourceAttempt — fence conservato finché il rerun non è osservabile.`);
      return true;
    }
    const legacyState = run.attempt > 1 && run.conclusion === 'success' ? 'confirmed' : 'failed';
    const legacyBody = reviewQuotaRetryBody({
      ...fields,
      sourceAttempt: run.attempt,
      state: legacyState,
    });
    if (postRetryComment(number, legacyBody)) {
      console.log(`PR #${number}: marker requested legacy riconciliato come ${legacyState} sull'attempt ${run.attempt}.`);
    } else {
      console.log(`::warning::PR #${number}: marker requested legacy non riconciliabile; il prossimo tick riprova.`);
    }
    return true;
  }

  let observedState = retryStateForObservedAttempt({
    currentAttempt: run.attempt,
    requestedAttempt,
    status: run.status,
    conclusion: run.conclusion,
  });
  if (candidate.deferred.version === 2 && run.attempt > requestedAttempt) {
    const evidence = sourceRunEvidence(candidate, run);
    if (!evidence.verified) {
      console.log(`PR #${number}: attempt fixer avanzato ma prova di consumo non verificabile (${evidence.reason}); fence requested conservato.`);
      return true;
    }
    if (evidence.consumed) {
      // A real model step / terminal same-owner claim proves that the retry was
      // accepted. The run may still be in progress for redflag; do not wait for
      // a terminal conclusion to avoid a duplicate dispatch.
      observedState = 'confirmed';
    } else if (run.status === 'completed') {
      // A completed no-op (lease skip, capability guard, or redcheck claim not
      // finalized) did not consume a fixer attempt. Reopen the deferral so the
      // next bounded tick can retry it.
      observedState = 'failed';
    } else {
      console.log(`PR #${number}: attempt fixer avanzato ma il passo di fix non è ancora terminale; fence requested conservato.`);
      return true;
    }
  }
  if (observedState) {
    const observedBody = reviewQuotaRetryBody({
      ...fields,
      sourceAttempt: run.attempt,
      state: observedState,
    });
    if (postRetryComment(number, observedBody)) {
      console.log(`PR #${number}: marker requested riconciliato come ${observedState}, attempt ${run.attempt}.`);
    } else {
      console.log(`::warning::PR #${number}: rerun terminale osservato (attempt ${run.attempt}), ma marker ${observedState} non pubblicato.`);
    }
    return true;
  }

  if (run.attempt > requestedAttempt) {
    console.log(`PR #${number}: rerun già osservato ma ancora non terminale (attempt ${run.attempt}, stato ${run.status}); fence requested conservato.`);
    return true;
  }

  if (run.status !== 'completed') {
    console.log(`PR #${number}: marker requested ancora in attesa (stato ${run.status}, attempt ${run.attempt}).`);
    return true;
  }

  if (ageMs === null || ageMs < graceMs) {
    console.log(`PR #${number}: marker requested recente senza attempt nuovo — fence conservato ancora per ${ageMs === null ? 'timestamp non verificabile' : 'grace period'}.`);
    return true;
  }

  const failedBody = reviewQuotaRetryBody({ ...fields, sourceAttempt: requestedAttempt, state: 'failed' });
  if (postRetryComment(number, failedBody)) {
    console.log(`PR #${number}: marker requested scaduto senza rerun osservabile — deferral riaperta.`);
  } else {
    console.log(`::warning::PR #${number}: marker requested scaduto ma failed non pubblicabile; il prossimo tick riprova la riconciliazione.`);
  }
  return true;
}

function main() {
  if (!REPO) {
    throw new Error('repository mancante: scansione non verificabile');
  }

  const prs = listOpenPullRequests();
  const commentsByPr = new Map();
  for (const pr of prs) commentsByPr.set(Number(pr.number), commentsForPr(pr.number));
  const candidates = collectReviewQuotaCandidates(prs, commentsByPr);
  const reviewRevisionByPr = new Map();
  for (const pr of prs) {
    const number = Number(pr.number);
    const head = String(pr?.head?.sha || '').toLowerCase();
    const comments = commentsByPr.get(number) || [];
    const hasTransientClaim = latestReviewClaims(comments)
      .some((claim) => claim.state === 'failed-transient' && claim.headSha === head);
    if (hasTransientClaim) reviewRevisionByPr.set(number, currentReviewRevision(number));
  }
  const transientCandidates = collectReviewTransientCandidates(prs, commentsByPr, reviewRevisionByPr);
  console.log(
    `review-quota-rescuer: PR osservate=${prs.length}, quota-candidate=${candidates.length}, `
    + `transient-candidate=${transientCandidates.length}, max retry=${MAX_RETRIES}, `
    + `max transient retry=${MAX_TRANSIENT_RETRIES}`,
  );

  let retried = 0;
  for (const candidate of candidates) {
    if (retried >= MAX_RETRIES) break;
    const number = Number(candidate.pr.number);
    const targetProof = currentTargetProof(candidate);
    if (!targetProof) {
      console.log(`PR #${number}: target/provenance non verificabile — nessuna riconciliazione o mutazione.`);
      continue;
    }
    if (targetProof.obsolete) {
      console.log(`PR #${number}: deferral sulla HEAD corrente ma PR non più aperta — nessun rerun.`);
      continue;
    }
    if (candidate.retry?.event?.state === 'requested') {
      if (DRY_RUN) {
        console.log(`[dry] PR #${number}: riconciliazione del marker requested saltata.`);
      } else {
        reconcileRequestedRetry(candidate, number);
      }
      continue;
    }

    const run = sourceRunForCandidate(candidate);
    if (!run) {
      console.log(`PR #${number}: deferral ${candidate.deferred.role} sulla HEAD ${candidate.head.slice(0, 12)}, run sorgente non verificabile/completata.`);
      continue;
    }

    const runAdvanced = candidate.deferred.version === 2
      && Number.isSafeInteger(Number(candidate.deferred.sourceAttempt))
      && run.attempt > Number(candidate.deferred.sourceAttempt);
    const evidence = runAdvanced ? sourceRunEvidence(candidate, run) : null;
    if (runAdvanced && !evidence?.verified) {
      console.log(`PR #${number}: attempt fixer avanzato senza prova di consumo verificabile (${evidence?.reason || 'unknown'}); nessun rerun o marker.`);
      continue;
    }

    if (sourceRunAlreadyHandled(candidate, run, evidence || run)) {
      if (DRY_RUN) {
        console.log(
          `[dry] PR #${number}: non rilancerei ${candidate.deferred.role} `
          + `#${run.databaseId}; run sorgente già gestita (attempt ${run.attempt}).`,
        );
      } else {
        closeAlreadyHandledDeferral(candidate, run, number);
      }
      continue;
    }

    const lease = runQuotaLease({
      action: 'reserve',
      role: candidate.deferred.role,
      owner: 'review-quota-rescuer',
      targetType: 'pr',
      target: String(number),
      ttlSec: positiveInt(process.env.REVIEW_QUOTA_LEASE_TTL_SEC, 60 * 60),
      scanMax: positiveInt(process.env.QUOTA_LEASE_SCAN_MAX, 20),
      runId: process.env.GITHUB_RUN_ID || 'review-quota-rescuer',
      headSha: candidate.head,
      reservationRunId: run.databaseId,
      writeOutput: false,
      dryRun: DRY_RUN,
      emitReviewDeferredMarker: false,
    });
    if (!lease.allowed) {
      console.log(`PR #${number}: lease non disponibile (${lease.reason || 'unknown'}) — defer al prossimo evento.`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`[dry] PR #${number}: rilancerei ${candidate.deferred.role} #${run.databaseId} sulla HEAD ${candidate.head.slice(0, 12)}.`);
      continue;
    }

    const retryFields = retryFieldsForCandidate(candidate, run);

    // Due operazioni remote non possono essere atomiche. Il marker `requested`
    // è quindi un fence durevole scritto PRIMA del rerun: se la conferma dopo
    // il rerun fallisce, il fence impedisce un doppio Claude; se il rerun fallisce
    // possiamo appendere `failed` e rendere la deferral nuovamente eleggibile.
    const requestedBody = reviewQuotaRetryBody({ ...retryFields, state: 'requested' });
    if (!postRetryComment(number, requestedBody)) {
      releaseLease(number, candidate.deferred.role, lease.token, retryFields.runId);
      console.log(`::warning::PR #${number}: marker retry non verificabile → rerun non richiesto, nessun retry contabilizzato.`);
      continue;
    }

    let rerunRequested = false;
    try {
      gh(['run', 'rerun', String(run.databaseId), '--repo', REPO]);
      rerunRequested = true;
    } catch (error) {
      console.log(`::warning::rerun ${candidate.deferred.role} #${run.databaseId} fallito per PR #${number}: ${String(error?.message || error).slice(0, 180)}`);
      const failedBody = reviewQuotaRetryBody({ ...retryFields, state: 'failed' });
      if (!postRetryComment(number, failedBody)) {
        console.log(`::warning::PR #${number}: impossibile riconciliare il marker failed; il marker requested resta come fence anti-duplicato.`);
      }
      releaseLease(number, candidate.deferred.role, lease.token, retryFields.runId);
    }
    if (!rerunRequested) continue;

    // `requested` resta il fence finché il prossimo tick non osserva un attempt
    // nuovo e pubblica `confirmed` in `reconcileRequestedRetry`.
    console.log(`PR #${number}: ${candidate.deferred.role} #${run.databaseId} richiesto sulla HEAD ${candidate.head.slice(0, 12)}; attendo un attempt nuovo osservabile.`);
    retried += 1;
  }
  let transientRetried = 0;
  for (const candidate of transientCandidates) {
    if (transientRetried >= MAX_TRANSIENT_RETRIES) break;
    if (rescueTransientReview(candidate)) transientRetried += 1;
  }
  console.log(`review-quota-rescuer: retry quota richiesti=${retried}, transient richiesti=${transientRetried}.`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    // Un rescuer rotto non deve colorare il check del repo né modificare il
    // routing: il cron successivo riprova e il marker resta osservabile. Il
    // fallimento resta però non-zero: un check verde qui maschererebbe una
    // scansione mai verificata e trasformerebbe un errore API in «coda vuota».
    console.error(`review-quota-rescuer: probe fallita (nessuna azione, retry al prossimo tick): ${String(error?.message || error).slice(0, 240)}`);
    process.exitCode = 1;
  }
}
