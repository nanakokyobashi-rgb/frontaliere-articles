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
  reviewGateEvidenceDecision,
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
});

test('usa l ultimo verdetto sulla HEAD e non accetta check pending o su altra HEAD', () => {
  const finding = review('## Findings (Important: 1, Nit: 0)\n\n🔴 Important: regression.\n\n## LGTM', HEAD, '2026-09-13T12:02:00Z');
  assert.equal(evaluateNativeAutoMerge({
    pr: pr(),
    reviews: [review(CLEAN_BODY, HEAD, '2026-09-13T12:00:00Z'), finding],
    checkRuns: [check()],
  }).allow, false);
  assert.equal(evaluateNativeAutoMerge({
    pr: pr(),
    reviews: [finding, review(CLEAN_BODY, HEAD, '2026-09-13T12:03:00Z')],
    checkRuns: [check()],
  }).allow, true);
  assert.equal(requiredVitestDecision([check({ status: 'in_progress', conclusion: null, completed_at: null })], HEAD).allow, false);
  assert.equal(requiredVitestDecision([check({ head_sha: OLD_HEAD })], HEAD).allow, false);
});

test('un edit di una review vecchia non nasconde un Important successivo', () => {
  const clean = review(CLEAN_BODY, HEAD, '2026-09-13T12:00:00Z');
  clean.updated_at = '2026-09-13T12:03:00Z';
  const finding = review('🔴 Important: regression.', HEAD, '2026-09-13T12:02:00Z');
  assert.equal(evaluateNativeAutoMerge({
    pr: pr(),
    reviews: [clean, finding],
    checkRuns: [check()],
  }).allow, false);
});

test('la prova temporale considera anche l aggiornamento successivo della review', () => {
  const evidence = {
    reviewId: '7',
    check: {
      id: 100,
      name: 'tests (node --test)',
      details_url: 'https://github.com/owner/repo/actions/runs/200/job/300',
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-09-13T12:04:00Z',
    },
    workflow: {
      id: 200,
      path: '.github/workflows/tests.yml',
      event: 'pull_request',
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'success',
      run_started_at: '2026-09-13T12:01:00Z',
      updated_at: '2026-09-13T12:05:00Z',
    },
    job: {
      id: 300,
      run_id: 200,
      name: 'tests (node --test)',
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'success',
      check_run_url: 'https://api.github.com/repos/owner/repo/check-runs/100',
      started_at: '2026-09-13T12:02:00Z',
      completed_at: '2026-09-13T12:04:00Z',
      steps: [{
        name: 'Require approving Codex review',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-09-13T12:02:30Z',
        completed_at: '2026-09-13T12:03:30Z',
      }],
    },
  };
  const reviewBeforeEdit = {
    ...review('outside-diff finding', HEAD, '2026-09-13T12:00:00Z'),
    id: 7,
    updated_at: '2026-09-13T12:01:30Z',
  };
  assert.equal(reviewGateEvidenceDecision({
    evidence,
    repo: 'owner/repo',
    head: HEAD,
    review: reviewBeforeEdit,
  }).allow, true);

  const reviewEditedAfterGate = {
    ...reviewBeforeEdit,
    updated_at: '2026-09-13T12:03:45Z',
  };
  assert.equal(reviewGateEvidenceDecision({
    evidence,
    repo: 'owner/repo',
    head: HEAD,
    review: reviewEditedAfterGate,
  }).allow, false);
});

test('richiede il riepilogo esplicito e vincola l opt-in alla HEAD verificata', () => {
  assert.equal(reviewHasZeroFindings(CLEAN_BODY), true);
  assert.equal(reviewHasLgtm(CLEAN_BODY), true);
  assert.equal(reviewIsApproved(review(CLEAN_BODY)), true);
  assert.equal(reviewHasZeroFindings('## Findings (Important: 0, Nit: 1)\n\n`x.mjs:L1`: 🟡 Nit: advisory.\n\n## LGTM'), true);
  assert.equal(reviewIsApproved(review('## Findings (Important: 0, Nit: 1)\n\n`x.mjs:L1`: 🟡 Nit: advisory.\n\n## LGTM')), true);
  assert.equal(reviewHasZeroFindings('## Scope\n\n## LGTM'), true);
  assert.equal(reviewHasZeroFindings('## Findings (Important: 1, Nit: 0)\n\n🔴 Important: not harmless'), false);
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
