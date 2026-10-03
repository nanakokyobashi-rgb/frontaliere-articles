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
  quotaLeaseReservationContended,
  reviewQuotaDeferredBody,
  parseReviewQuotaDeferredMarker,
  runQuotaGitHubCommand,
  FIX_QUEUE_NON_PROMOTABLE_LABELS,
  flattenPaginatedIssueRows,
  isPromotableFixQueueRow,
  promotableFixQueueDepth,
} from '../../scripts/ci/check-quota-backoff.mjs';
import { quotaPromotionDecision, isDrainPromotable } from '../../scripts/ci/followup-drainer.mjs';

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

test('#1881: il gate quota ritenta un 403 primario del bucket REST', () => {
  const calls = [];
  const sleeps = [];
  let limited = true;
  const rateLimit = Object.assign(new Error('Command failed: gh'), {
    stderr: 'gh: API rate limit exceeded for installation (HTTP 403)',
  });
  const result = runQuotaGitHubCommand(['api', 'repos/example/repo/issues/12/comments'], {
    context: 'test quota lease',
    now: () => Date.parse('2026-09-25T07:00:00Z'),
    sleep: (ms) => sleeps.push(ms),
    random: () => 0,
    jitterMaxMs: 0,
    budget: { waits: 1 },
    log: () => {},
    exec: (_bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'api' && args[1] === 'rate_limit') {
        return JSON.stringify({ resources: { core: { remaining: 0, reset: 1_790_319_660 } } });
      }
      if (limited) {
        limited = false;
        throw rateLimit;
      }
      return '[{"id":12}]';
    },
  });

  assert.equal(result, '[{"id":12}]');
  assert.deepEqual(calls, [
    'api repos/example/repo/issues/12/comments',
    'api rate_limit',
    'api repos/example/repo/issues/12/comments',
  ]);
  assert.deepEqual(sleeps, [60_000]);
});

test('#8365: una contesa dopo la rilettura lascia il marker per il rescuer PR', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs'), 'utf8');
  const contention = src.slice(src.indexOf('if (!existing && role !== \'issue-fix\' && liveAfter.length !== 1)'));
  assert.match(contention, /postReviewQuotaDeferred\(/,
    'il perdente della contesa non deve sparire senza deferral head-pinned');
  assert.match(contention, /shared-quota-lease-contention/);
});

test('#1495: una agent:fix-queued parcheggiata non tiene il floor issue-fix e non blocca issue-decompose', () => {
  const nowSec = 1_800_000_000;
  // Caso reale dal 12-09: #1495 porta sia `agent:fix-queued` sia `fu-parked`;
  // il drainer non la promuove mai, quindi non e' coda per il floor.
  const rows = [{ number: 1495, labels: [{ name: 'agent:fix-queued' }, { name: 'fu-parked' }] }];
  const queueDepth = promotableFixQueueDepth(rows);
  assert.equal(queueDepth, 0);
  const decision = quotaLeaseDecision({
    action: 'acquire', role: 'issue-decompose', targetType: 'issue', target: '1084',
    activeLeases: [], queueDepth, nowSec,
  });
  assert.equal(decision.allowed, true, decision.reason);
  assert.notEqual(decision.reason, 'issue-fix-floor-unreserved');

  // Una promuovibile accanto alla parcheggiata riserva ancora il floor.
  const withLive = [...rows, { number: 1500, labels: [{ name: 'agent:fix-queued' }] }];
  assert.equal(promotableFixQueueDepth(withLive), 1);
  assert.equal(quotaLeaseDecision({
    action: 'acquire', role: 'issue-decompose', targetType: 'issue', target: '1084',
    activeLeases: [], queueDepth: promotableFixQueueDepth(withLive), nowSec,
  }).reason, 'issue-fix-floor-unreserved');

  // Label illeggibili: fail-closed, la riga resta contata.
  assert.equal(promotableFixQueueDepth([{ number: 7 }]), 1);
});

test('#1495: la profondita della coda e\' lo specchio esatto di isDrainPromotable del drainer', () => {
  const extra = ['agent:fix-queued', 'priority:high', 'from-decompose', 'needs-human'];
  const universe = [...new Set([...FIX_QUEUE_NON_PROMOTABLE_LABELS, ...extra])];
  const issue = (labels) => ({ labels: labels.map((name) => ({ name })) });
  // Ogni label da sola e ogni coppia: un'etichetta che il drainer salta e che
  // la coda conta (o viceversa) rompe qui, non nel lease di produzione.
  const cases = [[], ...universe.map((l) => ['agent:fix-queued', l])];
  for (let i = 0; i < universe.length; i += 1) {
    for (let j = i + 1; j < universe.length; j += 1) cases.push(['agent:fix-queued', universe[i], universe[j]]);
  }
  for (const labels of cases) {
    assert.equal(
      isPromotableFixQueueRow(issue(labels)),
      isDrainPromotable(issue(labels)),
      `divergenza con isDrainPromotable su [${labels.join(', ')}]`,
    );
  }
});

test('#10171: la coda completa attraversa piu pagine REST e non perde la prima issue promuovibile', () => {
  const parked = Array.from({ length: 101 }, (_, index) => ({
    number: index + 1,
    labels: [{ name: 'fu-parked' }],
  }));
  const pages = [
    parked.slice(0, 100).map((row) => ({ ...row, pull_request: undefined })),
    [
      { ...parked[100], pull_request: undefined },
      { number: 999, labels: [], pull_request: undefined },
      { number: 1000, labels: [], pull_request: { url: 'https://example.test/pr/1000' } },
    ],
  ];
  const rows = flattenPaginatedIssueRows(pages, 'issue-fix queue');
  assert.equal(rows.length, 102);
  assert.equal(promotableFixQueueDepth(rows), 1);
  assert.equal(rows.some((row) => row.number === 1000), false, 'le pull request non sono issue candidate');
});

test('#1495: il lease legge le label della coda per calcolarne la profondita', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs'), 'utf8');
  assert.match(source, /const queueDepth = promotableFixQueueDepth\(leaseIssueRows\(\s*repo, 'agent:fix-queued',[\s\S]*?\{ paginate: true \}/);
});

// Titolo di fallimento: «Stadio decompose: reservation prenotata e mai consumata».
test('#1084: il consumo di una reservation issue-decompose applica la regola di esclusività dell’acquire', () => {
  const nowSec = 1_800_000_000;
  const lease = (token, role, targetType, target, state) => ({
    token, role, targetType, target, state, issuedAt: nowSec - 10, expiresAt: nowSec + 600,
  });
  const own = lease('quota-drainer-decompose', 'issue-decompose', 'issue', '1084', 'reserved');
  const consume = (activeLeases, extra = {}) => quotaLeaseDecision({
    action: 'consume', role: 'issue-decompose', targetType: 'issue', target: '1084',
    activeLeases, queueDepth: 0, nowSec, ...extra,
  });

  // La reservation del drainer è l'unico lease vivo: non è concorrente di sé stessa.
  const granted = consume([own]);
  assert.equal(granted.allowed, true, `Stadio decompose: reservation prenotata e mai consumata (${granted.reason})`);
  assert.equal(granted.existing, true);
  assert.equal(granted.token, own.token);
  // La coda issue-fix non c'entra: lo slot è già stato prenotato dal drainer.
  assert.equal(consume([own], { queueDepth: 5 }).allowed, true);

  // Il cancello non si allarga: un qualunque altro lease vivo nega il consumo.
  const contended = { allowed: false, error: false, reason: 'shared-quota-lease-reservation-contended' };
  assert.deepEqual(consume([own, lease('fix', 'issue-fix', 'issue', '12', 'consumed')]), contended);
  assert.deepEqual(consume([own, lease('fix', 'issue-fix', 'issue', '12', 'reserved')], { maxIssueFixLeases: 7 }), contended);
  assert.deepEqual(consume([own, lease('rev', 'review', 'pr', '99', 'active')]), contended);
  assert.deepEqual(consume([own, lease('dup', 'issue-decompose', 'issue', '1084', 'reserved')]), contended);

  // Un lease scaduto o rilasciato non è concorrenza.
  assert.equal(consume([own, { ...lease('old', 'review', 'pr', '99', 'active'), expiresAt: nowSec - 1 }]).allowed, true);
  assert.equal(consume([own, lease('gone', 'review', 'pr', '99', 'released')]).allowed, true);

  // Senza reservation propria il ramo diretto resta quello di prima.
  assert.equal(consume([lease('rev', 'review', 'pr', '99', 'active')]).reason, 'shared-quota-lease-active');
  assert.equal(consume([], { queueDepth: 1 }).reason, 'issue-fix-floor-unreserved');
});

test('#1084: il consumo issue-fix con pool pieno resta invariato', () => {
  const nowSec = 1_800_000_000;
  const fix = (target, state = 'consumed') => ({
    token: `fix-${target}`, role: 'issue-fix', targetType: 'issue', target: String(target),
    state, issuedAt: nowSec - 10, expiresAt: nowSec + 600,
  });
  const consume = (target, activeLeases, maxIssueFixLeases) => quotaLeaseDecision({
    action: 'consume', role: 'issue-fix', targetType: 'issue', target: String(target),
    activeLeases, queueDepth: 3, nowSec, maxIssueFixLeases,
  });
  const pool = [fix(1), fix(2), fix(3, 'reserved')];
  // Reservation propria dentro il tetto: consumabile insieme agli altri fixer.
  assert.equal(consume(3, pool, 3).allowed, true);
  // Pool oltre il tetto: la reservation è contesa.
  assert.equal(consume(3, pool, 2).reason, 'shared-quota-lease-reservation-contended');
  // Un lease di un altro ruolo contende anche dentro il tetto.
  assert.equal(
    consume(3, [...pool, { ...fix(9), role: 'review', targetType: 'pr' }], 7).reason,
    'shared-quota-lease-reservation-contended',
  );
  // Nessuna reservation e pool pieno: rifiuto diretto, come prima.
  assert.equal(consume(4, pool, 3).reason, 'issue-fix-pool-full');
});

test('#1084: il predicato di contesa copre la rilettura dopo la scrittura', () => {
  const own = { token: 'own', role: 'issue-decompose' };
  const fix = (token) => ({ token, role: 'issue-fix' });
  // Ruolo esclusivo: dopo la scrittura deve restare solo il proprio lease.
  assert.equal(quotaLeaseReservationContended({ role: 'issue-decompose', live: [own] }), false);
  assert.equal(quotaLeaseReservationContended({ role: 'issue-decompose', live: [own, fix('a')] }), true);
  assert.equal(quotaLeaseReservationContended({ role: 'issue-decompose', live: [own, fix('a')], issueFixPool: 7 }), true);
  assert.equal(quotaLeaseReservationContended({ role: 'review', live: [{ token: 'r', role: 'review' }, own] }), true);
  assert.equal(quotaLeaseReservationContended({ role: 'issue-decompose', live: [] }), true);
  // Pool issue-fix: tetto e ruoli estranei.
  assert.equal(quotaLeaseReservationContended({ role: 'issue-fix', live: [fix('a'), fix('b')], issueFixPool: 2 }), false);
  assert.equal(quotaLeaseReservationContended({ role: 'issue-fix', live: [fix('a'), fix('b')], issueFixPool: 1 }), true);
  assert.equal(quotaLeaseReservationContended({ role: 'issue-fix', live: [fix('a'), own], issueFixPool: 7 }), true);
});

test('#1084: acquire e consume danno la stessa risposta di contesa del predicato, per ogni ruolo', () => {
  const nowSec = 1_800_000_000;
  const headSha = 'a'.repeat(40);
  const runId = '4242';
  const lease = (token, role, targetType, target, state = 'consumed') => ({
    token, role, targetType, target: String(target), state, issuedAt: nowSec - 10, expiresAt: nowSec + 600,
  });
  const CONTENDED = 'shared-quota-lease-reservation-contended';
  const roles = [
    { role: 'issue-decompose', targetType: 'issue', target: '1084' },
    { role: 'review', targetType: 'pr', target: '77' },
    { role: 'issue-fix', targetType: 'issue', target: '55' },
  ];
  for (const { role, targetType, target } of roles) {
    // Reservation propria, bound a HEAD e run: adottabile da acquire, consumabile da consume.
    const own = { ...lease('own', role, targetType, target, 'reserved'), headSha, reservationRunId: runId };
    const others = {
      'solo la propria reservation': [],
      'più un issue-fix': [lease('fix-a', 'issue-fix', 'issue', 12)],
      'più due issue-fix': [lease('fix-a', 'issue-fix', 'issue', 12), lease('fix-b', 'issue-fix', 'issue', 13, 'reserved')],
      'più un review': [lease('rev', 'review', 'pr', 99, 'active')],
      'più un issue-decompose': [lease('dec', 'issue-decompose', 'issue', 300, 'reserved')],
      'doppia reservation': [{ ...own, token: 'dup' }],
    };
    for (const [label, extra] of Object.entries(others)) {
      for (const maxIssueFixLeases of [1, 2, 3, 7]) {
        const live = [own, ...extra];
        const expected = quotaLeaseReservationContended({ role, live, issueFixPool: maxIssueFixLeases });
        const args = { role, targetType, target, activeLeases: live, queueDepth: 0, nowSec, maxIssueFixLeases };
        const where = `${role}, ${label}, pool ${maxIssueFixLeases}`;
        const consumed = quotaLeaseDecision({ action: 'consume', ...args });
        const acquired = quotaLeaseDecision({ action: 'acquire', headSha, runId, ...args });
        assert.equal(consumed.reason === CONTENDED, expected, `consume diverge dal predicato (${where}): ${consumed.reason}`);
        assert.equal(acquired.reason === CONTENDED, expected, `acquire diverge dal predicato (${where}): ${acquired.reason}`);
        // Non contesa = la reservation propria viene adottata, non un altro rifiuto.
        assert.equal(consumed.allowed, !expected, `consume (${where}): ${consumed.reason}`);
        assert.equal(acquired.allowed, !expected, `acquire (${where}): ${acquired.reason}`);
      }
    }
  }
});
