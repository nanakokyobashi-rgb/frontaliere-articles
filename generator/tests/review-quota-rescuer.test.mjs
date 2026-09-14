import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reviewQuotaDeferredBody,
} from '../../scripts/ci/check-quota-backoff.mjs';
import {
  deferredReviewCandidate,
  hasReviewQuotaRetry,
  latestReviewQuotaDeferred,
  latestReviewQuotaRetry,
  latestReviewTransientRetry,
  parseReviewQuotaRetryMarker,
  parseReviewTransientRetryMarker,
  reviewQuotaRetryBody,
  reviewTransientRetryBody,
  reviewQuotaDeferredCandidates,
  collectReviewQuotaCandidates,
  collectReviewTransientCandidates,
  pendingReviewTransientClaim,
  sourceWorkflowForRole,
  roundRobinWindow,
  sourceRunAlreadyHandled,
} from '../../scripts/ci/review-quota-rescuer.mjs';
import {
  reviewClaimDedupeKey,
  reviewClaimKey,
} from '../../scripts/ci/review-claim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD = 'a'.repeat(40);
const BODY_REVISION = `body:${'b'.repeat(64)}`;
const FINGERPRINT = 'c'.repeat(64);

function reviewClaim(overrides = {}) {
  const context = {
    prNumber: '99',
    headSha: HEAD,
    eventKey: 'run:77',
    contributionFingerprint: FINGERPRINT,
    reviewRevision: BODY_REVISION,
  };
  const event = {
    version: 1,
    token: 'review-token-77',
    ...context,
    state: 'failed-transient',
    issuedAt: 100,
    expiresAt: 3_700,
    runId: '77',
    ...overrides,
  };
  return {
    ...event,
    key: reviewClaimKey(event),
    dedupeKey: reviewClaimDedupeKey(event),
  };
}

function reviewClaimComment(event, id = 1) {
  return {
    id,
    created_at: `1970-01-01T00:0${id}:00Z`,
    user: { login: 'github-actions[bot]' },
    body: `<!-- PR_REVIEW_CLAIM: ${JSON.stringify(event)} -->`,
  };
}

test('la scansione PR è round-robin quando il pool supera il cap', () => {
  const prs = Array.from({ length: 250 }, (_, index) => index + 1);
  assert.deepEqual(roundRobinWindow(prs, { limit: 100, cursor: 0 }).items, prs.slice(0, 100));
  assert.deepEqual(roundRobinWindow(prs, { limit: 100, cursor: 1 }).items, prs.slice(100, 200));
  assert.deepEqual(
    roundRobinWindow(prs, { limit: 100, cursor: 2 }).items,
    prs.slice(200, 250).concat(prs.slice(0, 50)),
  );
  assert.deepEqual(roundRobinWindow(prs, { limit: 100, cursor: 3 }).items, prs.slice(50, 150));
  assert.deepEqual(roundRobinWindow([1, 2], { limit: 100, cursor: 9 }), { items: [1, 2], start: 0 });
});

test('solo una run sorgente avanzata non consuma un nuovo retry', () => {
  const candidate = { deferred: { sourceAttempt: 2 } };
  assert.equal(sourceRunAlreadyHandled(candidate, { attempt: 3, status: 'completed', conclusion: 'failure' }), true);
  assert.equal(sourceRunAlreadyHandled(candidate, { attempt: 2, status: 'completed', conclusion: 'success' }), false,
    'un workflow verde può aver saltato il consumer per lease negato');
  assert.equal(sourceRunAlreadyHandled(candidate, { attempt: 2, status: 'completed', conclusion: 'failure' }), false);
  assert.equal(sourceRunAlreadyHandled({ deferred: {} }, { attempt: 2, status: 'completed', conclusion: 'failure' }), true);
  assert.equal(sourceRunAlreadyHandled({ deferred: {} }, { attempt: 1, status: 'completed', conclusion: 'success' }), false);
});

test('il rescuer seleziona solo una deferral sulla HEAD corrente', () => {
  const deferredBody = reviewQuotaDeferredBody({
    head: HEAD,
    runId: 'tests-1',
    reason: 'issue-fix-slot-active',
  });
  const comments = [{
    id: 10,
    created_at: '2026-09-12T13:00:00Z',
    body: deferredBody,
  }];
  assert.equal(latestReviewQuotaDeferred(comments).runId, 'tests-1');
  assert.equal(latestReviewQuotaDeferred(comments).role, 'review');
  assert.equal(deferredReviewCandidate({ head: HEAD, comments }).runId, 'tests-1');
  assert.equal(deferredReviewCandidate({ head: 'b'.repeat(40), comments }), null);
  assert.equal(
    latestReviewQuotaDeferred([{ user: { login: 'random-user' }, body: deferredBody }]),
    null,
    'un commento utente non può fabbricare un rerun costoso',
  );
});

test('un retry già richiesto non viene duplicato, un nuovo run di deferral sì', () => {
  const deferredBody = reviewQuotaDeferredBody({ head: HEAD, runId: 'tests-1', role: 'redflag', reason: 'floor' });
  const retryBody = reviewQuotaRetryBody({
    head: HEAD,
    role: 'redflag',
    deferredRunId: 'tests-1',
    sourceRunId: '42',
    runId: 'rescuer-1',
  });
  const comments = [{ body: deferredBody }, { body: retryBody }];
  assert.equal(hasReviewQuotaRetry(comments, { head: HEAD, role: 'review', deferredRunId: 'tests-1' }), false,
    'un retry di un consumer diverso non chiude la deferral');
  assert.equal(hasReviewQuotaRetry(comments, { head: HEAD, role: 'redflag', deferredRunId: 'tests-1' }), true);
  assert.equal(deferredReviewCandidate({ head: HEAD, comments }), null);
  assert.equal(parseReviewQuotaRetryMarker(retryBody).sourceRunId, '42');
  assert.equal(parseReviewQuotaRetryMarker(retryBody).role, 'redflag');

  const nextDeferral = reviewQuotaDeferredBody({ head: HEAD, runId: 'tests-2', reason: 'shared-quota-lease-active' });
  assert.equal(
    deferredReviewCandidate({ head: HEAD, comments: [...comments, { body: nextDeferral }] }).runId,
    'tests-2',
  );
});

test('una deferral di un consumer non nasconde quella pendente di un altro consumer', () => {
  const review = reviewQuotaDeferredBody({
    head: HEAD, runId: 'review-1', role: 'review', reason: 'shared-quota-lease-active',
  });
  const redcheck = reviewQuotaDeferredBody({
    head: HEAD, runId: 'redcheck-1', role: 'redcheck', reason: 'shared-quota-lease-contention',
  });
  const redcheckRetry = reviewQuotaRetryBody({
    head: HEAD,
    role: 'redcheck',
    deferredRunId: 'redcheck-1',
    sourceRunId: '42',
    runId: 'rescuer-1',
  });
  const comments = [
    { id: 10, created_at: '2026-09-12T13:00:00Z', body: review },
    { id: 11, created_at: '2026-09-12T13:01:00Z', body: redcheck },
    { id: 12, created_at: '2026-09-12T13:02:00Z', body: redcheckRetry },
  ];
  assert.deepEqual(reviewQuotaDeferredCandidates({ head: HEAD, comments }).map((x) => x.runId), ['review-1']);
  assert.equal(deferredReviewCandidate({ head: HEAD, comments }).runId, 'review-1');
});

test('collect restituisce ogni ruolo pending, compreso un requested da riconciliare', () => {
  const comments = ['review', 'redflag', 'redcheck'].map((role, index) => ({
    id: 30 + index,
    created_at: `2026-09-12T13:0${index}:00Z`,
    body: reviewQuotaDeferredBody({
      head: HEAD,
      runId: `${role}-1`,
      role,
      reason: 'shared-quota-lease-active',
    }),
  }));
  comments.push({
    id: 40,
    created_at: '2026-09-12T13:03:00Z',
    body: reviewQuotaRetryBody({
      head: HEAD,
      role: 'review',
      deferredRunId: 'review-1',
      sourceRunId: '42',
      sourceAttempt: 1,
      runId: 'rescuer-1',
      state: 'requested',
    }),
  });

  const candidates = collectReviewQuotaCandidates(
    [{ number: 99, head: { sha: HEAD } }],
    new Map([[99, comments]]),
  );
  assert.deepEqual(candidates.map((candidate) => candidate.deferred.role), ['review', 'redflag', 'redcheck']);
  assert.equal(candidates.find((candidate) => candidate.deferred.role === 'review').retry.event.state, 'requested');
});

test('una nuova deferral dopo il retry dello stesso run riapre il candidato', () => {
  const fields = {
    head: HEAD,
    role: 'review',
    deferredRunId: 'tests-1',
    sourceRunId: '42',
    runId: 'rescuer-1',
  };
  const comments = [
    {
      id: 20,
      created_at: '2026-09-12T13:00:00Z',
      body: reviewQuotaDeferredBody({ head: HEAD, runId: 'tests-1', role: 'review', reason: 'floor' }),
    },
    {
      id: 21,
      created_at: '2026-09-12T13:01:00Z',
      body: reviewQuotaRetryBody(fields),
    },
    {
      id: 22,
      created_at: '2026-09-12T13:02:00Z',
      body: reviewQuotaDeferredBody({ head: HEAD, runId: 'tests-1', role: 'review', reason: 'shared-quota-lease-reservation-contended' }),
    },
  ];
  assert.equal(deferredReviewCandidate({ head: HEAD, comments }).runId, 'tests-1');
});

test('il marker retry è riconciliabile: requested/confirmed bloccano, failed riapre', () => {
  const fields = {
    head: HEAD,
    role: 'review',
    deferredRunId: 'tests-1',
    sourceRunId: '42',
    runId: 'rescuer-1',
  };
  const requested = reviewQuotaRetryBody({ ...fields, state: 'requested' });
  const failed = reviewQuotaRetryBody({ ...fields, state: 'failed' });
  const confirmed = reviewQuotaRetryBody({ ...fields, state: 'confirmed' });
  const key = { head: HEAD, role: 'review', deferredRunId: 'tests-1' };
  assert.equal(hasReviewQuotaRetry([{ body: requested }], key), true);
  assert.equal(hasReviewQuotaRetry([{ body: requested }, { body: failed }], key), false);
  assert.equal(hasReviewQuotaRetry([{ body: requested }, { body: failed }, { body: confirmed }], key), true);
  assert.equal(latestReviewQuotaRetry([{ body: requested }, { body: failed }], key).state, 'failed');
  assert.equal(parseReviewQuotaRetryMarker(requested).state, 'requested');
});

test('il marker retry conserva e valida sourceAttempt', () => {
  const body = reviewQuotaRetryBody({
    head: HEAD,
    role: 'review',
    deferredRunId: 'tests-1',
    sourceRunId: '42',
    sourceAttempt: 3,
    runId: 'rescuer-1',
    state: 'requested',
  });
  assert.equal(parseReviewQuotaRetryMarker(body).sourceAttempt, 3);
  assert.equal(
    parseReviewQuotaRetryMarker(body.replace('"sourceAttempt":3', '"sourceAttempt":0')),
    null,
  );
});

test('il rescuer usa la run sorgente corretta per ogni consumer PR', () => {
  assert.equal(sourceWorkflowForRole('review'), 'tests');
  assert.equal(sourceWorkflowForRole('redflag'), 'PR 🔴 fixer (bounded loop-closure on bot PRs)');
  assert.equal(sourceWorkflowForRole('redcheck'), 'PR ❌ check fixer (bounded, check richiesto rosso su PR bot)');
  assert.equal(sourceWorkflowForRole('issue-fix'), '');
});

test('un claim failed-transient riceve al massimo un rerun per HEAD e body revision', () => {
  const failed = reviewClaim({ token: 'review-token-77', runId: '77' });
  const comments = [reviewClaimComment(failed, 1)];
  const pr = { number: 99, head: { sha: HEAD }, draft: false };
  const revisions = new Map([[99, BODY_REVISION]]);
  const commentMap = new Map([[99, comments]]);

  const [candidate] = collectReviewTransientCandidates([pr], commentMap, revisions, { maxRetries: 1 });
  assert.equal(candidate.claim.token, 'review-token-77');
  assert.equal(candidate.retryCount, 1);

  const marker = reviewTransientRetryBody({
    head: HEAD,
    reviewRevision: BODY_REVISION,
    claimToken: failed.token,
    sourceRunId: failed.runId,
    sourceAttempt: 1,
    runId: 'rescuer-1',
    retryCount: 1,
    state: 'confirmed',
  });
  assert.equal(parseReviewTransientRetryMarker(marker).retryCount, 1);
  assert.equal(
    collectReviewTransientCandidates(
      [pr],
      new Map([[99, [...comments, { id: 2, created_at: '1970-01-01T00:02:00Z', body: marker }]]]),
      revisions,
      { maxRetries: 1 },
    ).length,
    0,
    'un marker confirmed chiude la finestra one-shot anche se un nuovo claim transient appare',
  );
});

test('il marker transient persiste il timestamp della richiesta', () => {
  const marker = reviewTransientRetryBody({
    head: HEAD,
    reviewRevision: BODY_REVISION,
    claimToken: 'review-token-time',
    sourceRunId: '77',
    sourceAttempt: 1,
    runId: 'rescuer-time',
    retryCount: 1,
    issuedAt: 1234,
    state: 'requested',
  });
  assert.equal(parseReviewTransientRetryMarker(marker).issuedAt, 1234);

  const legacy = reviewTransientRetryBody({
    head: HEAD,
    reviewRevision: BODY_REVISION,
    claimToken: 'review-token-legacy',
    sourceRunId: '77',
    sourceAttempt: 1,
    runId: 'rescuer-legacy',
    retryCount: 1,
    issuedAt: 1234,
  }).replace(',"issuedAt":1234', '');
  const recovered = latestReviewTransientRetry([
    { id: 7, created_at: '1970-01-01T00:20:34Z', body: legacy },
  ], { head: HEAD, reviewRevision: BODY_REVISION });
  assert.equal(recovered.issuedAt, 1234);
});

test('il transient rescuer ignora claim stantii, attivi o terminali', () => {
  const staleHead = reviewClaim({
    token: 'stale-head',
    headSha: 'd'.repeat(40),
  });
  const staleRevision = reviewClaim({ token: 'stale-revision', reviewRevision: `body:${'e'.repeat(64)}` });
  const active = reviewClaim({ token: 'active', state: 'active', expiresAt: 9_999 });
  const terminal = reviewClaim({ token: 'terminal', state: 'completed' });

  assert.equal(
    pendingReviewTransientClaim({
      head: HEAD,
      reviewRevision: BODY_REVISION,
      comments: [reviewClaimComment(staleHead, 1), reviewClaimComment(staleRevision, 2)],
      nowSec: 200,
    }),
    null,
  );
  assert.equal(
    pendingReviewTransientClaim({
      head: HEAD,
      reviewRevision: BODY_REVISION,
      comments: [reviewClaimComment(active, 3)],
      nowSec: 200,
    }),
    null,
  );
  assert.equal(
    pendingReviewTransientClaim({
      head: HEAD,
      reviewRevision: BODY_REVISION,
      comments: [reviewClaimComment(terminal, 4)],
      nowSec: 200,
    }),
    null,
  );
  assert.equal(parseReviewTransientRetryMarker('<!-- REVIEW_TRANSIENT_RETRY: {"version":1} -->'), null);
});

test('il wiring reagisce al completamento dei consumer e rilascia reservation esistenti', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/review-quota-rescuer.yml'), 'utf8');
  const tests = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.match(workflow, /workflow_run:[\s\S]*- tests[\s\S]*- Issue fix \(Claude → PR\)/);
  assert.match(workflow, /PR 🔴 fixer \(bounded loop-closure on bot PRs\)/);
  assert.match(workflow, /PR ❌ check fixer \(bounded, check richiesto rosso su PR bot\)/);
  assert.match(workflow, /review-quota-rescuer\.mjs/);
  assert.match(tests, /HEAD_SHA: \$\{\{ steps\.resolve\.outputs\.head_sha \}\}/);
  assert.match(tests, /steps\.quota\.outputs\.lease_allowed == 'true'[\s\S]*steps\.quota\.outputs\.lease_token != ''/);
  const redflag = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');
  const redcheck = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redcheck-fixer.yml'), 'utf8');
  assert.match(redflag, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(redcheck, /HEAD_SHA: \$\{\{ needs\.preflight\.outputs\.head_sha \}\}/);
  assert.match(redflag, /steps\.quota_lease\.outputs\.lease_allowed == 'true'[\s\S]*steps\.quota_lease\.outputs\.lease_token != ''/);
  assert.match(redcheck, /steps\.quota_lease\.outputs\.lease_allowed == 'true'[\s\S]*steps\.quota_lease\.outputs\.lease_token != ''/);
  const rescuer = fs.readFileSync(path.join(ROOT, 'scripts/ci/review-quota-rescuer.mjs'), 'utf8');
  assert.match(rescuer, /state: 'requested'/);
  assert.match(rescuer, /if \(!postRetryComment\(number, requestedBody\)\)/);
  assert.match(rescuer, /state: 'failed'/);
  assert.match(rescuer, /state: 'confirmed'/);
  assert.match(rescuer, /--json', 'databaseId,headSha,status,workflowName,headBranch,event,attempt,conclusion'/);
  assert.match(rescuer, /includeRequested: true/);
  assert.match(rescuer, /sourceAttempt/);
  assert.match(rescuer, /REVIEW_QUOTA_RESCUER_CURSOR/);
  assert.match(rescuer, /roundRobinWindow/);
  assert.match(rescuer, /if \(DRY_RUN\)[\s\S]*riconciliazione del marker requested saltata/);
  assert.match(rescuer, /REVIEW_TRANSIENT_RETRY/);
  assert.match(rescuer, /failed-transient/);
  assert.match(workflow, /Retry deferred\/transient reviews/);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  assert.equal(
    manifest.files.find((entry) => entry.path === '.github/workflows/review-quota-rescuer.yml')?.mode,
    'corpus-only',
  );
});
