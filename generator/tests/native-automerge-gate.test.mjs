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
  isTransientGithubReadError,
  withTransientGithubReadRetry,
  REVIEW_GATE_STEP_NAMES,
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
  const stale = evaluateNativeAutoMerge({
    pr: pr(),
    reviews: [review(CLEAN_BODY, OLD_HEAD)],
    checkRuns: [check()],
  });
  assert.equal(stale.allow, false);
  assert.match(stale.reason, /nessuna review bot verificabile/);
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

test('ritenta solo letture GitHub transitorie con un limite esplicito', () => {
  const transient = Object.assign(new Error('gh failed'), {
    stderr: 'HTTP 503: 503 Service Unavailable',
  });
  const permanent = Object.assign(new Error('gh failed'), {
    stderr: 'HTTP 403: 403 Forbidden',
  });
  const sleeps = [];
  let attempts = 0;

  const result = withTransientGithubReadRetry(() => {
    attempts += 1;
    if (attempts < 3) throw transient;
    return 'ok';
  }, { sleep: (delayMs) => sleeps.push(delayMs) });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [250, 750]);
  assert.equal(isTransientGithubReadError(transient), true);
  assert.equal(isTransientGithubReadError(permanent), false);
});

test('lascia fail-closed un errore GitHub permanente senza ritentarlo', () => {
  const permanent = Object.assign(new Error('gh failed'), {
    stderr: 'HTTP 403: 403 Forbidden',
  });
  let attempts = 0;

  assert.throws(() => withTransientGithubReadRetry(() => {
    attempts += 1;
    throw permanent;
  }, { sleep: () => undefined }), /gh failed/);
  assert.equal(attempts, 1);
});

test('il gate resta compatibile durante il rename Claude → Codex', () => {
  assert.deepEqual(REVIEW_GATE_STEP_NAMES, [
    'Require approving Claude review',
    'Require approving Codex review',
  ]);
});
