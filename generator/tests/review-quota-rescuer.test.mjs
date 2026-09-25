import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  reviewQuotaDeferredBody,
} from '../../scripts/ci/check-quota-backoff.mjs';
import {
  deferredReviewCandidate,
  fixerAttemptEvidence,
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
  sourceWorkflowPathForRole,
  roundRobinWindow,
  sourceRunForCandidate,
  sourceRunAlreadyHandled,
  retryStateForObservedAttempt,
  transientRetryStateForRun,
  MAX_RATE_LIMIT_FAILED_ATTEMPTS,
  parseReviewRateLimitRetryMarker,
  RATE_LIMIT_RESET_GRACE_SEC,
  RATE_LIMIT_WINDOW_SEC,
  rateLimitEvidence,
  rateLimitRerunCandidates,
  reviewRateLimitRetryAdmission,
  reviewRateLimitRetryBody,
} from '../../scripts/ci/review-quota-rescuer.mjs';
import { rateLimitMarker } from '../../scripts/ci/lib/gh-rate-limit.mjs';
import {
  reviewClaimDedupeKey,
  reviewClaimKey,
} from '../../scripts/ci/review-claim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD = 'a'.repeat(40);
const BODY_REVISION = `body:${'b'.repeat(64)}`;
const FINGERPRINT = 'c'.repeat(64);

test('il CLI distingue elenco vuoto da API non verificabile e resta non-zero', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'review-quota-rescuer-cli-'));
  const calls = path.join(dir, 'calls');
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(gh, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$GH_CALLS"',
    'case "$GH_MODE" in',
    '  fail) exit 1 ;;',
    '  malformed) printf "{\\"unexpected\\":true}\\n" ;;',
    '  malformed-page) printf "[[{}]]\\n" ;;',
    '  empty) printf "[]\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(gh, 0o755);
  try {
    const env = {
      ...process.env,
      GH_REPO: 'nanakokyobashi-rgb/frontaliere-articles',
      GH_CALLS: calls,
      PATH: dir + ':' + (process.env.PATH || ''),
    };
    const script = path.join(ROOT, 'scripts/ci/review-quota-rescuer.mjs');
    const failed = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...env, GH_MODE: 'fail' },
    });
    assert.notEqual(failed.status, 0, 'un errore gh non può colorare verde il rescuer');
    assert.match(failed.stderr, /probe fallita/);
    assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /pr comment|run rerun|api -X/);

    fs.writeFileSync(calls, '');
    const empty = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...env, GH_MODE: 'empty' },
    });
    assert.equal(empty.status, 0, 'un elenco PR vuoto valido non è un errore');
    assert.match(empty.stdout, /PR osservate=0/);

    fs.writeFileSync(calls, '');
    const malformed = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...env, GH_MODE: 'malformed' },
    });
    assert.notEqual(malformed.status, 0, 'un payload non-array non è un elenco vuoto');
    assert.match(malformed.stderr, /probe fallita/);

    fs.writeFileSync(calls, '');
    const malformedPage = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...env, GH_MODE: 'malformed-page' },
    });
    assert.notEqual(malformedPage.status, 0, 'una pagina con record senza campi non è una coda vuota');
    assert.match(malformedPage.stderr, /probe fallita/);
    assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /pr comment|run rerun|api -X/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test('un marker v2 avanzato richiede prova di consumo, non solo attempt', () => {
  const candidate = { deferred: { version: 2, sourceAttempt: 2 } };
  assert.equal(
    sourceRunAlreadyHandled(candidate, { attempt: 3 }, { verified: true, consumed: false }),
    false,
  );
  assert.equal(
    sourceRunAlreadyHandled(candidate, { attempt: 3 }, { verified: true, consumed: true }),
    true,
  );
  assert.equal(
    sourceRunAlreadyHandled(candidate, { attempt: 3 }, { verified: false, consumed: true }),
    false,
  );
});

function redcheckClaimComment(state, runId = '77', login = 'github-actions[bot]') {
  return {
    user: { login },
    body: `<!-- REDCHECK_FIX_CLAIM: ${JSON.stringify({
      version: 1,
      token: `claim-${runId}`,
      key: `pr:99|head:${HEAD}|failure:tests`,
      prNumber: '99',
      headSha: HEAD,
      checkFailureKey: 'tests',
      state,
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_600,
      runId,
    })} -->`,
  };
}

test('la riconciliazione v2 redcheck accetta solo claim terminale dello stesso run', () => {
  assert.deepEqual(
    fixerAttemptEvidence({
      role: 'redcheck', runId: '77', prNumber: 99, head: HEAD,
      comments: [redcheckClaimComment('active')],
    }),
    { verified: true, consumed: false, reason: 'redcheck-claim-not-terminal' },
  );
  assert.deepEqual(
    fixerAttemptEvidence({
      role: 'redcheck', runId: '77', prNumber: 99, head: HEAD,
      comments: [redcheckClaimComment('completed')],
    }),
    { verified: true, consumed: true, reason: 'redcheck-claim-terminal' },
  );
  assert.equal(
    fixerAttemptEvidence({
      role: 'redcheck', runId: '77', prNumber: 99, head: HEAD,
      comments: [redcheckClaimComment('completed', '76')],
    }).consumed,
    false,
  );
  assert.equal(
    fixerAttemptEvidence({
      role: 'redcheck', runId: '77', prNumber: 99, head: HEAD,
      comments: [redcheckClaimComment('completed', '77', 'untrusted-user')],
    }).consumed,
    false,
    'un actor non può chiudere la fence',
  );
});

test('la riconciliazione v2 redflag richiede lo step di fix realmente avviato', () => {
  const step = { name: 'Run Codex Luna Max 🔴-fix', startedAt: '2026-09-19T10:00:00Z', conclusion: 'success' };
  assert.deepEqual(
    fixerAttemptEvidence({ role: 'redflag', runId: '77', prNumber: 99, head: HEAD, jobs: [{ steps: [step] }] }),
    { verified: true, consumed: true, reason: 'redflag-fix-step-started' },
  );
  assert.equal(
    fixerAttemptEvidence({
      role: 'redflag', runId: '77', prNumber: 99, head: HEAD,
      jobs: [{ steps: [{ ...step, startedAt: null, conclusion: 'skipped' }] }],
    }).consumed,
    false,
  );
  assert.deepEqual(
    fixerAttemptEvidence({ role: 'redflag', runId: '77', prNumber: 99, head: HEAD, jobs: [{ steps: [] }] }),
    { verified: true, consumed: false, reason: 'redflag-fix-step-not-started' },
  );
  assert.equal(
    fixerAttemptEvidence({ role: 'redflag', runId: '77', prNumber: 99, head: HEAD, jobs: [{}] }).verified,
    false,
  );
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
  assert.equal(sourceWorkflowPathForRole('redflag'), '.github/workflows/pr-redflag-fixer.yml');
  assert.equal(sourceWorkflowPathForRole('redcheck'), '.github/workflows/pr-redcheck-fixer.yml');
  assert.equal(sourceWorkflowPathForRole('review'), '');
});

test('collect scarta un marker v2 indirizzato a un’altra PR', () => {
  const body = reviewQuotaDeferredBody({
    head: HEAD,
    runId: '123',
    role: 'redcheck',
    reason: 'shared-quota-lease-active',
    sourceAttempt: 1,
    prNumber: 100,
    sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
    sourceEvent: 'workflow_dispatch',
  });
  assert.ok(body);
  assert.deepEqual(
    collectReviewQuotaCandidates(
      [{ number: 99, head: { sha: HEAD } }],
      new Map([[99, [{ body }]]]),
    ),
    [],
  );
});

test('workflow_run su main è accettato solo con trigger tests sulla PR HEAD', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'review-quota-provenance-'));
  const gh = path.join(dir, 'gh');
  const mainSha = 'b'.repeat(40);
  const fixer = JSON.stringify({
    databaseId: '123',
    headSha: mainSha,
    status: 'completed',
    workflowName: 'PR ❌ check fixer (bounded, check richiesto rosso su PR bot)',
    event: 'workflow_run',
    attempt: 3,
    conclusion: 'success',
  });
  const trigger = JSON.stringify({
    databaseId: '456',
    headSha: HEAD,
    status: 'completed',
    workflowName: 'tests',
    event: 'pull_request',
    attempt: 1,
    conclusion: 'failure',
  });
  fs.writeFileSync(gh, [
    '#!/bin/sh',
    'if [ "$3" = "123" ]; then printf \'%s\\n\' "$FIXER_JSON"; else printf \'%s\\n\' "$TRIGGER_JSON"; fi',
    '',
  ].join('\n'));
  fs.chmodSync(gh, 0o755);
  const candidate = {
    pr: { number: 99 },
    head: HEAD,
    deferred: {
      version: 2,
      head: HEAD,
      runId: '123',
      role: 'redcheck',
      reason: 'shared-quota-lease-active',
      prNumber: '99',
      sourceAttempt: 2,
      sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
      sourceEvent: 'workflow_run',
      triggerRunId: '456',
      triggerHead: HEAD,
    },
  };
  candidate.deferred.commentId = 7;
  candidate.comments = [{
    id: 7,
    user: { login: 'github-actions[bot]' },
    body: reviewQuotaDeferredBody(candidate.deferred),
  }];
  try {
    const env = {
      ...process.env,
      GH_REPO: 'nanakokyobashi-rgb/frontaliere-articles',
      FIXER_JSON: fixer,
      TRIGGER_JSON: trigger,
      PATH: dir + ':' + (process.env.PATH || ''),
    };
    const moduleUrl = pathToFileURL(path.join(ROOT, 'scripts/ci/review-quota-rescuer.mjs')).href;
    const source = `import { sourceRunForCandidate } from ${JSON.stringify(moduleUrl)};\n`
      + `const run = sourceRunForCandidate(${JSON.stringify(candidate)});\n`
      + `process.stdout.write(JSON.stringify(run));\n`;
    const accepted = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      env,
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).provenanceVerified, true);
    assert.equal(JSON.parse(accepted.stdout).headSha, mainSha);

    const rejected = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      env: {
        ...env,
        TRIGGER_JSON: JSON.stringify({ ...JSON.parse(trigger), headSha: 'c'.repeat(40) }),
      },
    });
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.equal(JSON.parse(rejected.stdout), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow_dispatch su main usa intent preflight trusted + PR HEAD corrente, senza trigger tests', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'review-quota-dispatch-'));
  const gh = path.join(dir, 'gh');
  const dispatchRun = JSON.stringify({
    databaseId: '123',
    headSha: 'b'.repeat(40),
    status: 'completed',
    workflowName: 'PR ❌ check fixer (bounded, check richiesto rosso su PR bot)',
    event: 'workflow_dispatch',
    attempt: 2,
    conclusion: 'success',
  });
  const pr = JSON.stringify({ number: 99, state: 'open', head: { sha: HEAD } });
  fs.writeFileSync(gh, [
    '#!/bin/sh',
    'if [ "$1" = "api" ]; then printf \'%s\\n\' "$PR_JSON"; else printf \'%s\\n\' "$RUN_JSON"; fi',
    '',
  ].join('\n'));
  fs.chmodSync(gh, 0o755);
  const candidate = {
    pr: { number: 99 },
    head: HEAD,
    deferred: {
      version: 2,
      head: HEAD,
      runId: '123',
      role: 'redcheck',
      reason: 'shared-quota-lease-active',
      prNumber: '99',
      sourceAttempt: 1,
      sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
      sourceEvent: 'workflow_dispatch',
    },
  };
  candidate.deferred.commentId = 8;
  candidate.comments = [{
    id: 8,
    user: { login: 'github-actions[bot]' },
    body: reviewQuotaDeferredBody(candidate.deferred),
  }];
  try {
    const env = {
      ...process.env,
      GH_REPO: 'nanakokyobashi-rgb/frontaliere-articles',
      RUN_JSON: dispatchRun,
      PR_JSON: pr,
      PATH: dir + ':' + (process.env.PATH || ''),
    };
    const moduleUrl = pathToFileURL(path.join(ROOT, 'scripts/ci/review-quota-rescuer.mjs')).href;
    const sourceFor = (target) => `import { currentTargetProof, sourceRunForCandidate } from ${JSON.stringify(moduleUrl)};\n`
      + `const candidate = ${JSON.stringify(target)};\n`
      + `process.stdout.write(JSON.stringify({ proof: currentTargetProof(candidate), run: sourceRunForCandidate(candidate) }));\n`;
    const source = sourceFor(candidate);
    const accepted = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      env,
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    const acceptedPayload = JSON.parse(accepted.stdout);
    assert.deepEqual(acceptedPayload.proof, { verified: true, obsolete: false });
    assert.equal(acceptedPayload.run.provenanceVerified, true);
    assert.equal(acceptedPayload.run.headSha, 'b'.repeat(40));

    const untrustedCandidate = {
      ...candidate,
      comments: [{ ...candidate.comments[0], user: { login: 'untrusted-user' } }],
    };
    const rejectedMarker = spawnSync(process.execPath, ['--input-type=module', '-e', sourceFor(untrustedCandidate)], {
      encoding: 'utf8',
      env,
    });
    assert.equal(rejectedMarker.status, 0, rejectedMarker.stderr);
    assert.equal(JSON.parse(rejectedMarker.stdout).run, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('un attempt 2+ senza marker requested resta eleggibile al recovery transient', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/ci/review-quota-rescuer.mjs'), 'utf8');
  const start = source.indexOf('function rescueTransientReview(');
  const end = source.indexOf('\nfunction retryFieldsForCandidate', start);
  assert.ok(start >= 0 && end > start);
  const transient = source.slice(start, end);
  assert.doesNotMatch(
    transient,
    /if \(run\.attempt > 1\)/,
    'un attempt GitHub avanzato non dimostra che il rescuer abbia già richiesto il rerun',
  );
  assert.match(transient, /state: 'requested'/);
  assert.match(transient, /postTransientRetryComment\(number, requestedBody\)/);
});

test('un marker transient requested al limite resta riconciliabile', () => {
  const failed = reviewClaim({ token: 'review-token-requested', runId: '77' });
  const requested = reviewTransientRetryBody({
    head: HEAD,
    reviewRevision: BODY_REVISION,
    claimToken: failed.token,
    sourceRunId: failed.runId,
    sourceAttempt: 1,
    runId: 'rescuer-requested',
    retryCount: 1,
    issuedAt: 150,
    state: 'requested',
  });
  const candidate = pendingReviewTransientClaim({
    head: HEAD,
    reviewRevision: BODY_REVISION,
    comments: [
      reviewClaimComment(failed, 1),
      { id: 2, created_at: '1970-01-01T00:03:00Z', body: requested },
    ],
    nowSec: 200,
    maxRetries: 1,
  });
  assert.equal(candidate?.retry?.state, 'requested');
  assert.equal(candidate?.retry?.retryCount, 1);
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

test('ogni rerun lascia requested finché non viene osservato un attempt nuovo', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/ci/review-quota-rescuer.mjs'), 'utf8');

  const transientStart = source.indexOf('function rescueTransientReview(');
  const transientEnd = source.indexOf('\nfunction retryFieldsForCandidate', transientStart);
  assert.ok(transientStart >= 0 && transientEnd > transientStart);
  const transient = source.slice(transientStart, transientEnd);
  const transientRerun = transient.indexOf("gh(['run', 'rerun'");
  assert.ok(transientRerun >= 0);
  assert.match(transient.slice(0, transientRerun), /state: 'requested'/);
  assert.doesNotMatch(transient.slice(transientRerun), /state: 'confirmed'/,
    'il percorso transient non deve consumare il retry prima dell attempt nuovo');
  assert.match(transient, /attendo un attempt nuovo osservabile/);

  const mainStart = source.indexOf('function main()');
  const mainEnd = source.indexOf('\nif (process.argv[1]', mainStart);
  assert.ok(mainStart >= 0 && mainEnd > mainStart);
  const main = source.slice(mainStart, mainEnd);
  const quotaRerun = main.indexOf("gh(['run', 'rerun'");
  assert.ok(quotaRerun >= 0);
  assert.doesNotMatch(main.slice(quotaRerun), /state: 'confirmed'/,
    'il percorso quota non deve pubblicare confirmed subito dopo gh run rerun');
  assert.match(main.slice(quotaRerun), /attendo un attempt nuovo osservabile/);
  assert.match(source, /if \(run\.attempt > requestedAttempt\)/);
  assert.match(source, /state: 'confirmed'/);
});

test('un transient attempt nuovo diventa confirmed o failed solo a completamento', () => {
  assert.equal(transientRetryStateForRun({ status: 'queued', conclusion: 'success' }), null);
  assert.equal(transientRetryStateForRun({ status: 'in_progress', conclusion: 'success' }), null);
  assert.equal(transientRetryStateForRun({ status: 'completed', conclusion: 'success' }), 'confirmed');
  assert.equal(transientRetryStateForRun({ status: 'completed', conclusion: 'failure' }), 'failed');
  assert.equal(transientRetryStateForRun({ status: 'completed', conclusion: 'cancelled' }), 'failed');
  assert.equal(transientRetryStateForRun({ status: 'completed' }), 'failed');
  const base = { currentAttempt: 3, requestedAttempt: 2 };
  assert.equal(retryStateForObservedAttempt({ ...base, status: 'queued', conclusion: 'success' }), null);
  assert.equal(retryStateForObservedAttempt({ ...base, status: 'in_progress', conclusion: 'success' }), null);
  assert.equal(retryStateForObservedAttempt({ ...base, status: 'completed', conclusion: 'success' }), 'confirmed');
  assert.equal(retryStateForObservedAttempt({ ...base, status: 'completed', conclusion: 'failure' }), 'failed');
  assert.equal(retryStateForObservedAttempt({ ...base, status: 'completed', conclusion: 'cancelled' }), 'failed');
  assert.equal(retryStateForObservedAttempt({ currentAttempt: 2, requestedAttempt: 2, status: 'completed', conclusion: 'success' }), null);
});

test('il wiring reagisce al completamento dei consumer e rilascia reservation esistenti', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/review-quota-rescuer.yml'), 'utf8');
  const tests = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.match(workflow, /workflow_run:[\s\S]*- tests[\s\S]*- Issue fix \(Codex Luna Max → PR\)/);
  assert.match(workflow, /- Issue decompose \(Codex Luna Max → sub-issues\)/);
  assert.match(workflow, /PR 🔴 fixer \(bounded loop-closure on bot PRs\)/);
  assert.match(workflow, /PR ❌ check fixer \(bounded, check richiesto rosso su PR bot\)/);
  assert.match(workflow, /review-quota-rescuer\.mjs/);
  assert.match(tests, /HEAD_SHA: \$\{\{ steps\.resolve\.outputs\.head_sha \}\}/);
  assert.match(tests, /Pre-flight — Codex lane quota telemetry/);
  assert.match(tests, /CODEX_FALLBACK_MODE: '1'/);
  assert.doesNotMatch(tests, /QUOTA_LEASE_ACTION: acquire/,
    'la review Codex non deve essere saltata per una lease Claude condivisa');
  const redflag = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');
  const redcheck = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redcheck-fixer.yml'), 'utf8');
  assert.match(redflag, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(redcheck, /HEAD_SHA: \$\{\{ needs\.preflight\.outputs\.head_sha \}\}/);
  assert.match(redcheck, /REVIEW_QUOTA_TRIGGER_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(redcheck, /REVIEW_QUOTA_TRIGGER_HEAD: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(redflag, /steps\.quota_lease\.outputs\.lease_allowed == 'true'[\s\S]*steps\.quota_lease\.outputs\.lease_token != ''/);
  assert.match(redcheck, /steps\.quota_lease\.outputs\.lease_allowed == 'true'[\s\S]*steps\.quota_lease\.outputs\.lease_token != ''/);
  const rescuer = fs.readFileSync(path.join(ROOT, 'scripts/ci/review-quota-rescuer.mjs'), 'utf8');
  assert.match(rescuer, /state: 'requested'/);
  assert.match(rescuer, /if \(!postRetryComment\(number, requestedBody\)\)/);
  assert.match(rescuer, /state: 'failed'/);
  assert.match(rescuer, /state: 'confirmed'/);
  assert.match(rescuer, /--json', 'databaseId,headSha,status,workflowName,headBranch,event,attempt,conclusion'/);
  assert.doesNotMatch(rescuer, /headBranch,event,attempt,conclusion,actor,triggeringActor/);
  assert.match(rescuer, /trustedSourceMarker/);
  assert.match(rescuer, /includeRequested: true/);
  assert.match(rescuer, /sourceAttempt/);
  assert.match(rescuer, /REVIEW_QUOTA_RESCUER_CURSOR/);
  assert.match(rescuer, /roundRobinWindow/);
  assert.match(rescuer, /if \(DRY_RUN\)[\s\S]*riconciliazione del marker requested saltata/);
  assert.match(rescuer, /REVIEW_TRANSIENT_RETRY/);
  assert.match(rescuer, /failed-transient/);
  const transientRescue = rescuer.slice(
    rescuer.indexOf('function rescueTransientReview'),
    rescuer.indexOf('function retryFieldsForCandidate'),
  );
  assert.match(transientRescue, /state: 'requested'/);
  assert.match(transientRescue, /attendo un attempt nuovo osservabile/);
  assert.doesNotMatch(
    transientRescue.slice(transientRescue.indexOf('let rerunRequested')),
    /const confirmedBody = reviewTransientRetryBody/,
    'il comando rerun non può essere marcato confirmed prima di osservare un attempt nuovo',
  );
  assert.match(workflow, /Retry deferred\/transient reviews/);
  assert.match(workflow, /Prepare Firebase credentials/);
  assert.match(workflow, /Load secrets from Remote Config/);
  assert.match(workflow, /runtime_pat="\$\{GITHUB_PAT_NANAKO:-\}"/);
  assert.match(workflow, /GH_TOKEN="\$runtime_pat" node scripts\/ci\/review-quota-rescuer\.mjs/);
  assert.doesNotMatch(
    workflow,
    /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/,
    'la probe quota non deve ricadere sulla quota installation del GITHUB_TOKEN',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  assert.equal(
    manifest.files.find((entry) => entry.path === '.github/workflows/review-quota-rescuer.yml')?.mode,
    'corpus-only',
  );
});

// ── Run `tests` rossi per rate limit del GITHUB_TOKEN (2026-09-25) ──────────

const RL_HEAD = 'd'.repeat(40);
const RL_REF = 'fix/rate-limited';
const RL_NOW = Date.parse('2026-09-25T08:00:00Z') / 1000;
const rlIso = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const rlPr = (over = {}) => ({ number: 1800, draft: false, head: { sha: RL_HEAD, ref: RL_REF }, ...over });
const rlRun = (over = {}) => ({
  id: 36105446627,
  run_attempt: 1,
  event: 'pull_request',
  head_sha: RL_HEAD,
  head_branch: RL_REF,
  status: 'completed',
  conclusion: 'failure',
  created_at: rlIso(RL_NOW - 3600),
  updated_at: rlIso(RL_NOW - 3500),
  ...over,
});
const rlComment = (state, id = 10, over = {}) => ({
  id,
  created_at: rlIso(RL_NOW - 1000 + id),
  user: { login: 'nanakokyobashi-rgb' },
  body: reviewRateLimitRetryBody({
    head: RL_HEAD, sourceRunId: '36105446627', sourceAttempt: 1, resetAt: RL_NOW - 2000, state, runId: '9', issuedAt: RL_NOW - 1000,
  }),
  ...over,
});

test('rate limit: la prova viene dalle annotation failure del job, col reset del marker', () => {
  const marker = `Resolve review input revision: GitHub API rate limit esaurito ${rateLimitMarker({ resource: 'core', resetAt: RL_NOW - 60 })}`;
  assert.deepEqual(rateLimitEvidence([{ annotation_level: 'failure', message: marker }], { completedAt: rlIso(RL_NOW - 600) }), { resetAt: RL_NOW - 60 });
  // 403 grezzo senza marker (review-gate troncato): reset = fine del job + 1 h.
  assert.deepEqual(
    rateLimitEvidence([{ annotation_level: 'failure', message: 'review-gate: contesto PR illeggibile: gh: API rate limit exceeded for installat' }], { completedAt: rlIso(RL_NOW - 600) }),
    { resetAt: RL_NOW - 600 + RATE_LIMIT_WINDOW_SEC },
  );
  // Marker senza reset leggibile: stesso ripiego.
  assert.deepEqual(
    rateLimitEvidence([{ annotation_level: 'failure', message: rateLimitMarker({ resetAt: 0 }) }], { completedAt: rlIso(RL_NOW - 600) }),
    { resetAt: RL_NOW - 600 + RATE_LIMIT_WINDOW_SEC },
  );
  // Un'attesa riuscita lascia solo un warning: non e' un rosso da rate limit.
  assert.equal(rateLimitEvidence([{ annotation_level: 'warning', message: `x ${rateLimitMarker({ resetAt: RL_NOW })}` }], { completedAt: rlIso(RL_NOW) }), null);
  assert.equal(rateLimitEvidence([{ annotation_level: 'failure', message: 'Nessuna review Claude approvante sulla head' }], { completedAt: rlIso(RL_NOW) }), null);
  // Senza un momento ricavabile non c'e' un rerun sicuro.
  assert.equal(rateLimitEvidence([{ annotation_level: 'failure', message: 'API rate limit exceeded' }], { completedAt: '' }), null);
});

test('rate limit: il marker durevole fa andata e ritorno e rifiuta le forme spurie', () => {
  const event = parseReviewRateLimitRetryMarker(rlComment('requested').body);
  assert.equal(event.head, RL_HEAD);
  assert.equal(event.state, 'requested');
  assert.equal(event.sourceRunId, '36105446627');
  assert.equal(parseReviewRateLimitRetryMarker('<!-- REVIEW_RATE_LIMIT_RETRY: {"version":1,"head":"x"} -->'), null);
  assert.equal(parseReviewRateLimitRetryMarker(rlComment('confirmed').body.replace('"requested"', '"confirmed"')), null);
});

test('rate limit: un solo rerun per HEAD, un failed riapre fino al tetto', () => {
  assert.deepEqual(reviewRateLimitRetryAdmission([], RL_HEAD), { admitted: true, failed: 0 });
  assert.equal(reviewRateLimitRetryAdmission([rlComment('requested')], RL_HEAD).admitted, false);
  assert.equal(reviewRateLimitRetryAdmission([rlComment('requested', 10), rlComment('failed', 11)], RL_HEAD).admitted, true);
  assert.equal(
    reviewRateLimitRetryAdmission([rlComment('requested', 10), rlComment('failed', 11), rlComment('requested', 12), rlComment('failed', 13)], RL_HEAD).admitted,
    false,
    `al massimo ${MAX_RATE_LIMIT_FAILED_ATTEMPTS} fallimenti`,
  );
  // Un marker di un'altra HEAD o di un autore non fidato non conta.
  assert.equal(reviewRateLimitRetryAdmission([rlComment('requested')], 'e'.repeat(40)).admitted, true);
  assert.equal(reviewRateLimitRetryAdmission([rlComment('requested', 10, { user: { login: 'someone' } })], RL_HEAD).admitted, true);
});

test('rate limit: candidata solo l\'ULTIMA run pull_request della HEAD, rossa e recente', () => {
  const pr = rlPr();
  assert.equal(rateLimitRerunCandidates([pr], [rlRun()], { nowSec: RL_NOW }).length, 1);
  // Una run piu' nuova sulla stessa HEAD (anche in volo) supera la rossa.
  assert.deepEqual(rateLimitRerunCandidates([pr], [rlRun(), rlRun({ id: 36105446700, created_at: rlIso(RL_NOW - 100), status: 'in_progress', conclusion: null })], { nowSec: RL_NOW }), []);
  assert.deepEqual(rateLimitRerunCandidates([pr], [rlRun({ conclusion: 'success' })], { nowSec: RL_NOW }), []);
  // Dispatch test-only, altro branch o altra HEAD: non sono la run della PR.
  assert.deepEqual(rateLimitRerunCandidates([pr], [rlRun({ event: 'workflow_dispatch' })], { nowSec: RL_NOW }), []);
  assert.deepEqual(rateLimitRerunCandidates([pr], [rlRun({ head_branch: 'main' })], { nowSec: RL_NOW }), []);
  assert.deepEqual(rateLimitRerunCandidates([pr], [rlRun({ head_sha: 'e'.repeat(40) })], { nowSec: RL_NOW }), []);
  assert.deepEqual(rateLimitRerunCandidates([pr], [rlRun({ updated_at: rlIso(RL_NOW - 4 * 3600) })], { nowSec: RL_NOW }), []);
});

/**
 * Il rescuer vero, con un `gh` finto che serve PR, commenti, run `tests`, job e
 * annotation e registra le scritture.
 */
function runRateLimitRescuer({ resetAt, comments = [], runs = [rlRun()], scan, annotationLevel = 'failure' }) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'review-rate-limit-rescuer-'));
  const calls = path.join(dir, 'calls');
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(fixture, JSON.stringify({
    prs: [[rlPr()]],
    comments: [comments],
    runs: [{ total_count: runs.length, workflow_runs: runs }],
    jobs: { total_count: 1, jobs: [{ id: 777, name: 'tests (node --test)', conclusion: 'failure', check_run_url: 'https://api.github.com/repos/o/r/check-runs/777', completed_at: rlIso(RL_NOW - 3500) }] },
    annotations: [[{ annotation_level: annotationLevel, message: `Resolve review input revision: rate limit ${rateLimitMarker({ resource: 'core', resetAt })}` }]],
  }));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const line = args.join(' ');
fs.appendFileSync(${JSON.stringify(calls)}, line + '\\n');
const f = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'comment') process.exit(0);
if (args[0] === 'run' && args[1] === 'rerun') process.exit(0);
if (line.includes('/pulls?state=open')) out(f.prs);
if (line.includes('/issues/1800/comments')) out(f.comments);
if (line.includes('/actions/workflows/tests.yml/runs?')) out(f.runs);
if (line.includes('/actions/runs/36105446627/jobs')) out(f.jobs);
if (line.includes('/check-runs/777/annotations')) out(f.annotations);
process.stderr.write('chiamata non prevista: ' + line + '\\n');
process.exit(3);
`);
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  try {
    const env = {
      ...process.env,
      GH_REPO: 'nanakokyobashi-rgb/frontaliere-articles',
      PATH: dir + ':' + (process.env.PATH || ''),
      GITHUB_RUN_ID: '9',
    };
    delete env.REVIEW_RATE_LIMIT_SCAN;
    if (scan !== undefined) env.REVIEW_RATE_LIMIT_SCAN = scan;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/review-quota-rescuer.mjs')], { encoding: 'utf8', env });
    return { ...r, calls: fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('rate limit: dopo il reset il run tests viene rilanciato UNA volta, marker prima del rerun', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // Il fixture usa RL_NOW come «adesso» delle run: le date assolute servono
  // solo a restare nella finestra di osservazione, quindi le ricalcoliamo.
  const recent = rlRun({ created_at: rlIso(nowSec - 1800), updated_at: rlIso(nowSec - 1700) });
  const r = runRateLimitRescuer({ resetAt: nowSec - RATE_LIMIT_RESET_GRACE_SEC - 5, runs: [recent] });
  assert.equal(r.status, 0, r.stderr);
  const commentAt = r.calls.findIndex((c) => c.startsWith('pr comment 1800'));
  const rerunAt = r.calls.findIndex((c) => c === 'run rerun 36105446627 --repo nanakokyobashi-rgb/frontaliere-articles');
  assert.ok(commentAt >= 0 && rerunAt > commentAt, `marker requested PRIMA del rerun:\n${r.calls.join('\n')}`);
  assert.match(r.calls[commentAt], /REVIEW_RATE_LIMIT_RETRY: .*"state":"requested"/);
  assert.match(r.stdout, /rate-limit richiesti=1/);
});

test('rate limit: prima del reset nessun rerun (rientrerebbe nel bucket vuoto)', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const recent = rlRun({ created_at: rlIso(nowSec - 600), updated_at: rlIso(nowSec - 500) });
  const r = runRateLimitRescuer({ resetAt: nowSec + 900, runs: [recent] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.some((c) => c.startsWith('run rerun') || c.startsWith('pr comment')), false, r.calls.join('\n'));
  assert.match(r.stdout, /rerun rimandato di \d+ s/);
});

test('rate limit: un marker requested sulla HEAD chiude il percorso, senza leggere job e annotation', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const recent = rlRun({ created_at: rlIso(nowSec - 1800), updated_at: rlIso(nowSec - 1700) });
  const r = runRateLimitRescuer({ resetAt: nowSec - 600, runs: [recent], comments: [rlComment('requested')] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.some((c) => c.includes('/jobs') || c.startsWith('run rerun')), false, r.calls.join('\n'));
  assert.match(r.stdout, /rerun post-reset gia' richiesto/);
});

test('rate limit: fuori dai completamenti di tests lo scan non legge nemmeno le run', () => {
  const r = runRateLimitRescuer({ resetAt: 1, scan: 'false' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.some((c) => c.includes('/actions/workflows/tests.yml/runs')), false, r.calls.join('\n'));
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/review-quota-rescuer.yml'), 'utf8');
  assert.match(workflow, /REVIEW_RATE_LIMIT_SCAN: \$\{\{ github\.event_name != 'workflow_run' \|\| github\.event\.workflow_run\.name == 'tests' \}\}/);
});
