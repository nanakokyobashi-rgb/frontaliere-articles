import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  claimStatusFromOutcome,
  latestReviewClaims,
  parseReviewClaim,
  reviewClaimDecision,
  reviewClaimDedupeKey,
  reviewClaimKey,
  reviewWasPosted,
} from '../../scripts/ci/review-claim.mjs';
import {
  normalizeReviewInputRevision,
  reviewInputContextFromPullRequest,
  reviewInputContextMatches,
  reviewHasInputRevision,
  reviewInputRevisionMarker,
} from '../../scripts/ci/review-test-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const FINGERPRINT = 'c'.repeat(64);
const BODY_REVISION = `body:${'d'.repeat(64)}`;
const OTHER_BODY_REVISION = `body:${'e'.repeat(64)}`;

function claim(overrides = {}) {
  const context = {
    prNumber: '8364',
    headSha: HEAD,
    eventKey: 'run:42',
    contributionFingerprint: FINGERPRINT,
  };
  return {
    version: 1,
    token: 'review-claim-token',
    ...context,
    key: reviewClaimKey(context),
    dedupeKey: reviewClaimDedupeKey(context),
    state: 'active',
    issuedAt: 100,
    expiresAt: 3_700,
    runId: '77',
    ...overrides,
  };
}

function comment(event, id = 1) {
  return {
    id,
    created_at: '1970-01-01T00:02:00Z',
    user: { login: 'github-actions[bot]' },
    body: `<!-- PR_REVIEW_CLAIM: ${JSON.stringify(event)} -->`,
  };
}

test('keys the exact PR + HEAD + event/verdict while coalescing one contribution', () => {
  const base = {
    prNumber: '8364',
    headSha: HEAD,
    contributionFingerprint: FINGERPRINT,
  };
  const first = reviewClaimKey({ ...base, eventKey: 'run:42' });
  const retry = reviewClaimKey({ ...base, eventKey: 'run:43' });
  const otherHead = reviewClaimKey({ ...base, headSha: NEXT_HEAD, eventKey: 'run:42' });
  const otherContribution = reviewClaimKey({ ...base, contributionFingerprint: 'd'.repeat(64), eventKey: 'run:42' });

  assert.notEqual(first, '');
  assert.notEqual(retry, first);
  assert.equal(
    reviewClaimDedupeKey({ ...base, eventKey: 'run:42' }),
    reviewClaimDedupeKey({ ...base, eventKey: 'run:43' }),
  );
  assert.notEqual(otherHead, first);
  assert.notEqual(otherContribution, first);
  assert.equal(reviewClaimKey({ ...base, contributionFingerprint: '' }), '');
});

test('treats a corrected PR body as a new review revision without duplicating reruns', () => {
  const base = {
    prNumber: '8364',
    headSha: HEAD,
    eventKey: 'run:42',
    contributionFingerprint: FINGERPRINT,
  };
  const first = reviewClaimDedupeKey({ ...base, reviewRevision: BODY_REVISION });
  const retry = reviewClaimDedupeKey({ ...base, reviewRevision: BODY_REVISION });
  const corrected = reviewClaimDedupeKey({ ...base, reviewRevision: OTHER_BODY_REVISION });

  assert.equal(first, retry);
  assert.notEqual(first, corrected);
  assert.match(first, /revision:body:[a-f0-9]{64}$/);
  assert.equal(reviewClaimDedupeKey(base), reviewClaimDedupeKey({ ...base, reviewRevision: '' }));
});

test('a terminal claim for the old body does not block the corrected body revision', () => {
  const oldContext = {
    prNumber: '8364',
    headSha: HEAD,
    eventKey: 'run:42',
    contributionFingerprint: FINGERPRINT,
    reviewRevision: BODY_REVISION,
  };
  const newContext = { ...oldContext, eventKey: 'run:43', reviewRevision: OTHER_BODY_REVISION };
  assert.deepEqual(
    reviewClaimDecision({
      key: reviewClaimKey(newContext),
      dedupeKey: reviewClaimDedupeKey(newContext),
      claims: [{
        ...claim({ state: 'failed-terminal' }),
        key: reviewClaimKey(oldContext),
        dedupeKey: reviewClaimDedupeKey(oldContext),
        reviewRevision: BODY_REVISION,
      }],
      nowSec: 200,
    }),
    { allowed: true, exists: false, reason: 'same-pr-head-claim-retryable' },
  );
});

test('the review input snapshot binds normalized HEAD and exact body revision', () => {
  const body = '## Implementato\n- fix\n';
  const context = reviewInputContextFromPullRequest({
    body,
    head: { sha: HEAD.toUpperCase() },
  });
  assert.equal(context?.headSha, HEAD);
  assert.match(context?.reviewRevision || '', /^body:[a-f0-9]{64}$/);
  assert.equal(reviewInputContextMatches(context, {
    headSha: HEAD.toUpperCase(),
    reviewRevision: context.reviewRevision.toUpperCase(),
  }), true);
  assert.equal(reviewInputContextFromPullRequest({ body: 42, head: { sha: HEAD } }), null);
  assert.equal(reviewInputContextFromPullRequest({ body, head: { sha: 'short' } }), null);
  assert.equal(reviewInputContextFromPullRequest({ body }), null);
});

test('rejects forged or malformed persisted markers', () => {
  assert.equal(parseReviewClaim('<!-- PR_REVIEW_CLAIM: {"version":1} -->'), null);
  assert.equal(parseReviewClaim('ordinary PR comment'), null);
  assert.deepEqual(
    parseReviewClaim(`<!-- PR_REVIEW_CLAIM: ${JSON.stringify(claim())} -->`),
    claim(),
  );
});

test('blocks active duplicates, skips terminal duplicates, and re-arms transient retries', () => {
  const active = claim();
  const input = { key: active.key, dedupeKey: active.dedupeKey };

  assert.deepEqual(
    reviewClaimDecision({
      ...input,
      claims: [active],
      nowSec: 200,
      activeRunStates: { '77': { status: 'in_progress', conclusion: null } },
    }),
    { allowed: false, exists: true, reason: 'same-pr-head-claim-active' },
  );
  assert.deepEqual(
    reviewClaimDecision({ ...input, claims: [claim({ state: 'completed' })], nowSec: 200 }),
    { allowed: false, exists: true, reason: 'same-pr-head-terminal-claim' },
  );
  assert.deepEqual(
    reviewClaimDecision({ ...input, claims: [claim({ state: 'failed-transient' })], nowSec: 200 }),
    { allowed: true, exists: true, reason: 'same-pr-head-claim-retryable' },
  );
  assert.deepEqual(
    reviewClaimDecision({
      ...input,
      claims: [active],
      nowSec: 200,
      activeRunStates: { '77': { status: 'completed', conclusion: 'cancelled' } },
    }),
    { allowed: true, exists: true, reason: 'same-pr-head-claim-retryable' },
  );
  assert.deepEqual(
    reviewClaimDecision({
      ...input,
      claims: [active],
      nowSec: 200,
      activeRunStates: { '77': { status: 'completed', conclusion: 'success' } },
    }),
    { allowed: false, exists: true, reason: 'same-pr-head-claim-active' },
  );
});

test('keeps latest state per token and does not mix a new HEAD or contribution', () => {
  const first = claim();
  const finalized = claim({ state: 'completed' });
  const newHead = claim({
    token: 'new-head-token',
    headSha: NEXT_HEAD,
    key: reviewClaimKey({
      prNumber: '8364', headSha: NEXT_HEAD, eventKey: 'run:44', contributionFingerprint: FINGERPRINT,
    }),
    dedupeKey: reviewClaimDedupeKey({
      prNumber: '8364', headSha: NEXT_HEAD, eventKey: 'run:44', contributionFingerprint: FINGERPRINT,
    }),
    eventKey: 'run:44',
  });
  const comments = [comment(first, 10), comment(finalized, 11), comment(newHead, 12)];
  const claims = latestReviewClaims(comments);

  assert.equal(claims.length, 2);
  assert.equal(claims.find((item) => item.headSha === HEAD)?.state, 'completed');
  assert.equal(claims.find((item) => item.headSha === NEXT_HEAD)?.state, 'active');
});

test('classifies setup and provider failures without consuming a retryable claim', () => {
  assert.equal(claimStatusFromOutcome({ proceed: false }), 'released');
  assert.equal(claimStatusFromOutcome({ proceed: true, reviewPosted: true }), 'completed');
  assert.equal(claimStatusFromOutcome({ proceed: true, claudeOutcome: '' }), 'failed-transient');
  assert.equal(claimStatusFromOutcome({ proceed: true, providerOutcome: 'failure' }), 'failed-terminal');
  assert.equal(claimStatusFromOutcome({ proceed: true, providerOutcome: 'cancelled' }), 'failed-transient');
  assert.equal(claimStatusFromOutcome({ proceed: true, retryableFailure: true }), 'failed-transient');
  assert.equal(claimStatusFromOutcome({
    proceed: true,
    claudeOutcome: 'failure',
    executionText: '{"is_error":true,"api_error_status":429}',
  }), 'failed-transient');
  assert.equal(claimStatusFromOutcome({ proceed: true, permanentFailure: true }), 'failed-terminal');
  assert.equal(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'success' }), 'completed');
  assert.equal(claimStatusFromOutcome({
    proceed: true,
    claudeOutcome: 'failure',
    permanentFailure: true,
    reviewFallbackApproved: true,
  }), 'completed');
});

test('a review verdict must carry exactly the current trusted body revision', () => {
  assert.equal(normalizeReviewInputRevision(` ${BODY_REVISION.toUpperCase()} `), BODY_REVISION);
  assert.equal(normalizeReviewInputRevision('body:not-a-sha'), null);

  const fresh = `review\n${reviewInputRevisionMarker(BODY_REVISION)}`;
  const stale = `review\n${reviewInputRevisionMarker(OTHER_BODY_REVISION)}`;

  assert.equal(reviewHasInputRevision(fresh, BODY_REVISION), true);
  assert.equal(reviewHasInputRevision(stale, BODY_REVISION), false);
  assert.equal(
    reviewHasInputRevision(`${fresh}\n${reviewInputRevisionMarker(OTHER_BODY_REVISION)}`, BODY_REVISION),
    false,
  );
  assert.equal(
    reviewHasInputRevision(`quoted text: ${reviewInputRevisionMarker(BODY_REVISION)}`, BODY_REVISION),
    false,
    'un marker inline nella prosa non è una riga di contratto',
  );
  assert.equal(
    reviewHasInputRevision(` ${reviewInputRevisionMarker(BODY_REVISION)}`, BODY_REVISION),
    false,
    'l indentazione cambia la riga del contratto',
  );
  assert.equal(
    reviewHasInputRevision(`## LGTM\r\n${reviewInputRevisionMarker(BODY_REVISION)}\r\n`, BODY_REVISION),
    true,
    'il marker esatto resta valido anche con terminatori CRLF',
  );
  assert.equal(reviewHasInputRevision('legacy review', ''), true);
  assert.throws(() => reviewInputRevisionMarker('body:not-a-sha'), /Invalid review input revision/);
});

test('claim finalization does not accept an old-body review on the same HEAD', () => {
  const review = (revision) => ({
    state: 'COMMENTED',
    commit_id: HEAD,
    user: { type: 'Bot', login: 'claude[bot]' },
    body: `## LGTM\n${reviewInputRevisionMarker(revision)}`,
  });
  const ghFn = (reviews) => () => JSON.stringify([[reviews]]);

  assert.equal(reviewWasPosted('owner/repo', '8364', HEAD, BODY_REVISION, ghFn(review(OTHER_BODY_REVISION))), false);
  assert.equal(reviewWasPosted('owner/repo', '8364', HEAD, BODY_REVISION, ghFn(review(BODY_REVISION))), true);
});

test('tests.yml claims before review work and finalizes without gating the required verdict', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /Reviews API illeggibile/);
  assert.match(workflow, /same_head/);
  const sameHeadStart = workflow.indexOf('same_head=');
  const sameHeadEnd = workflow.indexOf('if [ "${same_head:-0}"', sameHeadStart);
  const sameHeadGuard = workflow.slice(sameHeadStart, sameHeadEnd);
  assert.match(sameHeadGuard, /\.user\.type == "Bot"/);
  assert.match(sameHeadGuard, /test\("\^\(claude\|frontaliere-automation\)";"i"\)/);
  assert.match(sameHeadGuard, /has_single_revision/);
  assert.match(sameHeadGuard, /has_clean_lgtm/);
  assert.match(sameHeadGuard, /sort_by\(\[\(\.submitted_at \/\/ \.created_at/);
  assert.match(sameHeadGuard, /select\(\.commit_id == \$head\)\]\s*\|\s*sort_by\(/);
  assert.match(sameHeadGuard, /if length == 0 then 0/);
  assert.match(sameHeadGuard, /select\(\(\.state \/\/ ""\) != "PENDING"\)/);
  assert.match(sameHeadGuard, /\.\[-1\] \| \(\(\.state == "COMMENTED" or \.state == "APPROVED"\) and has_clean_lgtm\)/);
  const dismissedExcludedFromIncremental = /select\(\(\.state \/\/ ""\) != "PENDING" and \(\.state \/\/ ""\) != "DISMISSED"\)/g;
  assert.equal((workflow.match(dismissedExcludedFromIncremental) ?? []).length, 2);
  assert.match(workflow, /scripts\/ci\/review-claim\.mjs --claim/);
  assert.match(workflow, /CLAIM_ACTION: acquire/);
  assert.match(workflow, /CLAIM_ACTION: finalize/);
  assert.match(workflow, /CLAIM_KIND: review/);
  assert.match(workflow, /CONTRIBUTION_FINGERPRINT:/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, edited\]/);
  assert.match(workflow, /BODY_EDITED:/);
  assert.match(workflow, /review_revision=body:/);
  assert.match(workflow, /REVIEW_REVISION:/);
  assert.match(workflow, /REVIEW_INPUT_REVISION:/);
  assert.match(workflow, /has_current_revision/);
  assert.match(workflow, /--arg revision \"\$REVIEW_REVISION\"/);
  assert.match(workflow, /split\("\\n"\)\[\]/);
  assert.match(workflow, /rtrimstr\("\\r"\)/);
  assert.doesNotMatch(workflow, /contains\("<!-- REVIEW_INPUT_REVISION:/);
  assert.doesNotMatch(workflow, /scan\("<!--\\\\s\*REVIEW_INPUT_REVISION:/);
  const incrementalGuard = workflow.slice(workflow.indexOf('last=$(printf'), workflow.indexOf('if [ -z "$last"', workflow.indexOf('last=$(printf')));
  assert.match(incrementalGuard, /--arg revision \"\$REVIEW_REVISION\"/);
  assert.match(incrementalGuard, /has_current_revision\(\$revision\)/);
  assert.match(workflow, /steps\.review_claim\.outputs\.claim_allowed == 'true'/);
  assert.match(workflow, /REVIEW_GATE_FALLBACK_APPROVED:/);

  const gateAt = workflow.indexOf('id: review_gate');
  assert.ok(gateAt >= 0, 'review_gate must remain present');
  const gateBlock = workflow.slice(gateAt, workflow.indexOf('\n      - name:', gateAt + 1));
  assert.match(gateBlock, /always\(\)/);
  assert.doesNotMatch(gateBlock, /review_claim\.outputs\.claim_allowed/);
});

test('tutti i consumer di review usano la revisione del body corrente', () => {
  const autorebase = fs.readFileSync(path.join(ROOT, 'scripts/ci/pr-autorebase.mjs'), 'utf8');
  assert.match(autorebase, /currentReviewInputContext\(num\)/);
  assert.match(autorebase, /reviewInputContextFromPullRequest/);
  assert.match(autorebase, /reviewInputContextMatches/);
  assert.match(autorebase, /reviewHasInputRevision\(r\.body, reviewRevision\)/);
  assert.match(autorebase, /const reviewContext = currentReviewInputContext\(num\)/);
  assert.match(autorebase, /reviewInputContextStillCurrent\(num, head, reviewRevision\)/);
  assert.match(autorebase, /const pushedContext = currentReviewInputContext\(num\)/);
  assert.match(autorebase, /reviewInputContextStillCurrent\(num, pushedContext\.headSha, reviewRevision\)/);

  const autoMerge = fs.readFileSync(path.join(ROOT, 'scripts/ci/auto-merge-eval.mjs'), 'utf8');
  assert.match(autoMerge, /currentReviewInputContext\(\)/);
  assert.match(autoMerge, /reviewInputContextFromPullRequest/);
  assert.match(autoMerge, /reviewInputContextMatches/);
  assert.match(autoMerge, /findTestOnlyApproval\(reviews, head, \{[\s\S]*reviewRevision/);
  assert.match(autoMerge, /reviewHasInputRevision\(r\.body, reviewRevision\)/);
  assert.match(autoMerge, /reviewInputContextStillCurrent\(head, reviewRevision\)/);

  const reviewGate = fs.readFileSync(path.join(ROOT, 'scripts/ci/review-gate.mjs'), 'utf8');
  assert.match(reviewGate, /reviewInputContextFromPullRequest/);
  assert.match(reviewGate, /reviewInputContextMatches/);
  assert.match(reviewGate, /reviewInputContextStillCurrent\(\)/);
  assert.match(reviewGate, /approving && applies && codexCarryApproved[\s\S]*reviewInputContextStillCurrent/);

  const redflag = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');
  const testsWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.match(redflag, /review_revision=\"body:\$body_sha\"/);
  assert.match(redflag, /split\("\\n"\)\[\][\s\S]*REVIEW_INPUT_REVISION/);
  assert.match(redflag, /if ! gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER"\s*\\\n\s*> "\$OUT\/pr-response\.json"/);
  assert.match(redflag, /has\("body"\)/);
  assert.match(redflag, /jq '\{title, body, headRefName: \.head\.ref\}' "\$OUT\/pr-response\.json"/);
  assert.match(redflag, /if ! current_head_sha=\$\(jq -r '\.head\.sha' "\$OUT\/pr-response\.json"\)/);
  assert.match(redflag, /jq -r '\.body \/\/ ""' "\$OUT\/pr\.json" > "\$OUT\/body\.txt"/);
  assert.doesNotMatch(redflag, /if ! gh pr view/);
  const collectStart = redflag.indexOf('- name: Collect PR + review context (zero-Claude)');
  const failClosedStart = redflag.indexOf('- name: Fail closed when review context is unavailable', collectStart);
  const collect = redflag.slice(collectStart, failClosedStart);
  assert.equal((collect.match(/gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER"/g) ?? []).length, 1);
  assert.match(redflag, /La HEAD della PR è cambiata rispetto all'evento review/);
  assert.match(redflag, /github\.event\.review\.user\.type == 'Bot'/);
  assert.match(redflag, /id: precodex/);
  assert.match(redflag, /EXPECTED_BODY_REVISION: \$\{\{ steps\.ctx\.outputs\.review_revision \}\}/);
  assert.match(redflag, /EXPECTED_HEAD_SHA: \$\{\{ steps\.ctx\.outputs\.head_sha \}\}/);
  assert.match(redflag, /pr-before-claude\.json/);
  assert.match(redflag, /Il body della PR è cambiato fra prefetch e Claude/);
  assert.match(redflag, /steps\.precodex\.outputs\.verified == 'true'/);
  assert.match(testsWorkflow, /PR response is not an object/);
  assert.match(testsWorkflow, /PR body is not a string or null/);
  assert.match(redflag, /if ! reviews_json=\$\(gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER\/reviews" --paginate --slurp/);

  const stale = fs.readFileSync(path.join(ROOT, '.github/workflows/stale-pr-rescuer.yml'), 'utf8');
  const terminalReviewFilter = /select\(\(\.state \/\/ ""\) != "PENDING" and \(\.state \/\/ ""\) != "DISMISSED"\)/g;
  assert.equal((redflag.match(terminalReviewFilter) ?? []).length, 1);
  assert.equal((stale.match(terminalReviewFilter) ?? []).length, 2);
  assert.match(stale, /REVIEW_REVISION=\"body:\$body_sha\"/);
  assert.match(stale, /split\("\\n"\)\[\][\s\S]*REVIEW_INPUT_REVISION/);
});
