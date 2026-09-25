/**
 * Native auto-merge guard.
 *
 * GitHub's native auto-merge remains the merger. This helper is only the
 * fail-closed opt-in gate: it must see the latest approving
 * Claude/frontaliere reviewer-bot verdict (or an explicitly marked Codex
 * fallback with structured review-gate evidence) and a completed required
 * Vitest check on the current HEAD before calling `gh pr merge --auto`. The
 * required check is the complete `tests` job, so its green result is the
 * authority for the review gate's validated LGTM carry-forward when the
 * review commit is older than the current HEAD. A Codex fallback LGTM on an
 * older commit is narrower: the green check alone does not admit it. It needs
 * the structured carry-forward proof of `codexCarryForwardDecision` (#1870).
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isCodexFallbackReview,
  isManagedReview,
  isReviewerBot,
  REDFLAG_IMPORTANT_RE,
  VITEST_CHECK_NAME,
} from './lib/constants.mjs';
import {
  findTestOnlyApproval,
  normalizeReviewInputRevision,
  reviewHasInputRevision,
  reviewInputContextFromPullRequest,
  TEST_REVIEW_MARKER,
} from './review-test-policy.mjs';
import {
  CODEX_REVIEW_STEP_NAME,
  REVIEW_ABORT_STEP_NAME,
  REVIEW_CLAIM_STEP_NAME,
  REVIEW_GUARD_STEP_NAME,
  RUN_SELECTION_STATES,
  latestCompletedRunSelectionByName,
} from './lib/vitestCheck.mjs';

const TESTS_WORKFLOW_PATH = '.github/workflows/tests.yml';
const TESTS_WORKFLOW_EVENT = 'pull_request';
// Keep the bootstrap dependency-free unless the gate actually needs it.
export const REVIEW_GATE_STEP_NAME = 'Require approving Codex review';
// `enable-native-automerge.yml` downloads this helper from `main`. Keep the
// provider rename readable during the transition while requiring exactly one
// repository-owned gate step in the verified job.
export const REVIEW_GATE_STEP_NAMES = Object.freeze([
  'Require approving Claude review',
  'Require approving Codex review',
]);
const FINDINGS_HEADING_RE = /^\s{0,3}#{1,3}\s+Findings\b[^\n]*$/i;
const ANY_HEADING_RE = /^\s{0,3}#{1,3}\s+\S/;
const IMPORTANT_COUNT_RE = /\bImportant\s*:\s*(\d+)\b/gi;
const LGTM_HEADING_RE = /^\s{0,3}##\s+LGTM\s*$/m;
const TEST_ONLY_REVIEW_BOT_RE = /^(?:github-actions|frontaliere-automation)\[bot\]$/i;
const MAX_TRANSIENT_GH_READ_ATTEMPTS = 3;
const TRANSIENT_GH_READ_RETRY_DELAYS_MS = Object.freeze([250, 750]);
const TRANSIENT_GH_READ_ERROR_RE = /(?:\bHTTP\s+5\d{2}\b|\b5\d{2}\s+(?:bad gateway|service unavailable|gateway timeout)\b|service unavailable|bad gateway|gateway timeout|timed?\s*out|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/iu;

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

function reviewTimestamp(review) {
  const timestamps = [
    review?.submitted_at,
    review?.submittedAt,
    review?.created_at,
    review?.createdAt,
  ]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

/**
 * The ordering key above must not move when an old review is edited.  The
 * evidence proof has a different job: it must reject a review whose content
 * was updated after the review-gate step started.  Keep mutable timestamps in
 * this separate freshness key so the two decisions cannot contaminate each
 * other.
 */
function reviewFreshnessTimestamp(review) {
  const timestamps = [
    review?.edited_at,
    review?.editedAt,
    review?.event_at,
    review?.eventAt,
    review?.updated_at,
    review?.updatedAt,
    review?.submitted_at,
    review?.submittedAt,
    review?.created_at,
    review?.createdAt,
  ]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function latestReviewMatching(reviews, predicate) {
  if (!Array.isArray(reviews) || typeof predicate !== 'function') return null;
  const candidates = flattenPages(reviews)
    .map((review, index) => ({ review, index, timestamp: reviewTimestamp(review) }))
    .filter(({ review, timestamp }) => predicate(review)
      && timestamp !== null)
    .sort((left, right) => left.timestamp - right.timestamp
      || (Number(left.review.id || left.index) || left.index)
        - (Number(right.review.id || right.index) || right.index));
  return candidates.at(-1)?.review || null;
}

function latestBotReviewMatching(reviews, predicate) {
  if (typeof predicate !== 'function') return null;
  return latestReviewMatching(reviews, (review) => isReviewerBot(review?.user)
    && predicate(review));
}

/**
 * The Codex fallback is not a raw reviewer. It may enter only the structured
 * review-gate evidence path, with the exact marker emitted by `tests.yml` and
 * an exact current HEAD. Keep this identity narrower than the normal
 * Claude/frontaliere reviewer allowlist.
 */
function isCodexFallbackReviewOnHead(review, head) {
  return typeof head === 'string'
    && /^[0-9a-f]{40}$/iu.test(head)
    && review.commit_id === head
    && isCodexFallbackReview(review);
}

/**
 * A Codex fallback verdict on an earlier commit of the PR, typically before an
 * autorebase merge of `main` (#1870). The `tests.yml` guard carries it forward
 * without running Codex again, so no newer Codex review will ever appear on
 * the HEAD. It is a candidate only for `codexCarryForwardDecision`; a review
 * whose author is also in the reviewer allowlist keeps the allowlist path.
 */
function isCodexCarryForwardCandidate(review, head) {
  return typeof head === 'string'
    && /^[0-9a-f]{40}$/iu.test(head)
    && /^[0-9a-f]{40}$/iu.test(String(review?.commit_id || ''))
    && review.commit_id !== head
    && !isReviewerBot(review?.user)
    && isCodexFallbackReview(review);
}

/**
 * Select the latest managed verdict: a normal reviewer, or an explicitly
 * marked Codex fallback on any commit. An older Codex verdict is selected so
 * that an even older allowlist LGTM cannot overtake it; it is then admitted
 * only through the carry-forward proof.
 */
function latestReviewGateCandidate(reviews, head) {
  return latestReviewMatching(reviews, (review) => isManagedReview(review)
    && (isReviewerBot(review?.user)
      || isCodexFallbackReviewOnHead(review, head)
      || isCodexCarryForwardCandidate(review, head)));
}

/** Return the latest reviewer-bot review, regardless of the commit it names. */
export function latestBotReview(reviews) {
  if (!Array.isArray(reviews)) return null;
  return latestBotReviewMatching(reviews, () => true);
}

/** Return the latest reviewer-bot review that is anchored to `head`. */
export function latestBotReviewOnHead(reviews, head) {
  if (typeof head !== 'string' || !head) return null;
  return latestBotReviewMatching(reviews, (review) => review?.commit_id === head);
}

/**
 * Righe della sezione `## Findings`: dal titolo (incluso) fino al titolo
 * successivo, escluso. `null` quando la sezione non esiste.
 */
function findingsSectionLines(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => FINDINGS_HEADING_RE.test(line));
  if (start === -1) return null;
  const section = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (ANY_HEADING_RE.test(lines[index])) break;
    section.push(lines[index]);
  }
  return section;
}

/**
 * Zero blocking findings. A missing `## Findings` heading is approving when
 * the body also has no real `🔴 Important`. `🟡 Nit` is advisory (site #9085)
 * and must not block native auto-merge of an otherwise clean `## LGTM`.
 *
 * Il conteggio si legge nella SEZIONE, non solo sulla riga del titolo. Il
 * reviewer emette entrambe le forme: `## Findings (Important: 0, Nit: 0)` e un
 * titolo nudo `## Findings` con `Important: 0` una riga sotto (osservato sulla
 * review 5258385493 della PR #9315 del sito, commit e1fe8e3e). Leggendo solo il
 * titolo la seconda forma risultava non-approvante con zero finding e `## LGTM`
 * finale, e il gate non apriva l'auto-merge.
 *
 * Senza un conteggio riconoscibile nella sezione la risposta resta `false`
 * (fail-closed): è ciò che la riga del titolo faceva già prima, perché un
 * `## Findings` nudo non matchava `Important: 0`. Un 🔴 Important reale,
 * ovunque nel body, blocca comunque.
 */
export function reviewHasZeroFindings(body) {
  if (typeof body !== 'string') return false;
  REDFLAG_IMPORTANT_RE.lastIndex = 0;
  if (REDFLAG_IMPORTANT_RE.test(body)) return false;
  const section = findingsSectionLines(body);
  if (!section) return true;
  IMPORTANT_COUNT_RE.lastIndex = 0;
  const counts = [...section.join('\n').matchAll(IMPORTANT_COUNT_RE)]
    .map((match) => Number(match[1]));
  if (counts.length === 0) return false;
  return counts.every((count) => count === 0);
}

export function reviewHasLgtm(body) {
  return typeof body === 'string' && LGTM_HEADING_RE.test(body);
}

export function reviewIsApproved(review) {
  if (!review || !/^[0-9a-f]{40}$/i.test(String(review.commit_id || ''))) return false;
  if (!isReviewerBot(review.user)) return false;
  if (!['APPROVED', 'COMMENTED'].includes(String(review.state || '').toUpperCase())) return false;
  return reviewHasZeroFindings(review.body) && reviewHasLgtm(review.body);
}

export function reviewIsApprovedOnHead(review, head) {
  if (!review || review.commit_id !== head) return false;
  return reviewIsApproved(review);
}

/**
 * Tests-only is a separate, narrower approval class. `github-actions[bot]`
 * must never become a general reviewer identity: this branch is accepted only
 * for the exact marker emitted by `review-test-policy.mjs`, with a clean
 * structured verdict pinned to the current HEAD. The caller still has to pass
 * the result of `findTestOnlyApproval`, which independently re-checks the
 * complete PR file list before this pure decision function is called.
 */
function testOnlyReviewIsApproved(review, head) {
  if (!review || review.commit_id !== head) return false;
  if (review.user?.type !== 'Bot' || !TEST_ONLY_REVIEW_BOT_RE.test(review.user.login || '')) {
    return false;
  }
  if (!String(review.body || '').includes(TEST_REVIEW_MARKER)) return false;
  if (!['COMMENTED', 'APPROVED'].includes(String(review.state || '').toUpperCase())) return false;
  return reviewHasZeroFindings(review.body) && reviewHasLgtm(review.body);
}

/** Select the newest generation of the required check; active/ambiguous runs block. */
export function requiredVitestDecision(checkRuns, head) {
  if (!Array.isArray(checkRuns) || typeof head !== 'string' || !head) {
    return { allow: false, reason: 'check-runs non verificabili' };
  }
  const selection = latestCompletedRunSelectionByName(checkRuns, VITEST_CHECK_NAME);
  if (selection.state === RUN_SELECTION_STATES.PENDING) {
    const reason = selection.reason === 'missing'
      ? `check required ${VITEST_CHECK_NAME} assente sulla HEAD`
      : `check required ${VITEST_CHECK_NAME} pending sulla HEAD`;
    return { allow: false, reason };
  }
  if (selection.state === RUN_SELECTION_STATES.AMBIGUOUS || !selection.run) {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} non verificabile sulla HEAD` };
  }
  if (selection.run.head_sha !== head) {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} assente sulla HEAD` };
  }
  if (selection.run.conclusion !== 'success') {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} conclusion=${selection.run.conclusion}` };
  }
  return { allow: true, reason: `${VITEST_CHECK_NAME} success sulla HEAD` };
}

function latestRequiredVitestCheck(checkRuns, head) {
  const selection = latestCompletedRunSelectionByName(checkRuns, VITEST_CHECK_NAME);
  return selection.state === RUN_SELECTION_STATES.SELECTED
    && selection.run?.head_sha === head
    ? selection.run
    : null;
}

function validTimestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function reviewIdKey(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return '';
}

/** Parse the only URL shape from which this gate may discover its job. */
export function parseActionsJobUrl(value, repo) {
  if (typeof value !== 'string' || typeof repo !== 'string' || !repo) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  // Canonical raw form only: `new URL` resolves dot-segments (also `%2e%2e`),
  // strips tab/newline and accepts userinfo/port, so the parsed run id could
  // differ from the stored text. Query/fragment stay accepted. Same rule as
  // `workflowRunIdentity` in native-automerge-sweep-policy.mjs, tied by
  // generator/tests/actions-details-url-canonical.test.mjs.
  if (/\s/.test(value) || value.split(/[?#]/, 1)[0] !== `https://github.com${url.pathname}`) {
    return null;
  }
  const match = url.pathname.match(
    /^\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)$/u,
  );
  if (!match || match[1] !== repo) return null;
  const runId = Number(match[2]);
  const jobId = Number(match[3]);
  if (!validPositiveInteger(runId) || !validPositiveInteger(jobId)) return null;
  return { runId, jobId };
}

function parseActionsCheckRunUrl(value, repo) {
  if (typeof value !== 'string' || typeof repo !== 'string' || !repo) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') return null;
  const match = url.pathname.match(
    /^\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)\/?$/u,
  );
  if (!match || match[1] !== repo) return null;
  const checkRunId = Number(match[2]);
  return validPositiveInteger(checkRunId) ? checkRunId : null;
}

/**
 * Verify the structured proof used only for the outside-diff exception.
 * Every layer is required: a green check or a green step alone is not proof.
 * The review identity is also checked here so an ordinary Actions review
 * cannot reach this exception without the exact Codex fallback marker.
 */
export function reviewGateEvidenceDecision({
  evidence,
  repo,
  head,
  review,
} = {}) {
  const deny = (reason) => ({ allow: false, reason });
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return deny('prova review-gate strutturata assente');
  }
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/iu.test(head)) {
    return deny('HEAD non verificabile per la prova review-gate');
  }
  const codexCarryForward = isCodexCarryForwardCandidate(review, head);
  if (!isManagedReview(review) || (!isReviewerBot(review?.user)
      && !isCodexFallbackReviewOnHead(review, head)
      && !codexCarryForward)) {
    return deny('identità review non autorizzata per la prova review-gate');
  }
  const reviewId = reviewIdKey(review?.id);
  if (!reviewId || evidence.reviewId !== reviewId) {
    return deny('identità della review non verificabile nella prova review-gate');
  }
  if (!['COMMENTED', 'APPROVED'].includes(String(review.state || '').toUpperCase())) {
    return deny('stato della review non approvabile nella prova review-gate');
  }

  const check = evidence.check;
  const jobLocation = parseActionsJobUrl(check?.details_url, repo);
  if (!jobLocation
      || evidence.workflow?.id !== jobLocation.runId
      || evidence.job?.id !== jobLocation.jobId) {
    return deny('identità run/job del check non verificabile');
  }
  if (!check
      || !validPositiveInteger(check.id)
      || check.name !== VITEST_CHECK_NAME
      || check.head_sha !== head
      || check.status !== 'completed'
      || check.conclusion !== 'success'
      || validTimestamp(check.completed_at) === null) {
    return deny('check vitest della prova review-gate non verificabile');
  }

  const workflow = evidence.workflow;
  if (!workflow
      || !validPositiveInteger(workflow.id)
      || workflow.path !== TESTS_WORKFLOW_PATH
      || workflow.event !== TESTS_WORKFLOW_EVENT
      || workflow.status !== 'completed'
      || workflow.conclusion !== 'success'
      || workflow.head_sha !== head
      || validTimestamp(workflow.run_started_at) === null
      || validTimestamp(workflow.updated_at) === null) {
    return deny('workflow tests della prova review-gate non verificabile');
  }

  const job = evidence.job;
  const checkRunId = parseActionsCheckRunUrl(job?.check_run_url, repo);
  if (!job
      || !validPositiveInteger(job.id)
      || job.run_id !== workflow.id
      || job.name !== VITEST_CHECK_NAME
      || job.status !== 'completed'
      || job.conclusion !== 'success'
      || job.head_sha !== head
      || checkRunId !== check.id
      || validTimestamp(job.started_at) === null
      || validTimestamp(job.completed_at) === null
      || !Array.isArray(job.steps)) {
    return deny('job tests della prova review-gate non verificabile');
  }

  const steps = job.steps.filter((step) => REVIEW_GATE_STEP_NAMES.includes(step?.name));
  if (steps.length !== 1) return deny('step review-gate assente o ambiguo');
  const step = steps[0];
  const reviewAt = reviewFreshnessTimestamp(review);
  const stepStartedAt = validTimestamp(step.started_at);
  const stepCompletedAt = validTimestamp(step.completed_at);
  const checkCompletedAt = validTimestamp(check.completed_at);
  const jobStartedAt = validTimestamp(job.started_at);
  const jobCompletedAt = validTimestamp(job.completed_at);
  const workflowStartedAt = validTimestamp(workflow.run_started_at);
  const workflowUpdatedAt = validTimestamp(workflow.updated_at);
  if (step.status !== 'completed'
      || step.conclusion !== 'success'
      || reviewAt === null
      || stepStartedAt === null
      || stepCompletedAt === null
      || checkCompletedAt === null
      || jobStartedAt === null
      || jobCompletedAt === null
      || workflowStartedAt === null
      || workflowUpdatedAt === null) {
    return deny('step review-gate senza un verdetto temporale completo');
  }
  if (!(reviewAt <= stepStartedAt
      && workflowStartedAt <= jobStartedAt
      && jobStartedAt <= stepStartedAt
      && stepStartedAt <= stepCompletedAt
      && stepCompletedAt <= jobCompletedAt
      && jobCompletedAt <= checkCompletedAt
      && checkCompletedAt <= workflowUpdatedAt)) {
    return deny('ordine temporale review-gate non verificabile');
  }

  const verified = {
    allow: true,
    reason: `step ${step.name} successivo alla review raw sulla stessa HEAD`,
    runId: workflow.id,
    jobId: job.id,
    checkId: check.id,
    reviewId,
  };
  if (!codexCarryForward) return verified;
  const carry = codexCarryForwardDecision({
    evidence,
    repo,
    head,
    review,
    steps: job.steps,
    gateStartedAt: stepStartedAt,
    reviewAt,
  });
  if (!carry.allow) return deny(`carry-forward Codex non verificato: ${carry.reason}`);
  return { ...verified, reason: carry.reason, codexCarryForward: true };
}

/**
 * The extra proof a Codex fallback LGTM on an earlier commit needs (#1870).
 *
 * The caller has already bound the evidence to the latest green `tests` run
 * of the current HEAD and to a review gate step that started after this
 * review. That alone does not show that the run carried THIS review: the gate
 * step picks the latest review for the body revision of its own run, and a
 * green check says nothing about why Codex did not run again. Every layer
 * below comes from data the native gate reads itself; no free-form text is
 * trusted:
 *
 *   - the review is a clean `## LGTM` without `🔴 Important`;
 *   - its only `REVIEW_INPUT_REVISION` marker is the digest of the CURRENT PR
 *     body, and that body was last edited before the review gate step started,
 *     so it is also the revision the run verified (the gate re-reads the body
 *     and fails on a mismatch);
 *   - the `Re-review guard` succeeded after the review existed, and its skip
 *     is visible in the Jobs API: the claim step is `skipped` only when the
 *     guard wrote `skip=true`, and the Codex and abort steps did not run;
 *   - the reviewed commit itself has a green `tests` check completed after the
 *     review, the durable proof the guard and the review gate also require.
 *
 * The contribution fingerprint is computed by the trusted `tests.yml` guard and
 * review gate; the proof above shows that both accepted this review on this
 * HEAD. Anything missing, ambiguous or out of order is a deny.
 */
function codexCarryForwardDecision({
  evidence,
  repo,
  head,
  review,
  steps,
  gateStartedAt,
  reviewAt,
} = {}) {
  const deny = (reason) => ({ allow: false, reason });
  if (!reviewHasZeroFindings(review.body) || !reviewHasLgtm(review.body)) {
    return deny('la review non è una LGTM senza 🔴 Important');
  }

  const input = evidence.pullRequest;
  const currentRevision = normalizeReviewInputRevision(input?.reviewRevision);
  if (!input || typeof input !== 'object'
      || String(input.headSha || '').toLowerCase() !== head.toLowerCase()
      || !currentRevision) {
    return deny('revisione del body PR corrente non verificabile');
  }
  if (!reviewHasInputRevision(review.body, currentRevision)) {
    return deny('REVIEW_INPUT_REVISION della review diversa dal body PR corrente');
  }
  if (!Object.hasOwn(input, 'lastEditedAt')) {
    return deny('ultima modifica del body PR non verificabile');
  }
  if (input.lastEditedAt !== null) {
    const editedAt = validTimestamp(input.lastEditedAt);
    if (editedAt === null || !(editedAt < gateStartedAt)) {
      return deny('body PR modificato dopo l’inizio del review gate');
    }
  }

  const single = (name) => {
    const matches = steps.filter((step) => step?.name === name);
    return matches.length === 1 ? matches[0] : null;
  };
  const guard = single(REVIEW_GUARD_STEP_NAME);
  const skippedSteps = [REVIEW_CLAIM_STEP_NAME, CODEX_REVIEW_STEP_NAME, REVIEW_ABORT_STEP_NAME]
    .map(single);
  if (!guard || skippedSteps.some((step) => !step)) {
    return deny('step del re-review guard assenti o ambigui');
  }
  const guardStartedAt = validTimestamp(guard.started_at);
  const guardCompletedAt = validTimestamp(guard.completed_at);
  if (guard.status !== 'completed'
      || guard.conclusion !== 'success'
      || guardStartedAt === null
      || guardCompletedAt === null
      || !(reviewAt <= guardStartedAt
        && guardStartedAt <= guardCompletedAt
        && guardCompletedAt <= gateStartedAt)) {
    return deny('re-review guard non riuscito dopo la review e prima del review gate');
  }
  const ran = skippedSteps.find((step) => step.status !== 'completed' || step.conclusion !== 'skipped');
  if (ran) {
    return deny(`lo step «${ran.name}» non è skipped: il guard non ha saltato Codex`);
  }

  const reviewedAt = reviewTimestamp(review);
  const reviewedCommitAccepted = reviewedAt !== null
    && Array.isArray(evidence.reviewedCommitChecks)
    && evidence.reviewedCommitChecks.some((check) => {
      const completedAt = validTimestamp(check?.completed_at);
      return check?.name === VITEST_CHECK_NAME
        && check.head_sha === review.commit_id
        && check.status === 'completed'
        && check.conclusion === 'success'
        && parseActionsJobUrl(check.details_url, repo) !== null
        && completedAt !== null
        && completedAt >= reviewedAt;
    });
  if (!reviewedCommitAccepted) {
    return deny(`nessun ${VITEST_CHECK_NAME} verde sul commit della review dopo la review`);
  }

  return {
    allow: true,
    reason: `LGTM carry-forward Codex da ${review.commit_id.slice(0, 12)}: guard senza Codex e review gate verde sulla stessa revisione body`,
  };
}

/** Pure decision function used by the workflow and deterministic tests. */
export function evaluateNativeAutoMerge({
  pr,
  reviews,
  checkRuns,
  verifiedTestOnlyReview = null,
  reviewGateEvidence = null,
  repository = null,
} = {}) {
  if (!pr || pr.state !== 'OPEN' || pr.isDraft !== false || pr.baseRefName !== 'main') {
    return { allow: false, reason: 'PR non aperta, draft o non basata su main' };
  }
  if (typeof pr.headRefOid !== 'string' || !pr.headRefOid) {
    return { allow: false, reason: 'HEAD SHA mancante' };
  }
  if (!Object.hasOwn(pr, 'autoMergeRequest')) {
    return { allow: false, reason: 'stato auto-merge non verificabile' };
  }
  if (pr.autoMergeRequest !== null) {
    return { allow: false, reason: 'native auto-merge già abilitato' };
  }

  // The required check is the complete `tests` job. Its review gate already
  // applies the repository's fingerprint-based carry-forward policy, so the
  // native helper must not reject a valid older LGTM merely because the PR
  // received a data-only or otherwise review-preserving commit afterward.
  // A Codex fallback LGTM gets the same outcome only with the structured
  // carry-forward proof checked by `codexCarryForwardDecision` (#1870).
  const review = latestReviewGateCandidate(reviews, pr.headRefOid);
  const testOnlyApproval = !review
    && testOnlyReviewIsApproved(verifiedTestOnlyReview, pr.headRefOid);
  if (!review && !testOnlyApproval) {
    return { allow: false, reason: 'nessuna review bot verificabile' };
  }
  const reviewGateException = review && !reviewIsApproved(review)
    ? reviewGateEvidenceDecision({
      evidence: reviewGateEvidence,
      repo: repository,
      head: pr.headRefOid,
      review,
    })
    : { allow: false, reason: 'review raw già approvante' };
  if (review && !reviewIsApproved(review) && !reviewGateException.allow) {
    if (isCodexCarryForwardCandidate(review, pr.headRefOid)) {
      return {
        allow: false,
        reason: `review Codex su ${String(review.commit_id).slice(0, 12)} non riportabile sulla HEAD — ${reviewGateException.reason}`,
      };
    }
    return { allow: false, reason: 'review bot sulla HEAD non è LGTM senza 🔴 Important' };
  }

  const check = requiredVitestDecision(checkRuns, pr.headRefOid);
  if (!check.allow) return check;
  if (reviewGateException.allow) {
    const latestCheck = latestRequiredVitestCheck(checkRuns, pr.headRefOid);
    if (!latestCheck || latestCheck.id !== reviewGateException.checkId) {
      return { allow: false, reason: 'prova review-gate non legata al check vitest più recente' };
    }
  }
  const approval = review || verifiedTestOnlyReview;
  const reviewScope = testOnlyApproval
    ? 'tests-only review verificata sul current HEAD'
    : reviewGateException.codexCarryForward
    ? reviewGateException.reason
    : reviewGateException.allow
    ? 'review-gate outside-diff verificato sulla stessa HEAD'
    : review.commit_id === pr.headRefOid
    ? 'review exact-head'
    : 'LGTM carry-forward verificato dal check required';
  return {
    allow: true,
    reason: `${reviewScope} ✔; ${check.reason}`,
    reviewId: approval.id,
  };
}

/**
 * Revalidate the current review/check pair even when GitHub already has an
 * auto-merge request. Native auto-merge survives `synchronize`, so the
 * persisted opt-in is not evidence that the new HEAD was reviewed or tested.
 *
 * `action` is deliberately explicit for the side-effecting CLI:
 *   - `enable`: no request exists and the review/check gate passed;
 *   - `retain`: a request exists and the review/check gate passed again;
 *   - `revoke`: a request exists but the fresh gate failed;
 *   - `skip`: no request exists and the gate is not yet satisfied.
 */
export function revalidateNativeAutoMerge({
  pr,
  reviews,
  checkRuns,
  verifiedTestOnlyReview = null,
  reviewGateEvidence = null,
  repository = null,
} = {}) {
  if (!pr || !Object.hasOwn(pr, 'autoMergeRequest')) {
    return { allow: false, action: 'skip', reason: 'stato auto-merge non verificabile' };
  }
  const decision = evaluateNativeAutoMerge({
    pr: { ...pr, autoMergeRequest: null },
    reviews,
    checkRuns,
    verifiedTestOnlyReview,
    reviewGateEvidence,
    repository,
  });
  if (pr.autoMergeRequest !== null) {
    return {
      ...decision,
      action: decision.allow ? 'retain' : 'revoke',
    };
  }
  return {
    ...decision,
    action: decision.allow ? 'enable' : 'skip',
  };
}

function ghRaw(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
}

function ghJson(args) {
  return JSON.parse(ghRaw(args));
}

function sleepForTransientReadRetry(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, delayMs);
}

function transientGithubErrorText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''))
    .filter(Boolean)
    .join('\n');
}

export function isTransientGithubReadError(error) {
  return TRANSIENT_GH_READ_ERROR_RE.test(transientGithubErrorText(error));
}

/** Retry only idempotent GitHub reads; mutations remain single-attempt and fail closed. */
export function withTransientGithubReadRetry(operation, {
  maxAttempts = MAX_TRANSIENT_GH_READ_ATTEMPTS,
  delaysMs = TRANSIENT_GH_READ_RETRY_DELAYS_MS,
  sleep = sleepForTransientReadRetry,
} = {}) {
  if (typeof operation !== 'function') throw new TypeError('read retry operation must be a function');
  const attempts = Number.isSafeInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : MAX_TRANSIENT_GH_READ_ATTEMPTS;
  const delays = Array.isArray(delaysMs) ? delaysMs : TRANSIENT_GH_READ_RETRY_DELAYS_MS;
  const wait = typeof sleep === 'function' ? sleep : sleepForTransientReadRetry;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (attempt + 1 >= attempts || !isTransientGithubReadError(error)) throw error;
      const delayMs = Number(delays[attempt]);
      if (Number.isFinite(delayMs) && delayMs > 0) wait(delayMs);
    }
  }
  throw new Error('read retry exhausted without an attempt');
}

function ghReadJson(args) {
  return JSON.parse(withTransientGithubReadRetry(() => ghRaw(args)));
}

// `review-test-policy` needs both parsed GitHub responses and raw newline
// output for the paginated REST file list. Keep this adapter local so the
// native gate remains fail-closed without changing the shared gh helper.
function ghForTestOnlyReview(args, options = {}) {
  const output = withTransientGithubReadRetry(() => ghRaw(args));
  return options.json === false ? output : JSON.parse(output);
}

function loadVerifiedTestOnlyReview(repo, pr, head, reviews) {
  return findTestOnlyApproval(reviews, head, {
    ghFn: ghForTestOnlyReview,
    repo,
    pr,
  });
}

const REVIEW_METADATA_QUERY = [
  'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){',
  'repository(owner:$owner,name:$name){pullRequest(number:$number){',
  'reviews(first:100,after:$endCursor){nodes{',
  'id databaseId createdAt submittedAt updatedAt',
  '}pageInfo{hasNextPage endCursor}}}}}',
].join('');

function loadReviewMetadata(repo, pr) {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) throw new Error('repository non valido per la metadata review');
  const pages = ghReadJson([
    'api', 'graphql', '--paginate', '--slurp',
    '-f', `query=${REVIEW_METADATA_QUERY}`,
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `number=${pr}`,
  ]);
  return flattenPages(pages)
    .flatMap((page) => page?.data?.repository?.pullRequest?.reviews?.nodes || []);
}

function loadReviews(repo, pr) {
  const reviews = flattenPages(ghReadJson([
    'api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate', '--slurp',
  ]));
  const metadataById = new Map();
  for (const metadata of loadReviewMetadata(repo, pr)) {
    if (metadata?.databaseId !== null && metadata?.databaseId !== undefined) {
      metadataById.set(String(metadata.databaseId), metadata);
    }
    if (metadata?.id) metadataById.set(String(metadata.id), metadata);
  }
  return reviews.map((review) => {
    const metadata = metadataById.get(String(review?.id))
      || metadataById.get(String(review?.node_id));
    if (!metadata) {
      throw new Error(`metadata temporale mancante per review ${review?.id || 'sconosciuta'}`);
    }
    return {
      ...review,
      created_at: metadata.createdAt || review.created_at,
      submitted_at: metadata.submittedAt || review.submitted_at,
      updated_at: metadata.updatedAt || review.updated_at,
    };
  });
}

/**
 * `filter=all` keeps every attempt: GitHub's default `latest` view hides a
 * green attempt once the same check is rerun, and the reviewed-commit proof of
 * the Codex carry-forward needs that durable history (same reading as
 * `codexReviewWasPreviouslyAccepted` in review-gate.mjs).
 */
function loadCheckRuns(repo, sha, { allAttempts = false } = {}) {
  const query = allAttempts ? 'per_page=100&filter=all' : 'per_page=100';
  const pages = ghReadJson([
    'api', `repos/${repo}/commits/${sha}/check-runs?${query}`, '--paginate', '--slurp',
  ]);
  return (Array.isArray(pages) ? pages : [pages])
    .flatMap((page) => Array.isArray(page?.check_runs) ? page.check_runs : []);
}

const PR_LAST_EDITED_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){lastEditedAt}}}';

/**
 * Inputs only the Codex carry-forward needs (#1870). The REST body is read
 * BEFORE `lastEditedAt`: an edit landing between the two reads then shows up
 * as a late `lastEditedAt` and is denied, instead of pairing an old body with
 * an old edit time. The body digest is the one `tests.yml` and
 * `review-gate.mjs` compute (`reviewInputContextFromPullRequest`).
 */
function loadCodexCarryForwardInputs(repo, prNumber, review) {
  const context = reviewInputContextFromPullRequest(ghReadJson([
    'api', `repos/${repo}/pulls/${prNumber}`,
  ]));
  const [owner, name] = String(repo).split('/');
  const response = ghReadJson([
    'api', 'graphql',
    '-f', `query=${PR_LAST_EDITED_QUERY}`,
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `number=${prNumber}`,
  ]);
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error(response.errors.map((error) => error.message || String(error)).join('; '));
  }
  const pullRequest = response?.data?.repository?.pullRequest;
  const pullRequestInput = context
    ? { headSha: context.headSha, reviewRevision: context.reviewRevision }
    : null;
  if (pullRequestInput && pullRequest && Object.hasOwn(pullRequest, 'lastEditedAt')) {
    pullRequestInput.lastEditedAt = pullRequest.lastEditedAt;
  }
  return {
    pullRequest: pullRequestInput,
    reviewedCommitChecks: loadCheckRuns(repo, review.commit_id, { allAttempts: true }),
  };
}

function loadReviewGateEvidence(repo, prNumber, head, checkRuns, review) {
  if (!review || reviewIsApproved(review)) return null;
  const checkDecision = requiredVitestDecision(checkRuns, head);
  if (!checkDecision.allow) return null;
  const check = latestRequiredVitestCheck(checkRuns, head);
  const location = parseActionsJobUrl(check?.details_url, repo);
  if (!check || !location || !reviewIdKey(review.id)) return null;
  const workflow = ghReadJson([
    'api', `repos/${repo}/actions/runs/${location.runId}`,
  ]);
  const job = ghReadJson([
    'api', `repos/${repo}/actions/jobs/${location.jobId}`,
  ]);
  const evidence = {
    reviewId: reviewIdKey(review.id),
    check,
    workflow,
    job,
  };
  if (!isCodexCarryForwardCandidate(review, head)) return evidence;
  return { ...evidence, ...loadCodexCarryForwardInputs(repo, prNumber, review) };
}

const DISABLE_AUTO_MERGE_MUTATION =
  'mutation($pullRequestId:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId}){pullRequest{number autoMergeRequest{enabledAt}}}}';

function disableNativeAutoMerge(repo, pr) {
  if (!pr?.id) throw new Error('node ID della PR mancante');
  const response = ghJson([
    'api', 'graphql',
    '-f', `query=${DISABLE_AUTO_MERGE_MUTATION}`,
    '-F', `pullRequestId=${pr.id}`,
  ]);
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error(response.errors.map((error) => error.message || String(error)).join('; '));
  }
  const request = response?.data?.disablePullRequestAutoMerge?.pullRequest;
  if (!request || request.autoMergeRequest !== null) {
    throw new Error('GitHub non ha confermato la revoca dell’auto-merge');
  }
}

function revokeExistingAutoMerge(repo, pr, reason) {
  try {
    disableNativeAutoMerge(repo, pr);
    console.log(`Native auto-merge guard: opt-in revocato per PR #${pr.number} — ${reason}`);
  } catch (error) {
    console.error(`::error::native auto-merge guard: revoca opt-in fallita per PR #${pr.number}: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
  }
}

function skip(reason) {
  console.log(`Native auto-merge guard: ${reason} — nessun merge.`);
}

/** Bind the native opt-in to the exact HEAD that passed the gate. */
export function nativeAutoMergeArgs({ repo, prNumber, headSha } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(headSha || '')) {
    throw new Error('HEAD SHA verificato mancante o non valido');
  }
  return [
    'pr', 'merge', prNumber, '--repo', repo, '--auto', '--squash', '--delete-branch',
    '--match-head-commit', headSha,
  ];
}

/** GitHub returns this when a concurrent guard already enabled the request. */
export function isAlreadyInProgressOutput(value) {
  return /merge already in progress/i.test(String(value || ''));
}

function capturedErrorOutput(error) {
  return [error?.stderr, error?.stdout]
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''))
    .filter(Boolean)
    .join('\n');
}

/** Confirm that a concurrent opt-in achieved the intended state before going green. */
function concurrentOptInSucceeded(repo, prNumber, expectedHead) {
  try {
    const observed = ghReadJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'state,headRefOid,autoMergeRequest']);
    if (observed.state === 'MERGED') return true;
    return observed.state === 'OPEN'
      && observed.headRefOid === expectedHead
      && observed.autoMergeRequest !== null;
  } catch {
    return false;
  }
}

function main() {
  const repo = process.argv[2] || process.env.REPOSITORY || process.env.GITHUB_REPOSITORY || '';
  const prNumber = process.argv[3] || process.env.PR_NUMBER || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(prNumber)) {
    return skip('target PR mancante o non valido');
  }

  let pr;
  try {
    pr = ghReadJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'number,id,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    console.error(`::error::native auto-merge guard: impossibile leggere PR #${prNumber}: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  if (pr.state !== 'OPEN' || pr.isDraft !== false || pr.baseRefName !== 'main') {
    return skip('PR non aperta, draft o non basata su main');
  }
  const hadAutoMerge = pr.autoMergeRequest !== null;

  let reviews;
  let checkRuns;
  let verifiedTestOnlyReview;
  let reviewGateEvidence;
  try {
    reviews = loadReviews(repo, prNumber);
    checkRuns = loadCheckRuns(repo, pr.headRefOid);
    verifiedTestOnlyReview = loadVerifiedTestOnlyReview(repo, prNumber, pr.headRefOid, reviews);
    reviewGateEvidence = loadReviewGateEvidence(
      repo,
      prNumber,
      pr.headRefOid,
      checkRuns,
      latestReviewGateCandidate(reviews, pr.headRefOid),
    );
  } catch (error) {
    if (hadAutoMerge) {
      revokeExistingAutoMerge(repo, pr, 'review/check non leggibili');
      return;
    }
    console.error(`::error::native auto-merge guard: lettura review/check fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

  const decision = revalidateNativeAutoMerge({
    pr,
    reviews,
    checkRuns,
    verifiedTestOnlyReview,
    reviewGateEvidence,
    repository: repo,
  });
  console.log(`Native auto-merge guard PR #${prNumber} HEAD=${pr.headRefOid}: ${decision.reason}`);
  if (decision.action === 'revoke') {
    revokeExistingAutoMerge(repo, pr, `fresh gate fallito: ${decision.reason}`);
    return;
  }
  if (!decision.allow) return;

  // Close the head race between the reads and the native opt-in. A new HEAD
  // invalidates the review/check snapshot and must be re-evaluated.
  let current;
  try {
    current = ghReadJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'number,id,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    console.error(`::error::native auto-merge guard: conferma HEAD fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  const currentStateChanged = current.state !== 'OPEN'
    || current.isDraft !== false
    || current.baseRefName !== 'main'
    || current.headRefOid !== pr.headRefOid;
  if (currentStateChanged) {
    if (current.state === 'OPEN' && current.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, current, 'HEAD o stato cambiato dopo il gate');
    }
    return skip('HEAD/stato cambiato dopo i gate; serve una nuova valutazione review/check');
  }

  // Review and checks can change without a HEAD change. Re-read them after
  // confirming the HEAD and immediately before the native opt-in; the first
  // snapshot is not enough to authorize the opt-in.
  let finalReviews;
  let finalCheckRuns;
  let finalVerifiedTestOnlyReview;
  let finalReviewGateEvidence;
  try {
    finalReviews = loadReviews(repo, prNumber);
    finalCheckRuns = loadCheckRuns(repo, current.headRefOid);
    finalVerifiedTestOnlyReview = loadVerifiedTestOnlyReview(
      repo,
      prNumber,
      current.headRefOid,
      finalReviews,
    );
    finalReviewGateEvidence = loadReviewGateEvidence(
      repo,
      prNumber,
      current.headRefOid,
      finalCheckRuns,
      latestReviewGateCandidate(finalReviews, current.headRefOid),
    );
  } catch (error) {
    if (current.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, current, 'review/check non leggibili prima dell’opt-in');
      return;
    }
    console.error(`::error::native auto-merge guard: rilettura review/check fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

  const finalDecision = revalidateNativeAutoMerge({
    pr: current,
    reviews: finalReviews,
    checkRuns: finalCheckRuns,
    verifiedTestOnlyReview: finalVerifiedTestOnlyReview,
    reviewGateEvidence: finalReviewGateEvidence,
    repository: repo,
  });
  console.log(`Native auto-merge guard PR #${prNumber} final gate: ${finalDecision.reason}`);
  if (finalDecision.action === 'revoke') {
    revokeExistingAutoMerge(repo, current, `fresh gate finale fallito: ${finalDecision.reason}`);
    return;
  }
  if (!finalDecision.allow) {
    return skip('review/check cambiati o non più validi prima dell’opt-in; nessun merge.');
  }
  if (current.autoMergeRequest !== null) {
    return skip('native auto-merge già abilitato e rivalidato sulla HEAD corrente');
  }

  try {
    const output = execFileSync('gh', nativeAutoMergeArgs({ repo, prNumber, headSha: pr.headRefOid }), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (output) process.stdout.write(output);
  } catch (error) {
    const details = capturedErrorOutput(error);
    if (isAlreadyInProgressOutput(details)
      && concurrentOptInSucceeded(repo, prNumber, pr.headRefOid)) {
      console.log(`Native auto-merge guard: opt-in concorrente confermato per PR #${prNumber} sulla HEAD corrente`);
      return;
    }
    console.error(`::error::native auto-merge opt-in fallito: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) main();
