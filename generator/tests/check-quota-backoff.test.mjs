import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activeQuotaLeases,
  beaconCandidates,
  mergeBeaconCandidates,
  quotaLeaseDecision,
  reviewQuotaDeferredBody,
  parseReviewQuotaDeferredMarker,
} from '../../scripts/ci/check-quota-backoff.mjs';
import { quotaPromotionDecision } from '../../scripts/ci/followup-drainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('il drainer non congela la coda quando il fixer ha Codex fallback', () => {
  const nowSec = 1_800_000_000;
  assert.deepEqual(
    quotaPromotionDecision(nowSec + 600, { nowSec, codexFallbackMode: false }),
    { active: true, quotaBlocked: true, codexFallback: false },
  );
  assert.deepEqual(
    quotaPromotionDecision(nowSec + 600, { nowSec, codexFallbackMode: true }),
    { active: true, quotaBlocked: false, codexFallback: true },
  );
  assert.deepEqual(
    quotaPromotionDecision(nowSec - 1, { nowSec, codexFallbackMode: true }),
    { active: false, quotaBlocked: false, codexFallback: false },
  );
});

test('#984: i candidati del beacon comprendono issue e PR del peer senza duplicati', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  assert.deepEqual(
    beaconCandidates([
      [{ number: 4, updatedAt: '2026-09-08T11:00:00Z' }],
      [
        { number: 4, updatedAt: '2026-09-08T11:30:00Z' },
        { number: 7, updatedAt: '2026-09-08T11:45:00Z' },
      ],
    ], { now, lookbackH: 24, max: 12 }),
    [7, 4],
  );
});
test('#984: la lettura del beacon è collegata a PR e commenti REST paginati', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs'), 'utf8');
  assert.match(src, /listPullRequests\(scope\)/,
    'il pre-flight non deve restare cieco ai beacon scritti sui thread delle PR');
  assert.match(src, /'pr', 'list'/,
    'il peer PR deve essere interrogato con la stessa finestra bounded');
  assert.match(src, /api', '--paginate', '--slurp/,
    'i commenti devono essere letti oltre la prima pagina');
  assert.match(src, /comments\?per_page=100/);
});
test('#1243: il tetto riserva un candidato PR quando la coda issue è piena', () => {
  assert.deepEqual(
    mergeBeaconCandidates([12, 11, 10], [99, 98], 3),
    [12, 11, 99],
  );
  assert.deepEqual(
    mergeBeaconCandidates([12, 11], [11, 99], 3),
    [12, 11, 99],
  );
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs'), 'utf8');
  assert.match(src, /const issueCandidates = beaconCandidates\(\[/);
  assert.match(src, /const prCandidates = beaconCandidates\(\[listPullRequests\(scope\)\], opts\)/);
  assert.match(src, /mergeBeaconCandidates\(issueCandidates, prCandidates, MAX_ISSUES\)/);
});

test('#8365: il lease riserva il floor issue-fix e nega il consumer concorrente', () => {
  const nowSec = 1_800_000_000;
  const reserved = {
    token: 'quota-drainer-1', role: 'issue-fix', targetType: 'issue', target: '12',
    state: 'reserved', issuedAt: nowSec - 10, expiresAt: nowSec + 600,
  };
  assert.deepEqual(
    quotaLeaseDecision({
      action: 'acquire', role: 'review', targetType: 'pr', target: '99',
      activeLeases: [reserved], queueDepth: 3, nowSec,
    }),
    { allowed: false, error: false, reason: 'issue-fix-slot-active' },
  );
  assert.deepEqual(
    quotaLeaseDecision({
      action: 'consume', role: 'issue-fix', targetType: 'issue', target: '12',
      activeLeases: [reserved], queueDepth: 3, nowSec,
    }),
    {
      allowed: true,
      existing: true,
      token: 'quota-drainer-1',
      state: 'reserved',
      reason: 'issue-fix-slot-reserved-for-target',
    },
  );
  assert.equal(
    quotaLeaseDecision({
      action: 'consume', role: 'issue-fix', targetType: 'issue', target: '13',
      activeLeases: [reserved], queueDepth: 3, nowSec,
    }).allowed,
    false,
  );
});

test('#1360: il lease ammette sette fixer Codex-primary ma non l’ottavo', () => {
  const nowSec = 1_800_000_000;
  const lease = (number) => ({
    token: `quota-drainer-${number}`,
    role: 'issue-fix',
    targetType: 'issue',
    target: String(number),
    state: 'reserved',
    issuedAt: nowSec - 10,
    expiresAt: nowSec + 600,
  });
  const pool = [1, 2, 3, 4, 5, 6, 7].map(lease);

  for (let occupied = 0; occupied < 7; occupied += 1) {
    assert.equal(
      quotaLeaseDecision({
        action: 'reserve', role: 'issue-fix', targetType: 'issue', target: '99',
        activeLeases: pool.slice(0, occupied), queueDepth: 10, nowSec,
        maxIssueFixLeases: 7,
      }).allowed,
      true,
      `il fixer ${occupied + 1} deve entrare nel pool`,
    );
  }
  assert.deepEqual(
    quotaLeaseDecision({
      action: 'reserve', role: 'issue-fix', targetType: 'issue', target: '99',
      activeLeases: pool, queueDepth: 10, nowSec, maxIssueFixLeases: 7,
    }),
    { allowed: false, error: false, reason: 'issue-fix-pool-full' },
  );
  assert.equal(
    quotaLeaseDecision({
      action: 'consume', role: 'issue-fix', targetType: 'issue', target: '3',
      activeLeases: pool, queueDepth: 10, nowSec, maxIssueFixLeases: 7,
    }).allowed,
    true,
    'il fixer rilanciato deve adottare la reservation anche con gli altri slot vivi',
  );
  assert.equal(
    quotaLeaseDecision({
      action: 'acquire', role: 'review', targetType: 'pr', target: '99',
      activeLeases: pool, queueDepth: 0, nowSec, maxIssueFixLeases: 7,
    }).reason,
    'issue-fix-slot-active',
    'review e redcheck non possono aggiungersi al pool Codex issue-fix',
  );
});

test('#8365: il workflow rilanciato può adottare la reservation della stessa PR', () => {
  const nowSec = 1_800_000_000;
  const headSha = 'a'.repeat(40);
  const reserved = {
    token: 'quota-review-rescue', role: 'review', targetType: 'pr', target: '99',
    state: 'reserved', issuedAt: nowSec - 10, expiresAt: nowSec + 600,
    headSha, reservationRunId: 'source-run-99',
  };
  assert.deepEqual(
    quotaLeaseDecision({
      action: 'acquire', role: 'review', targetType: 'pr', target: '99',
      activeLeases: [reserved], queueDepth: 51, nowSec,
      headSha, runId: 'source-run-99',
    }),
    {
      allowed: true,
      existing: true,
      token: 'quota-review-rescue',
      state: 'reserved',
      reason: 'shared-quota-lease-reserved-for-head-run',
    },
  );
  assert.equal(
    quotaLeaseDecision({
      action: 'acquire', role: 'review', targetType: 'pr', target: '99',
      activeLeases: [{ ...reserved, state: 'active' }], queueDepth: 51, nowSec,
      headSha, runId: 'source-run-99',
    }).allowed,
    false,
    'un lease active non può essere adottato da una seconda run',
  );
  assert.equal(
    quotaLeaseDecision({
      action: 'acquire', role: 'review', targetType: 'pr', target: '99',
      activeLeases: [reserved], queueDepth: 51, nowSec,
      headSha: 'b'.repeat(40), runId: 'source-run-99',
    }).allowed,
    false,
    'una reservation di un’altra HEAD non può essere adottata',
  );
  assert.deepEqual(
    quotaLeaseDecision({
      action: 'acquire', role: 'review', targetType: 'pr', target: '99',
      activeLeases: [reserved, { ...reserved, token: 'other', target: '100' }],
      queueDepth: 51, nowSec, headSha, runId: 'source-run-99',
    }),
    { allowed: false, error: false, reason: 'shared-quota-lease-reservation-contended' },
    'la reservation non è un lasciapassare se un altro lease è live',
  );
});

test('#8365: il marker di deferral è head-pinned e porta il consumer sorgente', () => {
  const body = reviewQuotaDeferredBody({
    head: 'a'.repeat(40), runId: '123', role: 'redcheck', reason: 'shared-quota-lease-active',
  });
  assert.deepEqual(parseReviewQuotaDeferredMarker(body), {
    version: 1,
    head: 'a'.repeat(40),
    runId: '123',
    role: 'redcheck',
    reason: 'shared-quota-lease-active',
  });
  assert.equal(parseReviewQuotaDeferredMarker(body.replace('redcheck', 'unknown')), null);
});

test('#8365: il marker di deferral registra l’attempt sorgente quando disponibile', () => {
  const body = reviewQuotaDeferredBody({
    head: 'a'.repeat(40), runId: '123', role: 'review', reason: 'floor', sourceAttempt: 4,
  });
  assert.equal(parseReviewQuotaDeferredMarker(body).sourceAttempt, 4);
  assert.equal(
    parseReviewQuotaDeferredMarker(body.replace('"sourceAttempt":4', '"sourceAttempt":0')),
    null,
  );
});

test('#8365: i fixer usano il marker v2 con provenienza workflow e trigger HEAD-pinned', () => {
  const head = 'a'.repeat(40);
  const body = reviewQuotaDeferredBody({
    head,
    runId: '123',
    role: 'redcheck',
    reason: 'shared-quota-lease-active',
    sourceAttempt: 2,
    prNumber: 99,
    sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
    sourceEvent: 'workflow_run',
    triggerRunId: '456',
    triggerHead: head,
  });
  assert.ok(body);
  assert.deepEqual(parseReviewQuotaDeferredMarker(body), {
    version: 2,
    head,
    runId: '123',
    role: 'redcheck',
    reason: 'shared-quota-lease-active',
    prNumber: '99',
    sourceAttempt: 2,
    sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
    sourceEvent: 'workflow_run',
    triggerRunId: '456',
    triggerHead: head,
  });
  assert.equal(
    reviewQuotaDeferredBody({
      head,
      runId: '123',
      role: 'redcheck',
      reason: 'shared-quota-lease-active',
      sourceAttempt: 2,
      prNumber: 99,
      sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
      sourceEvent: 'workflow_run',
      triggerRunId: '456',
      triggerHead: 'b'.repeat(40),
    }),
    '',
    'il trigger deve dimostrare la stessa HEAD della PR',
  );
  assert.equal(
    reviewQuotaDeferredBody({
      head,
      runId: '123',
      role: 'redcheck',
      reason: 'shared-quota-lease-active',
      sourceAttempt: 2,
      prNumber: 99,
      sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
      sourceEvent: 'workflow_run',
      triggerRunId: '456',
    }),
    '',
    'workflow_run senza trigger HEAD non è verificabile',
  );
  assert.equal(
    reviewQuotaDeferredBody({
      head,
      runId: '123',
      role: 'redcheck',
      reason: 'shared-quota-lease-active',
      sourceAttempt: 2,
      prNumber: 99,
      sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
      sourceEvent: 'workflow_run',
      triggerHead: head,
    }),
    '',
    'triggerRunId e triggerHead sono una coppia indivisibile',
  );
  const dispatchBody = reviewQuotaDeferredBody({
    head,
    runId: '123',
    role: 'redcheck',
    reason: 'shared-quota-lease-active',
    sourceAttempt: 2,
    prNumber: 99,
    sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
    sourceEvent: 'workflow_dispatch',
    triggerRunId: '456',
    triggerHead: head,
  });
  assert.equal(parseReviewQuotaDeferredMarker(dispatchBody)?.sourceEvent, 'workflow_dispatch');
  const dispatchWithoutTrigger = reviewQuotaDeferredBody({
    head,
    runId: '123',
    role: 'redcheck',
    reason: 'shared-quota-lease-active',
    sourceAttempt: 2,
    prNumber: 99,
    sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
    sourceEvent: 'workflow_dispatch',
  });
  assert.equal(parseReviewQuotaDeferredMarker(dispatchWithoutTrigger)?.sourceEvent, 'workflow_dispatch');
  assert.equal(
    reviewQuotaDeferredBody({
      head,
      runId: '123',
      role: 'redcheck',
      reason: 'shared-quota-lease-active',
      sourceAttempt: 2,
      prNumber: 99,
      sourceWorkflow: '.github/workflows/pr-redcheck-fixer.yml',
      sourceEvent: 'workflow_dispatch',
      triggerHead: head,
    }),
    '',
    'trigger parziale non è un intent dispatch verificabile',
  );
});

test('#8365: lease scaduto o rilasciato non blocca il tick successivo', () => {
  const nowSec = 1_800_000_000;
  const expired = {
    token: 'expired', role: 'issue-fix', targetType: 'issue', target: '12',
    state: 'reserved', issuedAt: nowSec - 900, expiresAt: nowSec - 1,
  };
  const active = {
    token: 'released', role: 'review', targetType: 'pr', target: '99',
    state: 'active', issuedAt: nowSec - 10, expiresAt: nowSec + 600,
  };
  const released = { ...active, state: 'released', issuedAt: nowSec, expiresAt: nowSec + 600 };
  assert.deepEqual(activeQuotaLeases([expired, active, released], { nowSec }), []);
  assert.equal(
    quotaLeaseDecision({
      action: 'acquire', role: 'issue-decompose', targetType: 'issue', target: '99',
      activeLeases: [], queueDepth: 0, nowSec,
    }).allowed,
    true,
  );
  assert.equal(
    quotaLeaseDecision({
      action: 'acquire', role: 'issue-decompose', targetType: 'issue', target: '99',
      activeLeases: [], queueDepth: 1, nowSec,
    }).reason,
    'issue-fix-floor-unreserved',
  );
});

test('#8365: review e fixer PR non restano affamati dalla coda issue', () => {
  const nowSec = 1_800_000_000;
  for (const role of ['review', 'redflag', 'redcheck']) {
    assert.equal(
      quotaLeaseDecision({
        action: 'acquire', role, targetType: 'pr', target: '99',
        activeLeases: [], queueDepth: 51, nowSec,
      }).allowed,
      true,
      `${role} deve poter contendere lo slot quando la coda issue è non vuota`,
    );
  }
  assert.equal(
    quotaLeaseDecision({
      action: 'acquire', role: 'unknown-consumer', targetType: 'pr', target: '99',
      activeLeases: [], queueDepth: 51, nowSec,
    }).reason,
    'issue-fix-floor-unreserved',
  );
});

test('#8365: il percorso CLI del lease è fail-closed e non altera il manifest', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs'), 'utf8');
  assert.match(src, /QUOTA_LEASE_MARKER/);
  assert.match(src, /lease_allowed/);
  assert.match(src, /lease-api-or-parse-error/);
  assert.match(src, /api', '--paginate', '--slurp/);
  assert.doesNotMatch(src, /dist\/api\/manifest\.json.*write|write.*dist\/api\/manifest\.json/s);
});

test('#8365: una contesa dopo la rilettura lascia il marker per il rescuer PR', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs'), 'utf8');
  const contention = src.slice(src.indexOf('if (!existing && role !== \'issue-fix\' && liveAfter.length !== 1)'));
  assert.match(contention, /postReviewQuotaDeferred\(/,
    'il perdente della contesa non deve sparire senza deferral head-pinned');
  assert.match(contention, /shared-quota-lease-contention/);
});
