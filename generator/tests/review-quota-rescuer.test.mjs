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
  parseReviewQuotaRetryMarker,
  reviewQuotaRetryBody,
  reviewQuotaDeferredCandidates,
  sourceWorkflowForRole,
} from '../../scripts/ci/review-quota-rescuer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD = 'a'.repeat(40);

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

test('il rescuer usa la run sorgente corretta per ogni consumer PR', () => {
  assert.equal(sourceWorkflowForRole('review'), 'tests');
  assert.equal(sourceWorkflowForRole('redflag'), 'PR 🔴 fixer (bounded loop-closure on bot PRs)');
  assert.equal(sourceWorkflowForRole('redcheck'), 'PR ❌ check fixer (bounded, check richiesto rosso su PR bot)');
  assert.equal(sourceWorkflowForRole('issue-fix'), '');
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
});
