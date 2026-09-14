/** Gate deterministici dell'enrollment nativo, senza chiamate GitHub. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateNativeAutoMerge,
  isAlreadyInProgressOutput,
  nativeAutoMergeArgs,
  requiredVitestDecision,
  reviewHasLgtm,
  reviewHasZeroFindings,
  reviewIsApproved,
} from '../../scripts/ci/native-automerge-gate.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const CLEAN_BODY = '## Findings (Important: 0, Nit: 0)\n\n## LGTM';

const review = (body, commit_id = HEAD, submitted_at = '2026-09-13T12:00:00Z') => ({
  id: 1,
  user: { type: 'Bot', login: 'claude[bot]' },
  state: 'COMMENTED',
  body,
  commit_id,
  submitted_at,
});

const pr = (overrides = {}) => ({
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  headRefOid: HEAD,
  autoMergeRequest: null,
  ...overrides,
});

const check = (overrides = {}) => ({
  name: 'tests (node --test)',
  head_sha: HEAD,
  status: 'completed',
  conclusion: 'success',
  completed_at: '2026-09-13T12:01:00Z',
  ...overrides,
});

test('accetta solo review approvante e check verde sulla HEAD', () => {
  assert.equal(evaluateNativeAutoMerge({
    pr: pr(),
    reviews: [review(CLEAN_BODY)],
    checkRuns: [check()],
  }).allow, true);
  assert.equal(evaluateNativeAutoMerge({
    pr: pr(),
    reviews: [],
    checkRuns: [check()],
  }).allow, false);
  assert.equal(evaluateNativeAutoMerge({
    pr: pr(),
    reviews: [review(CLEAN_BODY)],
    checkRuns: [check({ conclusion: 'failure' })],
  }).allow, false);
});

test('non riusa un finding successivo e non accetta check pending o su altra HEAD', () => {
  const finding = review('## Findings (Important: 1, Nit: 0)\n\n🔴 Important: regression.\n\n## LGTM', HEAD, '2026-09-13T12:02:00Z');
  assert.equal(evaluateNativeAutoMerge({
    pr: pr(),
    reviews: [review(CLEAN_BODY), finding],
    checkRuns: [check()],
  }).allow, false);
  assert.equal(requiredVitestDecision([check({ status: 'in_progress', conclusion: null, completed_at: null })], HEAD).allow, false);
  assert.equal(requiredVitestDecision([check({ head_sha: OLD_HEAD })], HEAD).allow, false);
});

test('richiede il riepilogo esplicito e vincola l opt-in alla HEAD verificata', () => {
  assert.equal(reviewHasZeroFindings(CLEAN_BODY), true);
  assert.equal(reviewHasLgtm(CLEAN_BODY), true);
  assert.equal(reviewIsApproved(review(CLEAN_BODY)), true);
  assert.equal(reviewHasZeroFindings('## Findings (Important: 0, Nit: 1)\n\n## LGTM'), false);
  assert.deepEqual(nativeAutoMergeArgs({ repo: 'owner/repo', prNumber: '42', headSha: HEAD }), [
    'pr', 'merge', '42', '--repo', 'owner/repo', '--auto', '--squash', '--delete-branch',
    '--match-head-commit', HEAD,
  ]);
  assert.throws(() => nativeAutoMergeArgs({ repo: 'owner/repo', prNumber: '42', headSha: 'bad' }), /HEAD SHA/);
});

test('riconosce solo la risposta concorrente documentata', () => {
  assert.equal(isAlreadyInProgressOutput('GraphQL: Merge already in progress (mergePullRequest)'), true);
  assert.equal(isAlreadyInProgressOutput('GraphQL: Pull request is not mergeable'), false);
});
