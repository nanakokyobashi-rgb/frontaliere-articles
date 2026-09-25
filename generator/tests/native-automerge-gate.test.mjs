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
  id: 100,
  name: 'tests (node --test)',
  head_sha: HEAD,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-09-13T12:00:00Z',
  completed_at: '2026-09-13T12:01:00Z',
  details_url: 'https://github.com/owner/repo/actions/runs/200/job/300',
  check_suite: { id: 100 },
  external_id: '00000000-0000-4000-8000-000000000100',
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

test('il gate segue la generazione e non completed_at, e resta pending sul run nuovo', () => {
  const newest = check({
    id: 200,
    created_at: '2026-09-13T12:05:00Z',
    completed_at: '2026-09-13T12:06:00Z',
    conclusion: 'success',
    details_url: 'https://github.com/owner/repo/actions/runs/205/job/300',
    check_suite: { id: 200 },
    external_id: '00000000-0000-4000-8000-000000000200',
  });
  const old = check({
    id: 199,
    created_at: '2026-09-13T12:00:00Z',
    completed_at: '2026-09-13T12:07:00Z',
    conclusion: 'failure',
    details_url: 'https://github.com/owner/repo/actions/runs/204/job/300',
    check_suite: { id: 199 },
    external_id: '00000000-0000-4000-8000-000000000199',
  });
  assert.equal(requiredVitestDecision([newest, old], HEAD).allow, true);

  const pending = check({
    id: 201,
    status: 'in_progress',
    conclusion: null,
    created_at: '2026-09-13T12:08:00Z',
    completed_at: null,
    details_url: 'https://github.com/owner/repo/actions/runs/206/job/300',
    check_suite: { id: 201 },
    external_id: '00000000-0000-4000-8000-000000000201',
  });
  assert.equal(requiredVitestDecision([newest, pending], HEAD).allow, false);
  assert.match(requiredVitestDecision([newest, pending], HEAD).reason, /pending/);
});

test('il gate rifiuta un duplicato con identità di correlazione diversa', () => {
  const base = check();
  const conflicting = {
    ...base,
    details_url: 'https://github.com/owner/repo/actions/runs/201/job/301',
    external_id: '00000000-0000-4000-8000-000000000101',
  };
  assert.equal(requiredVitestDecision([base, conflicting], HEAD).allow, false);
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
  // Il conteggio sta nella SEZIONE, non sul titolo: shape della review
  // 5258385493 (PR #9315 del sito). Leggendo solo il titolo il gate non
  // apriva l'auto-merge su una review a zero finding con `## LGTM`.
  assert.equal(reviewHasZeroFindings('## Scope\n\nx\n\n## Findings\n\nImportant: 0\n\n## LGTM'), true);
  assert.equal(reviewIsApproved(review('## Findings\n\nImportant: 0\n\n## LGTM')), true);
  assert.equal(reviewHasZeroFindings('## Findings\n\nImportant: 2\n\n## LGTM'), false);
  // Nessun conteggio riconoscibile in sezione → fail-closed, come prima.
  assert.equal(reviewHasZeroFindings('## Findings\n\nNothing worth blocking on.\n\n## LGTM'), false);
  // Un 🔴 Important reale batte un conteggio a zero, ovunque si trovi.
  assert.equal(reviewHasZeroFindings('## Findings\n\nImportant: 0\n\n🔴 Important: not harmless\n\n## LGTM'), false);
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

// ── #1870: LGTM Codex fallback su un commit precedente dopo un merge di main ──
//
// Fixture ricostruita dai dati reali della PR #1859 del 2026-09-25: la review
// Codex (`github-actions[bot]` + marker) e' su 403b720c, l'autorebase ha
// pushato il merge di main e5472174, e nella run pull_request 36107775105 il
// `Re-review guard` ha saltato Codex per fingerprint del contributo invariato
// mentre `Require approving Codex review` ha fatto il carry-forward. Prima della
// fix il gate nativo rispondeva «nessuna review bot verificabile» per sempre:
// nessun Codex nuovo sarebbe partito, perche' il guard salta sempre.
const REPO_1859 = 'nanakokyobashi-rgb/frontaliere-articles';
const HEAD_1859 = 'e547217413475dec49b4099e992ba63b061ad4f1';
const REVIEWED_1859 = '403b720c0805fade9a32b10892c2171a4383ed95';
const REVISION_1859 = 'body:d084ee9b75500acb71a20d58acad1836b74948fa098edb116a6661d23368b372';
const CODEX_BODY_1859 = "<!-- REVIEW_INPUT_REVISION: body:d084ee9b75500acb71a20d58acad1836b74948fa098edb116a6661d23368b372 -->\n<!-- CODEX_FALLBACK_REVIEW -->\n\n## Scope\n\nRegistrazione di un nuovo content gate per l'articolo sul telelavoro nella lista eseguita su `main` e sottratta alla suite PR (tier: normal).\n\n## Findings (Important: 0, Nit: 0)\n\nNessun finding.\n\n## LGTM\n\nLa voce è aggiunta al punto alfabeticamente corretto di `CONTENT_GATES`; il body è valido secondo il contratto deterministico e il diff non introduce altro codice reviewabile.\n";

const codexReview1859 = (overrides = {}) => ({
  id: 5314800839,
  user: { login: 'github-actions[bot]', type: 'Bot' },
  state: 'COMMENTED',
  commit_id: REVIEWED_1859,
  created_at: '2026-09-25T07:24:18Z',
  submitted_at: '2026-09-25T07:24:18Z',
  updated_at: '2026-09-25T07:24:18Z',
  body: CODEX_BODY_1859,
  ...overrides,
});

// Gli step reali del job 107984139025, nell'ordine della Jobs API.
const STEPS_1859 = [
  ['Set up job', 'success', '2026-09-25T07:29:03Z', '2026-09-25T07:29:04Z'],
  ['Resolve trusted GitHub CLI (before checkout)', 'success', '2026-09-25T07:29:04Z', '2026-09-25T07:29:05Z'],
  ['Run actions/checkout@v5', 'success', '2026-09-25T07:29:05Z', '2026-09-25T07:29:57Z'],
  ['Run actions/setup-node@v5', 'success', '2026-09-25T07:29:57Z', '2026-09-25T07:29:58Z'],
  ['PR-body completeness + multi-issue Closes (zero-Claude)', 'success', '2026-09-25T07:29:58Z', '2026-09-25T07:29:59Z'],
  ['Unit + closure gates (i gate sul contenuto girano altrove)', 'success', '2026-09-25T07:29:59Z', '2026-09-25T07:31:36Z'],
  ['Report node:test failures on PR', 'skipped', '2026-09-25T07:31:36Z', '2026-09-25T07:31:36Z'],
  ['Baseline verificabili nel manifest del ciclo (diff-scoped)', 'success', '2026-09-25T07:31:36Z', '2026-09-25T07:31:36Z'],
  ['Resolve PR', 'success', '2026-09-25T07:31:36Z', '2026-09-25T07:31:36Z'],
  ['Bootstrap trusted review gate from main', 'success', '2026-09-25T07:31:36Z', '2026-09-25T07:31:37Z'],
  ['Resolve review input revision (zero-Claude)', 'success', '2026-09-25T07:31:37Z', '2026-09-25T07:31:38Z'],
  ['Re-review guard (skip Codex when no code changed since last LGTM)', 'success', '2026-09-25T07:31:38Z', '2026-09-25T07:31:43Z'],
  ['Claim review PR + HEAD + contribution (zero-agent)', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Fail closed when review claim is unreadable', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Skip already-consumed review contribution (zero-agent)', 'success', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Determine review tier', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Prefetch review context (zero-Claude, saves turns)', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Pre-flight — Codex lane quota telemetry', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Publish automatic LGTM for a tests-only PR', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Prepare Firebase credentials for Codex review', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Load cross-repo Codex credentials', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Run Codex Luna Max review', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Fail on transient API error (no review posted)', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Fail on non-retryable review action error (no automatic retry)', 'skipped', '2026-09-25T07:31:43Z', '2026-09-25T07:31:43Z'],
  ['Require approving Codex review', 'success', '2026-09-25T07:31:43Z', '2026-09-25T07:31:47Z'],
  ['Classify review gate failure', 'skipped', '2026-09-25T07:31:47Z', '2026-09-25T07:31:47Z'],
  ['Fail when required review gate is skipped', 'skipped', '2026-09-25T07:31:47Z', '2026-09-25T07:31:47Z'],
  ['Finalize review PR + HEAD + contribution claim', 'skipped', '2026-09-25T07:31:47Z', '2026-09-25T07:31:47Z'],
  ['Generator CI gate (solo per le PR che ne toccano i path)', 'success', '2026-09-25T07:31:47Z', '2026-09-25T07:31:48Z'],
  ['Post Run actions/setup-node@v5', 'success', '2026-09-25T07:31:48Z', '2026-09-25T07:31:48Z'],
  ['Post Run actions/checkout@v5', 'success', '2026-09-25T07:31:48Z', '2026-09-25T07:31:48Z'],
  ['Complete job', 'success', '2026-09-25T07:31:48Z', '2026-09-25T07:31:48Z'],
].map(([name, conclusion, started_at, completed_at]) => ({
  name,
  status: 'completed',
  conclusion,
  started_at,
  completed_at,
}));

/** Sostituisce la conclusion di alcuni step reali, lasciando il resto intatto. */
const steps1859 = (conclusions = {}) => STEPS_1859.map((step) => (
  Object.hasOwn(conclusions, step.name) ? { ...step, conclusion: conclusions[step.name] } : { ...step }
));

// I due check `tests` reali sulla HEAD: la run pull_request (selezionata come
// generazione piu' recente) e una workflow_dispatch di recovery.
const headChecks1859 = () => [
  {
    id: 107984139025,
    name: 'tests (node --test)',
    head_sha: HEAD_1859,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-09-25T07:29:02Z',
    completed_at: '2026-09-25T07:31:50Z',
    details_url: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/actions/runs/36107775105/job/107984139025',
    external_id: '6abcbc37-586b-5157-9f98-a22eb892c5c1',
    check_suite: { id: 97778384407 },
  },
  {
    id: 107984132997,
    name: 'tests (node --test)',
    head_sha: HEAD_1859,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-09-25T07:28:08Z',
    completed_at: '2026-09-25T07:31:03Z',
    details_url: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/actions/runs/36107771604/job/107984132997',
    external_id: '44e16536-a46a-5849-ad0f-dbbfcd33674a',
    check_suite: { id: 97778375180 },
  },
];

// Il check `tests` verde sul commit della review, chiuso dopo la review.
const reviewedCommitCheck1859 = (overrides = {}) => ({
  id: 107981803305,
  name: 'tests (node --test)',
  head_sha: REVIEWED_1859,
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-09-25T07:19:13Z',
  completed_at: '2026-09-25T07:24:31Z',
  details_url: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/actions/runs/36107029954/job/107981803305',
  external_id: '99d8eb5d-608d-5f37-86ab-11147606649a',
  check_suite: { id: 97776411740 },
  ...overrides,
});

const evidence1859 = ({ steps = steps1859(), ...overrides } = {}) => ({
  reviewId: '5314800839',
  check: headChecks1859()[0],
  workflow: {
    id: 36107775105,
    path: '.github/workflows/tests.yml',
    event: 'pull_request',
    head_sha: HEAD_1859,
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-09-25T07:28:02Z',
    updated_at: '2026-09-25T07:31:51Z',
  },
  job: {
    id: 107984139025,
    run_id: 36107775105,
    name: 'tests (node --test)',
    head_sha: HEAD_1859,
    status: 'completed',
    conclusion: 'success',
    check_run_url: 'https://api.github.com/repos/nanakokyobashi-rgb/frontaliere-articles/check-runs/107984139025',
    started_at: '2026-09-25T07:29:02Z',
    completed_at: '2026-09-25T07:31:50Z',
    steps,
  },
  pullRequest: { headSha: HEAD_1859, reviewRevision: REVISION_1859, lastEditedAt: null },
  reviewedCommitChecks: [reviewedCommitCheck1859()],
  ...overrides,
});

const evaluate1859 = ({
  reviews = [codexReview1859()],
  checkRuns = headChecks1859(),
  evidence = evidence1859(),
} = {}) => evaluateNativeAutoMerge({
  pr: pr({ number: 1859, headRefOid: HEAD_1859 }),
  reviews,
  checkRuns,
  reviewGateEvidence: evidence,
  repository: REPO_1859,
});

/** Nega, e per la ragione attesa: un rifiuto incidentale non prova il vincolo. */
const assertDenied = (decision, reason) => {
  assert.equal(decision.allow, false, decision.reason);
  assert.match(decision.reason, reason);
};

test('#1870 caso reale #1859: LGTM Codex su un commit precedente + merge di main entra con la prova del carry-forward', () => {
  const decision = evaluate1859();
  assert.equal(decision.allow, true, decision.reason);
  assert.equal(decision.reviewId, 5314800839);
  assert.match(decision.reason, /carry-forward Codex/);
});

test('#1870 codice cambiato: senza lo skip del guard o senza il check verde sul commit della review non c e carry-forward', () => {
  // Il guard NON ha saltato Codex (contributo cambiato): claim e review girano.
  assertDenied(evaluate1859({
    evidence: evidence1859({
      steps: steps1859({
        'Claim review PR + HEAD + contribution (zero-agent)': 'success',
        'Run Codex Luna Max review': 'success',
      }),
    }),
  }), /carry-forward Codex non verificato: .*Claim review.* non è skipped/);
  // Lo step del claim da solo basta: e' saltato solo quando il guard ha scritto skip=true.
  assertDenied(evaluate1859({
    evidence: evidence1859({
      steps: steps1859({ 'Claim review PR + HEAD + contribution (zero-agent)': 'success' }),
    }),
  }), /Claim review.* non è skipped/);
  // Un Codex girato o abortito in questa run non e' un carry-forward.
  assertDenied(evaluate1859({
    evidence: evidence1859({ steps: steps1859({ 'Run Codex Luna Max review': 'success' }) }),
  }), /Run Codex Luna Max review.* non è skipped/);
  assertDenied(evaluate1859({
    evidence: evidence1859({ steps: steps1859({ 'Fail on transient API error (no review posted)': 'success' }) }),
  }), /Fail on transient API error.* non è skipped/);
  // Il guard non riuscito, assente o duplicato non prova niente.
  assertDenied(evaluate1859({
    evidence: evidence1859({
      steps: steps1859({ 'Re-review guard (skip Codex when no code changed since last LGTM)': 'skipped' }),
    }),
  }), /re-review guard non riuscito/);
  assertDenied(evaluate1859({
    evidence: evidence1859({
      steps: STEPS_1859.filter((step) => step.name !== 'Claim review PR + HEAD + contribution (zero-agent)'),
    }),
  }), /step del re-review guard assenti o ambigui/);
  assertDenied(evaluate1859({
    evidence: evidence1859({
      steps: [...STEPS_1859, STEPS_1859.find((step) => step.name.startsWith('Re-review guard'))],
    }),
  }), /step del re-review guard assenti o ambigui/);
  // Il review gate della HEAD non e' passato.
  assertDenied(evaluate1859({
    evidence: evidence1859({ steps: steps1859({ 'Require approving Codex review': 'failure' }) }),
  }), /step review-gate senza un verdetto temporale completo/);
  // Il commit della review non ha mai avuto un `tests` verde dopo la review.
  for (const reviewedCommitChecks of [
    [],
    [reviewedCommitCheck1859({ conclusion: 'failure' })],
    [reviewedCommitCheck1859({ completed_at: '2026-09-25T07:24:00Z' })],
    [reviewedCommitCheck1859({ head_sha: HEAD_1859 })],
    [reviewedCommitCheck1859({ name: 'tests' })],
    undefined,
  ]) {
    assertDenied(
      evaluate1859({ evidence: evidence1859({ reviewedCommitChecks }) }),
      /nessun tests \(node --test\) verde sul commit della review dopo la review/,
    );
  }
  // Un guard partito prima della review non l'ha vista: non puo' averne
  // provato il carry-forward.
  assertDenied(evaluate1859({
    reviews: [codexReview1859({
      submitted_at: '2026-09-25T07:31:40Z',
      created_at: '2026-09-25T07:31:40Z',
      updated_at: '2026-09-25T07:31:40Z',
    })],
    evidence: evidence1859({
      reviewedCommitChecks: [reviewedCommitCheck1859({ completed_at: '2026-09-25T07:31:41Z' })],
    }),
  }), /re-review guard non riuscito dopo la review/);
});

test('#1870 marker diverso: la REVIEW_INPUT_REVISION deve essere quella del body PR corrente', () => {
  const otherRevision = `body:${'f'.repeat(64)}`;
  const differentMarker = /REVIEW_INPUT_REVISION della review diversa dal body PR corrente/;
  assertDenied(evaluate1859({
    evidence: evidence1859({
      pullRequest: { headSha: HEAD_1859, reviewRevision: otherRevision, lastEditedAt: null },
    }),
  }), differentMarker);
  // Due marker in conflitto nella stessa review.
  assertDenied(evaluate1859({
    reviews: [codexReview1859({ body: `<!-- REVIEW_INPUT_REVISION: ${otherRevision} -->\n${CODEX_BODY_1859}` })],
  }), differentMarker);
  // Nessun marker.
  assertDenied(evaluate1859({
    reviews: [codexReview1859({ body: CODEX_BODY_1859.replace(/^<!-- REVIEW_INPUT_REVISION:[^\n]*\n/u, '') })],
  }), differentMarker);
  // Revisione corrente illeggibile o HEAD del body diversa dalla HEAD valutata.
  for (const pullRequest of [
    null,
    { headSha: HEAD_1859, reviewRevision: '', lastEditedAt: null },
    { headSha: HEAD_1859, reviewRevision: 'body:not-a-digest', lastEditedAt: null },
    { headSha: REVIEWED_1859, reviewRevision: REVISION_1859, lastEditedAt: null },
  ]) {
    assertDenied(
      evaluate1859({ evidence: evidence1859({ pullRequest }) }),
      /revisione del body PR corrente non verificabile/,
    );
  }
  // Un body modificato dopo l'inizio del review gate non e' quello che il job
  // ha verificato (anche nello stesso secondo); senza il dato l'ordine non e'
  // verificabile.
  for (const lastEditedAt of ['2026-09-25T07:31:45Z', '2026-09-25T07:31:43Z', 'ieri']) {
    assertDenied(evaluate1859({
      evidence: evidence1859({
        pullRequest: { headSha: HEAD_1859, reviewRevision: REVISION_1859, lastEditedAt },
      }),
    }), /body PR modificato dopo l’inizio del review gate/);
  }
  assertDenied(evaluate1859({
    evidence: evidence1859({
      pullRequest: { headSha: HEAD_1859, reviewRevision: REVISION_1859 },
    }),
  }), /ultima modifica del body PR non verificabile/);
  // Un edit concluso prima del review gate e' gia' dentro la revisione verificata.
  assert.equal(evaluate1859({
    evidence: evidence1859({
      pullRequest: { headSha: HEAD_1859, reviewRevision: REVISION_1859, lastEditedAt: '2026-09-25T07:20:00Z' },
    }),
  }).allow, true);
});

test('#1870 check rosso o assente sulla HEAD: nessun carry-forward', () => {
  const [latest, dispatch] = headChecks1859();
  assert.equal(evaluate1859({ checkRuns: [{ ...latest, conclusion: 'failure' }, dispatch] }).allow, false);
  assert.equal(evaluate1859({ checkRuns: [] }).allow, false);
  assert.equal(evaluate1859({
    checkRuns: [{ ...latest, status: 'in_progress', conclusion: null, completed_at: null }, dispatch],
  }).allow, false);
  // La prova deve riferirsi al check `tests` piu' recente, non a un altro.
  assert.equal(evaluate1859({ evidence: evidence1859({ check: dispatch }) }).allow, false);
  assert.equal(evaluate1859({ evidence: null }).allow, false);
});

test('#1870 review Codex con 🔴 Important o senza LGTM non viene riportata', () => {
  const important = CODEX_BODY_1859
    .replace('## Findings (Important: 0, Nit: 0)', '## Findings (Important: 1, Nit: 0)')
    .replace('Nessun finding.', '`scripts/ci/x.mjs:L1`: 🔴 Important: regressione.');
  const notLgtm = /la review non è una LGTM senza 🔴 Important/;
  assertDenied(evaluate1859({ reviews: [codexReview1859({ body: important })] }), notLgtm);
  // Il 🔴 blocca anche con il conteggio a zero e il titolo LGTM.
  assertDenied(evaluate1859({
    reviews: [codexReview1859({
      body: CODEX_BODY_1859.replace('Nessun finding.', '`scripts/ci/x.mjs:L1`: 🔴 Important: regressione.'),
    })],
  }), notLgtm);
  assertDenied(evaluate1859({
    reviews: [codexReview1859({ body: CODEX_BODY_1859.replace('## LGTM', '## Verdetto') })],
  }), notLgtm);
  assert.equal(evaluate1859({ reviews: [codexReview1859({ state: 'CHANGES_REQUESTED' })] }).allow, false);
  assert.equal(evaluate1859({ reviews: [codexReview1859({ state: 'DISMISSED' })] }).allow, false);
});

test('#1870 una review non-Codex e non-allowlist non entra nel carry-forward', () => {
  // github-actions[bot] senza il marker Codex.
  assert.equal(evaluate1859({
    reviews: [codexReview1859({ body: CODEX_BODY_1859.replace('<!-- CODEX_FALLBACK_REVIEW -->\n', '') })],
  }).allow, false);
  // Marker Codex, ma autore fuori dall'identita' del fallback.
  for (const user of [
    { login: 'octocat', type: 'User' },
    { login: 'github-actions', type: 'User' },
    { login: 'renovate[bot]', type: 'Bot' },
    { login: 'github-actions[bot]', type: 'User' },
  ]) {
    assert.equal(evaluate1859({ reviews: [codexReview1859({ user })] }).allow, false, user.login);
  }
});

test('#1870 un verdetto Codex piu recente non viene scavalcato da una LGTM allowlist piu vecchia', () => {
  const olderClaude = {
    ...review(CLEAN_BODY, REVIEWED_1859, '2026-09-25T07:00:00Z'),
    id: 5314700000,
  };
  const important = CODEX_BODY_1859.replace('Nessun finding.', '`scripts/ci/x.mjs:L1`: 🔴 Important: regressione.');
  assert.equal(evaluate1859({ reviews: [olderClaude, codexReview1859({ body: important })] }).allow, false);
  // Senza il verdetto Codex la LGTM allowlist resta il percorso gia' esistente.
  assert.equal(evaluate1859({ reviews: [olderClaude], evidence: null }).allow, true);
});

test('#1870 la LGTM Codex sulla HEAD esatta resta sul percorso esistente, senza i requisiti del carry-forward', () => {
  const onHead = codexReview1859({ commit_id: HEAD_1859 });
  const decision = evaluate1859({
    reviews: [onHead],
    evidence: evidence1859({ pullRequest: undefined, reviewedCommitChecks: undefined }),
  });
  assert.equal(decision.allow, true, decision.reason);
  assert.doesNotMatch(decision.reason, /carry-forward Codex/);
});
