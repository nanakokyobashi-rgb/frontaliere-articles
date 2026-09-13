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
} from '../../scripts/ci/review-claim.mjs';

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
  assert.equal(claimStatusFromOutcome({ proceed: true, retryableFailure: true }), 'failed-transient');
  assert.equal(claimStatusFromOutcome({
    proceed: true,
    claudeOutcome: 'failure',
    executionText: '{"is_error":true,"api_error_status":429}',
  }), 'failed-transient');
  assert.equal(claimStatusFromOutcome({ proceed: true, permanentFailure: true }), 'failed-terminal');
  assert.equal(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'success' }), 'completed');
});

test('tests.yml claims before review work and finalizes without gating the required verdict', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /Reviews API illeggibile/);
  assert.match(workflow, /same_head/);
  assert.match(workflow, /scripts\/ci\/review-claim\.mjs --claim/);
  assert.match(workflow, /CLAIM_ACTION: acquire/);
  assert.match(workflow, /CLAIM_ACTION: finalize/);
  assert.match(workflow, /CLAIM_KIND: review/);
  assert.match(workflow, /CONTRIBUTION_FINGERPRINT:/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, edited\]/);
  assert.match(workflow, /BODY_EDITED:/);
  assert.match(workflow, /review_revision=body:/);
  assert.match(workflow, /REVIEW_REVISION:/);
  assert.match(workflow, /steps\.review_claim\.outputs\.claim_allowed == 'true'/);

  const gateAt = workflow.indexOf('id: review_gate');
  assert.ok(gateAt >= 0, 'review_gate must remain present');
  const gateBlock = workflow.slice(gateAt, workflow.indexOf('\n      - name:', gateAt + 1));
  assert.match(gateBlock, /always\(\)/);
  assert.doesNotMatch(gateBlock, /review_claim\.outputs\.claim_allowed/);
});
