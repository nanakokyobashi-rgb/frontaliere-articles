#!/usr/bin/env node

/**
 * Durable, zero-Claude admission for the corpus review consumer.
 *
 * The PR thread is the durable store already available to the workflow. Each
 * event is recorded with PR + HEAD + event + contribution fingerprint; the
 * stable PR + HEAD + fingerprint identity coalesces retries of one review.
 * A trusted PR-body SHA is an optional review revision: it lets a corrected
 * body receive a fresh verdict without making an unchanged rerun duplicate
 * Claude work. Claims are append-only: the latest event for a token is its
 * state.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { reviewHasInputRevision } from './review-test-policy.mjs';

export const REVIEW_CLAIM_MARKER = '<!-- PR_REVIEW_CLAIM:';
export const REVIEW_CLAIM_STATES = Object.freeze([
  'active',
  'completed',
  'failed-terminal',
  'failed-transient',
  'released',
]);

const CLAIM_STATE_SET = new Set(REVIEW_CLAIM_STATES);
const CLAIM_MARKER_RE = /<!-- PR_REVIEW_CLAIM:\s*(\{[\s\S]*?\})\s*-->/;
const CLAIM_ACTOR_RE = /^(?:github-actions\[bot\]|frontaliere-automation(?:\[bot\])?|claude(?:\[bot\])?|nanakokyobashi-rgb|valerielinc-ops)$/iu;
const SHA_RE = /^[0-9a-f]{40}$/iu;
const PR_RE = /^[1-9][0-9]*$/u;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/iu;
const REVIEW_REVISION_RE = /^body:[0-9a-f]{64}$/iu;

function normalized(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

/**
 * A body edit is a new review input even when the code contribution and HEAD
 * are unchanged. Keep the revision deliberately narrow: only a SHA-256 of the
 * trusted PR body is accepted, so arbitrary caller input cannot create an
 * unbounded claim namespace.
 */
function normalizedReviewRevision(value) {
  const raw = normalized(value);
  if (!raw) return '';
  return REVIEW_REVISION_RE.test(raw) ? raw.toLowerCase() : null;
}

function validContext({ prNumber, headSha, eventKey, contributionFingerprint } = {}) {
  return PR_RE.test(String(prNumber || ''))
    && SHA_RE.test(String(headSha || ''))
    && FINGERPRINT_RE.test(String(contributionFingerprint || ''))
    && normalized(eventKey) !== '';
}

function revisionSuffix(reviewRevision) {
  const revision = normalizedReviewRevision(reviewRevision);
  if (revision === null) return null;
  return revision ? `|revision:${revision}` : '';
}

/** Exact identity retained in the comment ledger for audit and finalization. */
export function reviewClaimKey({ prNumber, headSha, eventKey, contributionFingerprint, reviewRevision } = {}) {
  const suffix = revisionSuffix(reviewRevision);
  if (suffix === null || !validContext({ prNumber, headSha, eventKey, contributionFingerprint })) return '';
  return [
    `pr:${String(prNumber)}`,
    `head:${String(headSha).toLowerCase()}`,
    `event:${normalized(eventKey)}`,
    `contribution:${String(contributionFingerprint).toLowerCase()}`,
  ].join('|') + suffix;
}

/** Stable identity that deliberately excludes a rerun's event id. */
export function reviewClaimDedupeKey({ prNumber, headSha, eventKey, contributionFingerprint, reviewRevision } = {}) {
  const suffix = revisionSuffix(reviewRevision);
  if (suffix === null || !validContext({ prNumber, headSha, eventKey, contributionFingerprint })) return '';
  return [
    `pr:${String(prNumber)}`,
    `head:${String(headSha).toLowerCase()}`,
    `contribution:${String(contributionFingerprint).toLowerCase()}`,
  ].join('|') + suffix;
}

function keyFromClaim(event) {
  return reviewClaimKey({
    prNumber: event?.prNumber,
    headSha: event?.headSha,
    eventKey: event?.eventKey,
    contributionFingerprint: event?.contributionFingerprint,
    reviewRevision: event?.reviewRevision,
  });
}

function dedupeKeyFromClaim(event) {
  return reviewClaimDedupeKey({
    prNumber: event?.prNumber,
    headSha: event?.headSha,
    eventKey: event?.eventKey,
    contributionFingerprint: event?.contributionFingerprint,
    reviewRevision: event?.reviewRevision,
  });
}

/** Strict parser for one persisted marker. Invalid markers are never trusted. */
export function parseReviewClaim(body) {
  const match = String(body || '').match(CLAIM_MARKER_RE);
  if (!match) return null;
  let event;
  try {
    event = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!event || event.version !== 1
      || typeof event.token !== 'string' || !event.token
      || !PR_RE.test(String(event.prNumber || ''))
      || !SHA_RE.test(String(event.headSha || ''))
      || !FINGERPRINT_RE.test(String(event.contributionFingerprint || ''))
      || typeof event.eventKey !== 'string' || !normalized(event.eventKey)
      || !CLAIM_STATE_SET.has(event.state)
      || typeof event.runId !== 'string' || !event.runId
      || !Number.isFinite(Number(event.issuedAt))
      || !Number.isFinite(Number(event.expiresAt))) return null;

  const reviewRevision = normalizedReviewRevision(event.reviewRevision);
  if (reviewRevision === null) return null;

  const normalizedEvent = {
    ...event,
    prNumber: String(event.prNumber),
    headSha: String(event.headSha).toLowerCase(),
    eventKey: normalized(event.eventKey),
    contributionFingerprint: String(event.contributionFingerprint).toLowerCase(),
    issuedAt: Number(event.issuedAt),
    expiresAt: Number(event.expiresAt),
  };
  if (reviewRevision) normalizedEvent.reviewRevision = reviewRevision;
  if (normalizedEvent.key !== keyFromClaim(normalizedEvent)
      || normalizedEvent.dedupeKey !== dedupeKeyFromClaim(normalizedEvent)) return null;
  return normalizedEvent;
}

function eventRank(event) {
  return [
    Number(event?.commentAt) || 0,
    Number(event?.commentId) || 0,
    Number(event?.commentOrder) || 0,
  ];
}

function laterEvent(a, b) {
  const left = eventRank(a);
  const right = eventRank(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? a : b;
  }
  return b;
}

/** Latest event for each token, optionally restricted to one identity. */
export function latestReviewClaims(comments = [], { key = '', dedupeKey = '' } = {}) {
  const latest = new Map();
  for (const [index, comment] of (comments || []).entries()) {
    const login = String(comment?.user?.login || comment?.author?.login || '');
    if (login && !CLAIM_ACTOR_RE.test(login)) continue;
    const event = parseReviewClaim(comment?.body);
    if (!event || (key && event.key !== key) || (dedupeKey && event.dedupeKey !== dedupeKey)) continue;
    const createdAt = Date.parse(comment?.created_at ?? comment?.createdAt ?? '');
    const candidate = {
      ...event,
      commentId: Number(comment?.id) || index,
      commentAt: Number.isFinite(createdAt) ? Math.floor(createdAt / 1000) : event.issuedAt,
      commentOrder: index,
    };
    const previous = latest.get(event.token);
    latest.set(event.token, previous ? laterEvent(previous, candidate) : candidate);
  }
  return [...latest.values()];
}

function runIsFinished(state) {
  if (!state || typeof state !== 'object') return false;
  // A successful runner may have posted its verdict but not yet finalized the
  // claim because the comments API was eventually consistent. Releasing that
  // claim merely because the runner is completed would permit a duplicate.
  // Only outcomes that prove an interrupted/unsuccessful attempt are
  // retryable; an unreadable or successful state remains fail-closed until TTL.
  return ['cancelled', 'failure', 'timed_out', 'action_required', 'skipped'].includes(state.conclusion);
}

/**
 * Pure admission policy. An active claim is retryable only after expiry or a
 * finished runner; an unreadable runner is an error, never a Claude permit.
 */
export function reviewClaimDecision({ key, dedupeKey, claims = [], nowSec = Math.floor(Date.now() / 1000), activeRunStates = {} } = {}) {
  if (!key || !dedupeKey) return { allowed: false, error: true, reason: 'claim-key-missing' };
  const related = (claims || []).filter((claim) => claim?.dedupeKey === dedupeKey);
  if (related.some((claim) => claim.state === 'completed' || claim.state === 'failed-terminal')) {
    return { allowed: false, exists: true, reason: 'same-pr-head-terminal-claim' };
  }
  for (const claim of related.filter((item) => item.state === 'active')) {
    if (Number(claim.expiresAt) <= Number(nowSec)) continue;
    const runId = String(claim.runId || '');
    const state = runId ? activeRunStates?.[runId] : undefined;
    if (!state) return { allowed: false, exists: true, error: true, reason: 'active-run-state-unreadable' };
    if (!runIsFinished(state)) {
      return { allowed: false, exists: true, reason: 'same-pr-head-claim-active' };
    }
  }
  return { allowed: true, exists: related.length > 0, reason: 'same-pr-head-claim-retryable' };
}

/** Map the workflow's outcome to a durable state without weakening the gate. */
export function claimStatusFromOutcome({
  proceed,
  claudeOutcome = '',
  executionText = '',
  retryableFailure = false,
  permanentFailure = false,
  reviewPosted = false,
} = {}) {
  if (proceed !== true && proceed !== 'true') return 'released';
  if (permanentFailure === true || permanentFailure === 'true') return 'failed-terminal';
  if (reviewPosted === true || reviewPosted === 'true') return 'completed';
  const text = String(executionText || '');
  const transient = /(?:api_error_status|status_code|http_status|status)"?\s*:\s*"?429\b|\bHTTP\s*429\b|\b(?:overloaded|server_error|internal server error)\b|rate_limit_event|rate_limit_error/iu.test(text);
  if (retryableFailure === true || retryableFailure === 'true'
      || transient || claudeOutcome === 'cancelled'
      || claudeOutcome === '' || claudeOutcome === 'skipped') return 'failed-transient';
  if (claudeOutcome === 'failure') return 'failed-terminal';
  return 'completed';
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readComments(repo, prNumber) {
  const raw = gh([
    'api', '--paginate', '--slurp', `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
  ]);
  let pages;
  try {
    pages = JSON.parse(raw);
  } catch (error) {
    throw new Error(`commenti PR: JSON non valido (${error.message})`);
  }
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    throw new Error('commenti PR: risposta non e\' un array di pagine');
  }
  const comments = pages.flat();
  for (const comment of comments) {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
      throw new Error('commenti PR: pagina malformata');
    }
    if (String(comment.body || '').includes(REVIEW_CLAIM_MARKER)) {
      const login = String(comment.user?.login || comment.author?.login || '');
      if (!CLAIM_ACTOR_RE.test(login) || !parseReviewClaim(comment.body)) {
        throw new Error('commenti PR: marker review claim non verificabile');
      }
    }
  }
  return comments;
}

export function reviewWasPosted(repo, prNumber, headSha, reviewRevision = '', ghFn = gh) {
  const raw = ghFn([
    'api', '--paginate', '--slurp', `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`,
  ]);
  let pages;
  try {
    pages = JSON.parse(raw);
  } catch (error) {
    throw new Error(`review PR: JSON non valido (${error.message})`);
  }
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    throw new Error('review PR: risposta non e\' un array di pagine');
  }
  return pages.flat().some((review) => review
    && typeof review === 'object'
    && review.state !== 'PENDING'
    && review.commit_id === headSha
    && review.user?.type === 'Bot'
    && reviewHasInputRevision(review.body, reviewRevision)
    && (CLAIM_ACTOR_RE.test(String(review.user?.login || ''))
      || (/^github-actions\[bot\]$/iu.test(String(review.user?.login || ''))
        && String(review.body || '').includes('<!-- CODEX_FALLBACK_REVIEW -->'))));
}

function claimBody(event) {
  return `${REVIEW_CLAIM_MARKER} ${JSON.stringify(event)} -->\n`
    + `_Review claim ${event.state} · PR #${event.prNumber} · HEAD ${event.headSha.slice(0, 12)} · `
    + `${event.contributionFingerprint} · scade ${new Date(event.expiresAt * 1000).toISOString()}._`;
}

function postClaim(repo, prNumber, event) {
  gh(['pr', 'comment', String(prNumber), '--repo', repo, '--body', claimBody(event)]);
}

function writeOutput(result) {
  const values = {
    claim_allowed: result.allowed === true,
    claim_acquired: result.acquired === true,
    claim_exists: result.exists === true,
    claim_error: result.error === true,
    claim_token: result.token || '',
    claim_key: result.key || '',
    claim_dedupe_key: result.dedupeKey || '',
    claim_state: result.state || '',
    claim_reason: result.reason || '',
  };
  const lines = Object.entries(values)
    .map(([name, value]) => `${name}=${String(value).replace(/[\r\n]/gu, ' ')}`);
  console.log(lines.join(' '));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  return { ...result, ...values };
}

function claimToken() {
  const run = String(process.env.GITHUB_RUN_ID || process.pid || 'local')
    .replace(/[^A-Za-z0-9._-]/gu, '-');
  return `review-${run}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function contextFromEnv() {
  const prNumber = String(process.env.PR_NUMBER || '').trim();
  const headSha = String(process.env.HEAD_SHA || '').trim().toLowerCase();
  const eventKey = normalized(process.env.EVENT_KEY || '');
  const reviewRevision = normalized(process.env.REVIEW_REVISION || '').toLowerCase();
  let fingerprint = normalized(process.env.CONTRIBUTION_FINGERPRINT || '').toLowerCase();
  if (!FINGERPRINT_RE.test(fingerprint)) {
    const verdict = normalized(process.env.VERDICT_KEY || '');
    fingerprint = verdict.replace(/^contribution:/iu, '').toLowerCase();
  }
  const key = reviewClaimKey({ prNumber, headSha, eventKey, contributionFingerprint: fingerprint, reviewRevision });
  const dedupeKey = reviewClaimDedupeKey({ prNumber, headSha, eventKey, contributionFingerprint: fingerprint, reviewRevision });
  return {
    prNumber,
    headSha,
    eventKey,
    contributionFingerprint: fingerprint,
    ...(reviewRevision ? { reviewRevision } : {}),
    key,
    dedupeKey,
  };
}

function activeRunStates(repo, claims, nowSec) {
  const states = {};
  for (const claim of claims) {
    if (claim.state !== 'active' || Number(claim.expiresAt) <= nowSec) continue;
    const runId = String(claim.runId || '');
    if (!runId) throw new Error('claim attivo senza run id');
    let parsed;
    try {
      parsed = JSON.parse(gh(['run', 'view', runId, '--repo', repo, '--json', 'status,conclusion']));
    } catch (error) {
      throw new Error(`run claim #${runId} non leggibile (${error.message})`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`run claim #${runId} malformata`);
    }
    states[runId] = parsed;
  }
  return states;
}

function latestForDedupe(comments, dedupeKey) {
  return latestReviewClaims(comments, { dedupeKey }).sort((a, b) => {
    const ar = eventRank(a);
    const br = eventRank(b);
    for (let i = 0; i < ar.length; i += 1) {
      if (ar[i] !== br[i]) return ar[i] - br[i];
    }
    return 0;
  });
}

function dryComment(event, order) {
  return {
    id: order,
    created_at: new Date(event.issuedAt * 1000).toISOString(),
    user: { login: 'github-actions[bot]' },
    body: claimBody(event),
  };
}

function acquireClaim(base, repo) {
  const nowSec = Math.floor(Date.now() / 1000);
  const comments = readComments(repo, base.prNumber);
  const claims = latestReviewClaims(comments, { dedupeKey: base.dedupeKey });
  const decision = reviewClaimDecision({
    key: base.key,
    dedupeKey: base.dedupeKey,
    claims,
    nowSec,
    activeRunStates: activeRunStates(repo, claims, nowSec),
  });
  if (!decision.allowed || decision.error) return writeOutput({ ...base, ...decision });

  const ttlRaw = Number(process.env.CLAIM_TTL_SEC || 2 * 60 * 60);
  const ttlSec = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : 2 * 60 * 60;
  const token = process.env.CLAIM_TOKEN || claimToken();
  const event = {
    version: 1,
    token,
    ...base,
    state: 'active',
    issuedAt: nowSec,
    expiresAt: nowSec + ttlSec,
    runId: String(process.env.GITHUB_RUN_ID || ''),
  };
  if (!event.runId) throw new Error('GITHUB_RUN_ID mancante');
  if (process.env.DRY_RUN !== '1') postClaim(repo, base.prNumber, event);
  const after = process.env.DRY_RUN === '1'
    ? [...comments, dryComment(event, comments.length + 1)]
    : readComments(repo, base.prNumber);
  const all = latestForDedupe(after, base.dedupeKey);
  const active = all.filter((claim) => claim.state === 'active' && Number(claim.expiresAt) > nowSec);
  const terminal = all.some((claim) => claim.state === 'completed' || claim.state === 'failed-terminal');
  const own = latestReviewClaims(after, { key: base.key }).find((claim) => claim.token === token);
  const winner = active[0];
  if (!own || own.state !== 'active' || terminal || (winner && winner.token !== token)) {
    if (own?.state === 'active' && process.env.DRY_RUN !== '1') {
      try { postClaim(repo, base.prNumber, { ...own, state: 'released', issuedAt: nowSec }); } catch { /* loser cleanup is best effort */ }
    }
    if (terminal) return writeOutput({ ...base, allowed: false, exists: true, reason: 'same-pr-head-terminal-claim' });
    if (winner && winner.token !== token) return writeOutput({ ...base, allowed: false, exists: true, reason: 'same-pr-head-claim-contended' });
    throw new Error('claim non verificabile');
  }
  return writeOutput({ ...base, allowed: true, acquired: true, exists: false, token, state: 'active', reason: 'pr-head-claim-acquired' });
}

function finalizeClaim(base, repo) {
  const token = String(process.env.CLAIM_TOKEN || '');
  if (!token) return writeOutput({ ...base, allowed: false, error: true, reason: 'finalize-token-missing' });
  const comments = readComments(repo, base.prNumber);
  const current = latestReviewClaims(comments, { key: base.key }).find((claim) => claim.token === token);
  if (!current) throw new Error('claim token non trovato');

  const executionText = process.env.EXEC_FILE && fs.existsSync(process.env.EXEC_FILE)
    ? fs.readFileSync(process.env.EXEC_FILE, 'utf8')
    : '';
  const cause = normalized(process.env.REVIEW_ABORT_CAUSE || '').toLowerCase();
  const retryableCause = ['cancelled', 'max_turns', 'rate_limit', 'server_error'].includes(cause);
  const permanentCause = cause === 'non_retryable' || cause === 'probe_failed';
  let state = REVIEW_CLAIM_STATES.includes(process.env.CLAIM_STATUS)
    ? process.env.CLAIM_STATUS
    : claimStatusFromOutcome({
      proceed: process.env.PROCEED,
      claudeOutcome: process.env.CLAUDE_OUTCOME || '',
      executionText,
      retryableFailure: process.env.RETRYABLE_FAILURE === 'true' || retryableCause,
      permanentFailure: process.env.PERMANENT_FAILURE === 'true' || permanentCause,
      reviewPosted: process.env.REVIEW_POSTED === 'true',
    });
  if (state === 'completed' && !reviewWasPosted(repo, base.prNumber, base.headSha, base.reviewRevision)) {
    if (permanentCause) state = 'failed-terminal';
    else state = 'failed-transient';
  }
  if (current.state === state) return writeOutput({ ...base, allowed: true, token, state, reason: 'claim-already-finalized' });
  if (current.state === 'completed' || current.state === 'failed-terminal') {
    throw new Error(`claim gia' terminale (${current.state})`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const finalEvent = {
    ...current,
    state,
    issuedAt: nowSec,
    expiresAt: Math.max(nowSec, Number(current.expiresAt)),
    runId: String(process.env.GITHUB_RUN_ID || current.runId),
  };
  if (process.env.DRY_RUN !== '1') postClaim(repo, base.prNumber, finalEvent);
  const after = process.env.DRY_RUN === '1'
    ? [...comments, dryComment(finalEvent, comments.length + 1)]
    : readComments(repo, base.prNumber);
  const verified = latestReviewClaims(after, { key: base.key }).find((claim) => claim.token === token);
  if (!verified || verified.state !== state) throw new Error('finalizzazione claim non verificabile');
  return writeOutput({ ...base, allowed: true, token, state, reason: 'pr-head-claim-finalized' });
}

function claimMain() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const base = contextFromEnv();
  try {
    if (!repo || !base.key || !base.dedupeKey) {
      return writeOutput({ ...base, allowed: false, error: true, reason: 'invalid-claim-context' });
    }
    const action = process.env.CLAIM_ACTION || 'acquire';
    if (action === 'acquire') return acquireClaim(base, repo);
    if (action === 'finalize') return finalizeClaim(base, repo);
    return writeOutput({ ...base, allowed: false, error: true, reason: 'invalid-claim-action' });
  } catch (error) {
    console.log(`::error::Review claim fail-closed: ${String(error?.message || error).slice(0, 240)}`);
    return writeOutput({ ...base, allowed: false, error: true, reason: 'claim-api-or-parse-error' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--claim')) claimMain();
}
