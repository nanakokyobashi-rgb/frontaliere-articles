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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseReviewQuotaDeferredMarker,
  runQuotaLease,
} from './check-quota-backoff.mjs';

export const REVIEW_QUOTA_RETRY_MARKER = '<!-- REVIEW_QUOTA_RETRY:';
const REVIEW_QUOTA_RETRY_RE = /<!-- REVIEW_QUOTA_RETRY:\s*(\{[\s\S]*?\})\s*-->/;
const PR_QUOTA_ROLES = new Set(['review', 'redflag', 'redcheck']);
const REVIEW_QUOTA_RETRY_STATES = new Set(['requested', 'confirmed', 'failed']);
const REVIEW_QUOTA_RETRY_ACTIVE_STATES = new Set(['requested', 'confirmed']);
const SOURCE_WORKFLOW_BY_ROLE = Object.freeze({
  review: 'tests',
  redflag: 'PR 🔴 fixer (bounded loop-closure on bot PRs)',
  redcheck: 'PR ❌ check fixer (bounded, check richiesto rosso su PR bot)',
});

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const MAX_PRS = positiveInt(process.env.REVIEW_QUOTA_RESCUER_MAX_PRS, 100);
const MAX_RETRIES = positiveInt(process.env.REVIEW_QUOTA_RESCUER_MAX_RETRIES, 1);
const TRUSTED_AUTOMATION_RE = /^(?:github-actions\[bot\]|frontaliere-automation(?:\[bot\])?|claude(?:\[bot\])?|nanakokyobashi-rgb|valerielinc-ops)$/i;

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
  const parsed = parseJson(gh(['api', '--paginate', '--slurp', path]), []);
  return Array.isArray(parsed)
    ? parsed.flatMap((page) => Array.isArray(page) ? page : [])
    : [];
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
  return !login || TRUSTED_AUTOMATION_RE.test(login);
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
  if (!event || event.version !== 1
      || !/^[a-f0-9]{40}$/i.test(String(event.head || ''))
      || !PR_QUOTA_ROLES.has(String(event.role || ''))
      || !String(event.deferredRunId || '')
      || !String(event.sourceRunId || '')
      || !String(event.runId || '')
      || !REVIEW_QUOTA_RETRY_STATES.has(state)) return null;
  return {
    ...event,
    head: String(event.head),
    role: String(event.role),
    deferredRunId: String(event.deferredRunId),
    sourceRunId: String(event.sourceRunId),
    runId: String(event.runId),
    state,
  };
}

/** Ultimo stato del retry per questa deferral. Pure e append-only. */
export function latestReviewQuotaRetry(
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
      best = event;
      bestRank = rank;
    }
  }
  return best;
}

/** True when this exact deferral has an active/confirmed retry. Pure. */
export function hasReviewQuotaRetry(comments = [], options = {}) {
  const latest = latestReviewQuotaRetry(comments, options);
  return !!latest && REVIEW_QUOTA_RETRY_ACTIVE_STATES.has(latest.state);
}

/**
 * Return every still-pending deferral on the current HEAD, one per
 * `(head, role, runId)`. A PR can have independent deferrals for review,
 * redflag and redcheck; looking only at the newest comment for the whole PR
 * would let a reconciled consumer hide an older one forever.
 * Pure and head-pinned.
 */
export function reviewQuotaDeferredCandidates({ head = '', comments = [] } = {}) {
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
    .filter(({ deferred }) => !hasReviewQuotaRetry(comments, {
      head,
      role: deferred.role,
      deferredRunId: deferred.runId,
    }))
    .sort((a, b) => {
      const at = a.rank[0] || 0;
      const bt = b.rank[0] || 0;
      return at - bt || (a.rank[1] || 0) - (b.rank[1] || 0) || (a.rank[2] || 0) - (b.rank[2] || 0);
    })
    .map(({ deferred }) => deferred);
}

/** Return the oldest pending retry candidate or null. Pure and head-pinned. */
export function deferredReviewCandidate({ head = '', comments = [] } = {}) {
  return reviewQuotaDeferredCandidates({ head, comments })[0] || null;
}

export function reviewQuotaRetryBody({
  head, deferredRunId, role, sourceRunId, runId, state = 'confirmed',
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
  return `${REVIEW_QUOTA_RETRY_MARKER} ${JSON.stringify(event)} -->\n`
    + `_Review quota rescuer zero-Claude: rilancio della run ${event.role} #${event.sourceRunId} `
    + `sulla HEAD ${event.head.slice(0, 12)} dopo il rilascio del lease._`;
}

function listOpenPullRequests() {
  return apiPages(`repos/${REPO}/pulls?state=open&per_page=100`)
    .filter((pr) => pr && pr.number && !pr.draft)
    .slice(0, MAX_PRS);
}

function commentsForPr(number) {
  return apiPages(`repos/${REPO}/issues/${number}/comments?per_page=100`);
}

export function sourceWorkflowForRole(role) {
  return SOURCE_WORKFLOW_BY_ROLE[String(role)] || '';
}

function sourceRunForCandidate(candidate) {
  const sourceRunId = String(candidate?.deferred?.runId || '');
  const expectedWorkflow = sourceWorkflowForRole(candidate?.deferred?.role);
  if (!/^\d+$/.test(sourceRunId) || !expectedWorkflow) return null;
  const raw = gh([
    'run', 'view', sourceRunId, '--repo', REPO,
    '--json', 'databaseId,headSha,status,workflowName,headBranch,event',
  ], { allowFail: true });
  const run = parseJson(raw, null);
  if (!run || run.status !== 'completed'
      || run.headSha !== candidate.head
      || run.workflowName !== expectedWorkflow) return null;
  return { ...run, databaseId: String(run.databaseId || sourceRunId) };
}

function releaseLease(prNumber, role, token, runId) {
  if (!token || DRY_RUN) return;
  runQuotaLease({
    action: 'release',
    role,
    owner: 'review-quota-rescuer',
    targetType: 'pr',
    target: String(prNumber),
    token,
    runId,
    writeOutput: false,
    dryRun: DRY_RUN,
  });
}

function postRetryComment(number, body) {
  try {
    gh(['pr', 'comment', String(number), '--repo', REPO, '--body', body]);
    return true;
  } catch (error) {
    console.log(`::warning::commento retry review fallito su #${number}: ${String(error?.message || error).slice(0, 180)}`);
    return false;
  }
}

export function collectReviewQuotaCandidates(prs, commentsByPr = new Map()) {
  return (prs || []).map((pr) => {
    const head = String(pr?.head?.sha || '');
    const comments = commentsByPr.get(Number(pr?.number)) || [];
    const deferred = deferredReviewCandidate({ head, comments });
    return deferred ? { pr, head, deferred, comments } : null;
  }).filter(Boolean).sort((a, b) => {
    const at = Date.parse(a.deferred.createdAt || '') || 0;
    const bt = Date.parse(b.deferred.createdAt || '') || 0;
    return at - bt || Number(a.pr.number) - Number(b.pr.number);
  });
}

function main() {
  if (!REPO) {
    console.log('review-quota-rescuer: repository mancante — nessuna azione.');
    return;
  }

  const prs = listOpenPullRequests();
  const commentsByPr = new Map();
  for (const pr of prs) commentsByPr.set(Number(pr.number), commentsForPr(pr.number));
  const candidates = collectReviewQuotaCandidates(prs, commentsByPr);
  console.log(`review-quota-rescuer: PR osservate=${prs.length}, candidate=${candidates.length}, max retry=${MAX_RETRIES}`);

  let retried = 0;
  for (const candidate of candidates) {
    if (retried >= MAX_RETRIES) break;
    const number = Number(candidate.pr.number);
    const run = sourceRunForCandidate(candidate);
    if (!run) {
      console.log(`PR #${number}: deferral ${candidate.deferred.role} sulla HEAD ${candidate.head.slice(0, 12)}, run sorgente non verificabile/completata.`);
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

    const retryFields = {
      head: candidate.head,
      role: candidate.deferred.role,
      deferredRunId: candidate.deferred.runId,
      sourceRunId: run.databaseId,
      runId: process.env.GITHUB_RUN_ID || 'review-quota-rescuer',
    };

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

    const confirmedBody = reviewQuotaRetryBody({ ...retryFields, state: 'confirmed' });
    if (!postRetryComment(number, confirmedBody)) {
      // `requested` è già durevole e hasReviewQuotaRetry() lo considera attivo:
      // il prossimo tick non può rilanciare lo stesso source run due volte.
      console.log(`::warning::PR #${number}: conferma marker retry non pubblicata; il fence requested impedisce duplicati.`);
    }
    console.log(`PR #${number}: ${candidate.deferred.role} #${run.databaseId} rilanciato sulla HEAD ${candidate.head.slice(0, 12)}.`);
    retried += 1;
  }
  console.log(`review-quota-rescuer: retry richiesti=${retried}.`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    // Un rescuer rotto non deve colorare il check del repo né modificare il
    // routing: il cron successivo riprova e il marker resta osservabile.
    console.error(`review-quota-rescuer: probe fallita (defer sicuro): ${String(error?.message || error).slice(0, 240)}`);
    process.exitCode = 0;
  }
}
