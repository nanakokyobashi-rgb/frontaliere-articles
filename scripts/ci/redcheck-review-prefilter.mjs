#!/usr/bin/env node

/**
 * Decide whether the redcheck fixer is looking at a review-only failure.
 *
 * This is deliberately a pure predicate over data fetched by the workflow.
 * `Run Claude review=success` is not evidence by itself: that step has
 * `continue-on-error`, so an aborted action can still be reported as success.
 * A review posted by a reviewer bot on the exact HEAD, with a real Important
 * finding, is the stronger signal that the redflag fixer owns the failure.
 * An explicit transient-review abort is also distinguishable from a code
 * failure, but it is not assigned to either fixer: redcheck must not spend a
 * repair round when there is no code diagnosis to apply.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  CLAUDE_REVIEW_STEP_NAME,
  NON_GATING_REVIEW_STEPS,
  REVIEW_ABORT_STEP_NAME,
  REVIEW_DEATH_STEP_NAMES,
  REVIEW_GATE_STEP_NAME,
} from './lib/vitestCheck.mjs';
import {
  REDFLAG_IMPORTANT_RE,
  REVIEWER_BOT_LOGIN_RE,
} from './lib/constants.mjs';

function rowsFromPages(value, key) {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    if (Array.isArray(page)) return page;
    return Array.isArray(page?.[key]) ? page[key] : [];
  });
}

/**
 * @param {{headSha?: string, jobs?: unknown, reviews?: unknown}} input
 * @returns {'important'|'transient'|''}
 */
export function reviewFailureKind(input) {
  const headSha = typeof input?.headSha === 'string' ? input.headSha : '';
  if (!headSha) return '';

  const jobs = rowsFromPages(input?.jobs, 'jobs');
  const testsJob = jobs.find((job) => job?.name === 'tests (node --test)');
  const steps = Array.isArray(testsJob?.steps) ? testsJob.steps : [];
  const failedSteps = steps
    .filter((step) => step?.conclusion === 'failure')
    .map((step) => String(step.name || ''));
  const codeFailures = failedSteps.filter((name) =>
    name !== REVIEW_GATE_STEP_NAME
    && !NON_GATING_REVIEW_STEPS.has(name)
    && !REVIEW_DEATH_STEP_NAMES.has(name));
  if (codeFailures.length > 0) return '';

  const gateFailed = failedSteps.includes(REVIEW_GATE_STEP_NAME);
  const reviewAborted = failedSteps.includes(REVIEW_ABORT_STEP_NAME);

  // A gate verdict with a real Important finding belongs to redflag-fixer.
  // Keep this branch fail-closed: the review must be present on the exact HEAD
  // and must contain the finding, not merely have a failed review step.
  if (gateFailed) {
    // Keep the topology check, but do not trust this step's conclusion: the
    // action has continue-on-error and can die without posting a review.
    if (!steps.some((step) => step?.name === CLAUDE_REVIEW_STEP_NAME)) return '';

    const reviews = rowsFromPages(input?.reviews, null);
    const lastOnHead = reviews
      .filter((review) =>
        review?.commit_id === headSha
        && review?.user?.type === 'Bot'
        && REVIEWER_BOT_LOGIN_RE.test(review.user.login ?? ''),
      )
      .at(-1);
    // The transient-abort step and the gate can both be red: the gate is an
    // `always()` consumer of the review result, so it fails after an aborted
    // action even though there is no verdict to repair. Keep that explicit
    // signal, but only after giving a real Important finding precedence.
    if (!lastOnHead) return reviewAborted ? 'transient' : '';

    // No 🔴 Important means the review can be a no-LGTM/nit-only review with
    // no owner capable of repairing the gate. Leave that case to redcheck.
    if (REDFLAG_IMPORTANT_RE.test(lastOnHead.body ?? '')) return 'important';
  }

  // The action explicitly reported a transient failure and no code step is
  // red. There is no safe patch for redcheck to derive, so avoid a pointless
  // Claude round. A gate failure without an Important review is transient only
  // when the same run also reports the explicit abort; otherwise it stays
  // fail-closed because it may be a real missing/ambiguous verdict.
  if (reviewAborted) return 'transient';
  return '';
}

/**
 * Backward-compatible boolean API for callers that only own Important review
 * findings.
 *
 * @param {{headSha?: string, jobs?: unknown, reviews?: unknown}} input
 * @returns {boolean}
 */
export function reviewOnlyFailure(input) {
  return reviewFailureKind(input) === 'important';
}

// ── Same PR + HEAD + failed-check claim (#8363) ─────────────────────────────
// A workflow_run is emitted for every completed tests run.  Concurrency by
// branch prevents two long-lived fixers from running at once, but it does not
// coalesce reruns/retries that describe the same red check.  This marker is an
// append-only claim on the PR thread: an active claim serializes contenders,
// while a completed/failed-terminal claim makes the same contribution
// idempotent.  `failed-transient` and `released` deliberately remain retryable.
export const REDCHECK_FIX_CLAIM_MARKER = '<!-- REDCHECK_FIX_CLAIM:';
const REDCHECK_FIX_CLAIM_STATES = new Set([
  'active', 'completed', 'failed-terminal', 'failed-transient', 'released',
]);
const REDCHECK_FIX_CLAIM_RE = /<!-- REDCHECK_FIX_CLAIM:\s*(\{[\s\S]*?\})\s*-->/;
const REDCHECK_FIX_CLAIM_ACTOR_RE = /^(?:github-actions\[bot\]|frontaliere-automation(?:\[bot\])?|claude(?:\[bot\])?|nanakokyobashi-rgb|valerielinc-ops)$/i;

function validClaimContext({ prNumber, headSha, checkFailureKey } = {}) {
  return /^[1-9][0-9]*$/.test(String(prNumber || ''))
    && /^[0-9a-f]{40}$/i.test(String(headSha || ''))
    && String(checkFailureKey || '').trim().length > 0;
}

function normalizeFailureKey(value) {
  return (Array.isArray(value) ? value : String(value || '').split(','))
    .map((part) => String(part).trim())
    .filter(Boolean)
    .sort()
    .join(',');
}

export function redcheckFixClaimKey({ prNumber, headSha, checkFailureKey } = {}) {
  if (!validClaimContext({ prNumber, headSha, checkFailureKey })) return '';
  return `pr:${String(prNumber)}|head:${String(headSha).toLowerCase()}|failure:${normalizeFailureKey(checkFailureKey)}`;
}

export function parseRedcheckFixClaim(body) {
  const match = String(body || '').match(REDCHECK_FIX_CLAIM_RE);
  if (!match) return null;
  let event;
  try { event = JSON.parse(match[1]); } catch { return null; }
  if (!event || event.version !== 1 || typeof event.token !== 'string' || !event.token
      || typeof event.key !== 'string' || !event.key
      || !REDCHECK_FIX_CLAIM_STATES.has(event.state)
      || !/^[1-9][0-9]*$/.test(String(event.prNumber || ''))
      || !/^[0-9a-f]{40}$/i.test(String(event.headSha || ''))
      || !String(event.checkFailureKey || '').trim()
      || !Number.isFinite(Number(event.issuedAt))
      || !Number.isFinite(Number(event.expiresAt))) return null;
  return {
    ...event,
    prNumber: String(event.prNumber),
    headSha: String(event.headSha).toLowerCase(),
    checkFailureKey: normalizeFailureKey(event.checkFailureKey),
    issuedAt: Number(event.issuedAt),
    expiresAt: Number(event.expiresAt),
  };
}

function claimEventRank(event) {
  return [
    Number(event?.commentAt) || 0,
    Number(event?.commentId) || 0,
    Number(event?.commentOrder) || 0,
  ];
}

function laterClaimEvent(a, b) {
  const ar = claimEventRank(a);
  const br = claimEventRank(b);
  for (let i = 0; i < ar.length; i += 1) {
    if (ar[i] !== br[i]) return ar[i] > br[i] ? a : b;
  }
  return b;
}

export function latestRedcheckFixClaims(comments = [], key = '') {
  const latest = new Map();
  for (const [index, comment] of (comments || []).entries()) {
    const login = String(comment?.user?.login || comment?.author?.login || '');
    if (login && !REDCHECK_FIX_CLAIM_ACTOR_RE.test(login)) continue;
    const event = parseRedcheckFixClaim(comment?.body);
    if (!event || (key && event.key !== key)) continue;
    const at = Date.parse(comment?.created_at ?? comment?.createdAt ?? '');
    const candidate = {
      ...event,
      commentId: Number(comment?.id) || index,
      commentAt: Number.isFinite(at) ? Math.floor(at / 1000) : event.issuedAt,
      commentOrder: index,
    };
    const previous = latest.get(event.token);
    latest.set(event.token, previous ? laterClaimEvent(previous, candidate) : candidate);
  }
  return [...latest.values()];
}

export function redcheckFixClaimDecision({ key, comments = [], nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!key) return { allowed: false, error: true, reason: 'claim-key-missing' };
  const claims = latestRedcheckFixClaims(comments, key);
  if (claims.some((claim) => claim.state === 'completed' || claim.state === 'failed-terminal')) {
    return { allowed: false, exists: true, reason: 'same-red-terminal-claim' };
  }
  if (claims.some((claim) => claim.state === 'active' && Number(claim.expiresAt) > Number(nowSec))) {
    return { allowed: false, exists: true, reason: 'same-red-claim-active' };
  }
  return { allowed: true, exists: claims.length > 0, reason: 'same-red-claim-retryable' };
}

function claimCommentBody(event) {
  return `${REDCHECK_FIX_CLAIM_MARKER} ${JSON.stringify(event)} -->\n`
    + `_Redcheck claim ${event.state} · PR #${event.prNumber} · HEAD ${event.headSha.slice(0, 12)} · `
    + `failure ${event.checkFailureKey} · scade ${new Date(event.expiresAt * 1000).toISOString()}._`;
}

function claimGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function claimComments(repo, prNumber) {
  const raw = claimGh([
    'api', '--paginate', '--slurp', `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
  ]);
  let pages;
  try { pages = JSON.parse(raw); } catch (error) { throw new Error(`commenti PR: JSON non valido (${error.message})`); }
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    throw new Error('commenti PR: risposta non e\' un array di pagine');
  }
  const comments = pages.flat();
  if (!comments.every((comment) => comment && typeof comment === 'object' && !Array.isArray(comment))) {
    throw new Error('commenti PR: pagina malformata');
  }
  return comments;
}

function postClaim(repo, prNumber, event) {
  claimGh(['pr', 'comment', String(prNumber), '--repo', repo, '--body', claimCommentBody(event)]);
}

function writeClaimOutputs(result) {
  const values = {
    claim_allowed: result.allowed === true,
    claim_acquired: result.acquired === true,
    claim_exists: result.exists === true,
    claim_error: result.error === true,
    claim_token: result.token || '',
    claim_key: result.key || '',
    claim_state: result.state || '',
    claim_reason: result.reason || '',
  };
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, ' ')}`);
  console.log(lines.join(' '));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  return { ...result, ...values };
}

function redcheckFixClaimToken() {
  const run = String(process.env.GITHUB_RUN_ID || process.pid || 'local')
    .replace(/[^A-Za-z0-9._-]/g, '-');
  return `redcheck-${run}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function claimMain() {
  const action = process.env.CLAIM_ACTION || 'acquire';
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const prNumber = process.env.PR_NUMBER || '';
  const headSha = process.env.HEAD_SHA || '';
  const checkFailureKey = process.env.CHECK_FAILURE_KEY || '';
  const key = redcheckFixClaimKey({ prNumber, headSha, checkFailureKey });
  const base = { key };
  try {
    if (!['acquire', 'finalize'].includes(action) || !repo || !key) {
      return writeClaimOutputs({ ...base, allowed: false, error: true, reason: 'invalid-claim-context' });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const comments = claimComments(repo, prNumber);
    if (action === 'acquire') {
      const decision = redcheckFixClaimDecision({ key, comments, nowSec });
      if (!decision.allowed) return writeClaimOutputs({ ...base, ...decision });

      const ttlRaw = Number(process.env.CLAIM_TTL_SEC || 2 * 60 * 60);
      const ttlSec = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : 2 * 60 * 60;
      const token = process.env.CLAIM_TOKEN || redcheckFixClaimToken();
      const event = {
        version: 1,
        token,
        key,
        prNumber: String(prNumber),
        headSha: String(headSha).toLowerCase(),
        checkFailureKey: normalizeFailureKey(checkFailureKey),
        state: 'active',
        issuedAt: nowSec,
        expiresAt: nowSec + ttlSec,
        runId: String(process.env.GITHUB_RUN_ID || ''),
      };
      if (process.env.DRY_RUN !== '1') postClaim(repo, prNumber, event);

      const after = process.env.DRY_RUN === '1' ? [...comments, { body: claimCommentBody(event) }] : claimComments(repo, prNumber);
      const own = latestRedcheckFixClaims(after, key).find((claim) => claim.token === token);
      const active = latestRedcheckFixClaims(after, key)
        .filter((claim) => claim.state === 'active' && Number(claim.expiresAt) > nowSec);
      const terminal = latestRedcheckFixClaims(after, key)
        .some((claim) => claim.state === 'completed' || claim.state === 'failed-terminal');
      if (!own || own.state !== 'active' || terminal || active.length !== 1) {
        if (own?.state === 'active' && process.env.DRY_RUN !== '1') {
          postClaim(repo, prNumber, { ...own, state: 'released', issuedAt: nowSec });
        }
        throw new Error('claim non verificabile o conteso');
      }
      return writeClaimOutputs({ ...base, allowed: true, acquired: true, exists: false, token, state: 'active', reason: 'redcheck-claim-acquired' });
    }

    const token = process.env.CLAIM_TOKEN || '';
    const status = process.env.CLAIM_STATUS || 'completed';
    if (!token || !['completed', 'failed-terminal', 'failed-transient', 'released'].includes(status)) {
      return writeClaimOutputs({ ...base, allowed: false, error: true, reason: 'invalid-finalize-context' });
    }
    const current = latestRedcheckFixClaims(comments, key).find((claim) => claim.token === token);
    if (!current) throw new Error('claim token non trovato');
    if (current.state === status) {
      return writeClaimOutputs({ ...base, allowed: true, token, state: status, reason: 'claim-already-finalized' });
    }
    if (['completed', 'failed-terminal'].includes(current.state)) {
      throw new Error(`claim gia' terminale (${current.state})`);
    }
    const finalEvent = {
      ...current,
      state: status,
      issuedAt: nowSec,
      expiresAt: Math.max(nowSec, Number(current.expiresAt)),
      runId: String(process.env.GITHUB_RUN_ID || current.runId || ''),
    };
    if (process.env.DRY_RUN !== '1') postClaim(repo, prNumber, finalEvent);
    const after = process.env.DRY_RUN === '1' ? [...comments, { body: claimCommentBody(finalEvent) }] : claimComments(repo, prNumber);
    const verified = latestRedcheckFixClaims(after, key).find((claim) => claim.token === token);
    if (!verified || verified.state !== status) throw new Error('finalizzazione claim non verificabile');
    return writeClaimOutputs({ ...base, allowed: true, token, state: status, reason: 'redcheck-claim-finalized' });
  } catch (error) {
    console.log(`::error::redcheck claim fail-closed: ${String(error?.message || error).slice(0, 240)}`);
    return writeClaimOutputs({ ...base, allowed: false, error: true, reason: 'claim-api-or-parse-error' });
  }
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const kind = reviewFailureKind(JSON.parse(raw));
    process.stdout.write(process.argv.includes('--kind') ? `${kind || 'none'}\n` : `${kind === 'important'}\n`);
  } catch {
    // An unreadable or incomplete API response must not suppress the fixer.
    process.stdout.write(process.argv.includes('--kind') ? 'none\n' : 'false\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--claim')) claimMain();
  else main();
}
