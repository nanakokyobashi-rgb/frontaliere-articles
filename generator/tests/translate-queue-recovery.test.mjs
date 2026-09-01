import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BOOTSTRAP_GET_REQUESTS,
  MAX_DEEP_CANDIDATES,
  MAX_GET_REQUESTS,
  MAX_REPORT_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_TOTAL_GET_REQUESTS,
  QUEUE_MAX_BOUNDARY_SHA,
  REPORT_SCHEMA,
  TARGET_BRANCH,
  TARGET_REPOSITORY,
  TARGET_WORKFLOW_BLOB_SHA,
  TARGET_WORKFLOW_ID,
  TARGET_WORKFLOW_PATH,
  observeTranslateQueue,
} from '../../scripts/ci/translate-queue-recovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/translate-queue-recovery-watchdog.yml');
const RUNTIME_PATH = path.join(ROOT, 'scripts/ci/translate-queue-recovery.mjs');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const RUNTIME = readFileSync(RUNTIME_PATH, 'utf8');
const NOW = Date.parse('2026-09-01T17:27:00.000Z');
const TOKEN = 'test-token-must-never-be-serialized';

function response(status, body, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    headers: { get: (key) => normalized.get(String(key).toLowerCase()) ?? null },
    ok: status >= 200 && status < 300,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function run(id, overrides = {}) {
  return {
    conclusion: 'cancelled',
    created_at: '2026-09-01T17:00:00.000Z',
    event: 'schedule',
    head_branch: TARGET_BRANCH,
    head_sha: '7ab0f32000000000000000000000000000000000',
    id,
    path: TARGET_WORKFLOW_PATH,
    run_attempt: 1,
    status: 'completed',
    workflow_id: TARGET_WORKFLOW_ID,
    ...overrides,
  };
}

function fakeGithub({
  compareByHead = {},
  contentsByHead = {},
  jobsByRun = {},
  pages = [[]],
  totalCount = pages.reduce((sum, page) => sum + page.length, 0),
} = {}) {
  const calls = [];
  const fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    calls.push({ options, url });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);

    if (url.pathname === `/repos/${TARGET_REPOSITORY}/actions/workflows/${TARGET_WORKFLOW_ID}/runs`) {
      const page = Number(url.searchParams.get('page'));
      assert.equal(url.searchParams.get('branch'), TARGET_BRANCH);
      assert.equal(url.searchParams.get('per_page'), '100');
      return response(200, { total_count: totalCount, workflow_runs: pages[page - 1] ?? [] });
    }
    const comparePrefix = `/repos/${TARGET_REPOSITORY}/compare/${QUEUE_MAX_BOUNDARY_SHA}...`;
    if (url.pathname.startsWith(comparePrefix)) {
      const head = url.pathname.slice(comparePrefix.length);
      return response(200, compareByHead[head] ?? { status: 'ahead' });
    }
    if (url.pathname === `/repos/${TARGET_REPOSITORY}/contents/${TARGET_WORKFLOW_PATH}`) {
      const head = url.searchParams.get('ref');
      return response(200, contentsByHead[head] ?? { sha: TARGET_WORKFLOW_BLOB_SHA, type: 'file' });
    }
    const jobsMatch = url.pathname.match(new RegExp(
      `^/repos/${TARGET_REPOSITORY}/actions/runs/([1-9][0-9]*)/jobs$`,
    ));
    if (jobsMatch) {
      assert.equal(url.searchParams.get('filter'), 'latest');
      assert.equal(url.searchParams.get('per_page'), '1');
      return response(200, jobsByRun[jobsMatch[1]] ?? { jobs: [], total_count: 0 });
    }
    throw new Error(`unexpected test URL: ${url.pathname}`);
  };
  return { calls, fetchImpl };
}

async function observe(fake, overrides = {}) {
  return observeTranslateQueue({
    fetchImpl: fake.fetchImpl,
    mode: 'dry-run',
    now: NOW,
    repository: TARGET_REPOSITORY,
    token: TOKEN,
    ...overrides,
  });
}

test('classifica active/pending e cancellazioni jobs=0/jobs>0 senza soglia stale', async () => {
  const headZero = 'a'.repeat(40);
  const headJobs = 'b'.repeat(40);
  const fake = fakeGithub({
    jobsByRun: {
      33500000003: { jobs: [], total_count: 0 },
      33500000004: { jobs: [{ id: 1 }], total_count: 2 },
    },
    pages: [[
      run(33500000001, {
        conclusion: null,
        created_at: '2026-09-01T16:00:00.000Z',
        status: 'in_progress',
      }),
      run(33500000002, {
        conclusion: null,
        created_at: '2026-09-01T17:10:52.000Z',
        event: 'workflow_dispatch',
        status: 'queued',
      }),
      run(33500000003, { head_sha: headZero }),
      run(33500000004, { head_sha: headJobs }),
    ]],
  });
  const { json, report } = await observe(fake);

  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.decision, 'observe_only');
  assert.equal(report.complete, true);
  assert.equal(report.failClosed, false);
  assert.equal(report.counts.active, 1);
  assert.equal(report.counts.pending, 1);
  assert.equal(report.counts.byReason.active_pending_present, 2);
  assert.equal(report.counts.byReason.cancelled_job_zero_candidate, 1);
  assert.equal(report.counts.byReason.cancelled_with_jobs, 1);
  assert.equal(report.queue.activePendingPresent, true);
  assert.equal(report.queue.oldestAgeSeconds, 5220);
  assert.equal(report.queue.staleThreshold, 'not_evaluated');
  assert.ok(report.reasonCodes.includes('queue_age_observed_no_threshold'));
  assert.equal(report.capabilities.recoverySchedule.state, 'blocked');
  assert.equal(report.capabilities.alreadyRecovered.state, 'not_evaluated');
  assert.equal(report.capabilities.claimState.state, 'not_evaluated');
  assert.equal(report.queryBudget.usedGets, 7);
  assert.ok(Buffer.byteLength(json) <= MAX_REPORT_BYTES);
});

test('classifica deterministicamente tutti i mismatch shallow e attempt>1', async () => {
  const rows = [
    run(10000000001, { workflow_id: 1 }),
    run(10000000002, { path: '.github/workflows/other.yml' }),
    run(10000000003, { head_branch: 'feature' }),
    run(10000000004, { event: 'push' }),
    run(10000000005, { run_attempt: 2 }),
    run(10000000006, { status: 'success' }),
    run(10000000007, { conclusion: 'success' }),
  ];
  const { report } = await observe(fakeGithub({ pages: [rows] }));
  for (const reason of [
    'wrong_workflow', 'wrong_path', 'wrong_head_branch', 'wrong_event', 'wrong_attempt',
    'wrong_status', 'wrong_conclusion',
  ]) {
    assert.equal(report.counts.byReason[reason], 1, reason);
  }
  assert.equal(report.complete, true);
  assert.equal(report.failClosed, false);
  assert.equal(report.counts.deepCandidates, 0);
  assert.equal(report.queryBudget.usedGets, 1);
});

test('metadata obbligatori mancanti o malformati falliscono chiusi senza candidati', async (t) => {
  const cases = [
    ['id missing', { id: undefined }, 'malformed_run'],
    ['id malformed', { id: 'not-an-id' }, 'malformed_run'],
    ['workflow_id missing', { workflow_id: undefined }, 'malformed_run'],
    ['workflow_id wrong type', { workflow_id: String(TARGET_WORKFLOW_ID) }, 'malformed_run'],
    ['path missing', { path: undefined }, 'malformed_run'],
    ['path malformed', { path: 'translate-pending.yml' }, 'malformed_run'],
    ['head_branch missing', { head_branch: undefined }, 'malformed_run'],
    ['head_branch malformed', { head_branch: ' main ' }, 'malformed_run'],
    ['head_sha missing', { head_sha: undefined }, 'invalid_head_sha'],
    ['head_sha malformed', { head_sha: 'not-a-sha' }, 'invalid_head_sha'],
    ['event missing', { event: undefined }, 'malformed_run'],
    ['event malformed', { event: 'workflow dispatch' }, 'malformed_run'],
    ['status missing', { status: undefined }, 'malformed_run'],
    ['status malformed', { status: 'not-a-status' }, 'malformed_run'],
    ['conclusion missing', { conclusion: undefined }, 'malformed_run'],
    ['conclusion malformed', { conclusion: 7 }, 'malformed_run'],
    ['run_attempt missing', { run_attempt: undefined }, 'malformed_run'],
    ['run_attempt wrong type', { run_attempt: '1' }, 'malformed_run'],
    ['created_at missing', { created_at: undefined }, 'invalid_created_at'],
    ['created_at counterexample', { created_at: 'not-a-timestamp' }, 'invalid_created_at'],
    ['created_at impossible date', { created_at: '2026-02-30T17:00:00.000Z' }, 'invalid_created_at'],
  ];

  for (const [name, overrides, reason] of cases) {
    await t.test(name, async () => {
      const fake = fakeGithub({ pages: [[run(11000000001, overrides)]] });
      const { report } = await observe(fake);
      assert.equal(report.complete, false);
      assert.equal(report.failClosed, true);
      assert.equal(report.counts.byReason[reason], 1);
      assert.equal(report.counts.deepCandidates, 0);
      assert.equal(report.counts.deepInspected, 0);
      assert.equal(report.queryBudget.usedGets, 1);
      assert.equal(fake.calls.length, 1);
      assert.ok(fake.calls.every(({ options }) => options.method === 'GET'));
    });
  }
});

test('distingue ancestry non-descendant, unknown e blob errato', async () => {
  const behind = '1'.repeat(40);
  const unknown = '2'.repeat(40);
  const wrongBlob = '3'.repeat(40);
  const fake = fakeGithub({
    compareByHead: {
      [behind]: { status: 'behind' },
      [unknown]: { status: 'mystery' },
    },
    contentsByHead: {
      [wrongBlob]: { sha: '4'.repeat(40), type: 'file' },
    },
    pages: [[
      run(20000000001, { head_sha: behind }),
      run(20000000002, { head_sha: unknown }),
      run(20000000003, { head_sha: wrongBlob }),
    ]],
  });
  const { report } = await observe(fake);
  assert.equal(report.counts.byReason.boundary_non_descendant, 1);
  assert.equal(report.counts.byReason.boundary_unknown, 1);
  assert.equal(report.counts.byReason.wrong_blob, 1);
  assert.equal(report.failClosed, true, 'ancestry inconclusiva deve fallire chiusa');
  assert.equal(report.counts.deepInspected, 0);
});

test('pagina al massimo due volte e stabilizza samples per data/id', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => run(
    30000000000 + index,
    {
      conclusion: 'success',
      created_at: index < 2
        ? '2026-09-01T17:00:00.000Z'
        : `2026-09-01T${String(16 - Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
    },
  ));
  const fake = fakeGithub({ pages: [rows.slice(0, 100), rows.slice(100)] });
  const { report } = await observe(fake);
  assert.equal(report.counts.scannedRuns, 101);
  assert.equal(report.queryBudget.usedGets, 2);
  assert.deepEqual(
    report.samples.wrong_conclusion.slice(0, 2),
    ['30000000001', '30000000000'],
  );
  assert.equal(fake.calls.filter(({ url }) => url.pathname.endsWith('/runs')).length, 2);
});

test('paginazione inconclusiva fallisce chiusa senza deep GET', async () => {
  const first = Array.from({ length: 100 }, (_, index) => run(40000000000 + index));
  const second = Array.from({ length: 100 }, (_, index) => run(40000000100 + index));
  const fake = fakeGithub({ pages: [first, second], totalCount: 201 });
  const { report } = await observe(fake);
  assert.equal(report.failClosed, true);
  assert.equal(report.counts.byReason.pagination_inconclusive, 1);
  assert.equal(report.counts.deepInspected, 0);
  assert.equal(report.queryBudget.usedGets, 2);
});

test('budget GET non supera 30 e fallisce chiuso prima di una mutazione', async () => {
  const candidates = Array.from({ length: 10 }, (_, index) => run(
    50000000000 + index,
    { head_sha: `${String(index).padStart(40, '0')}` },
  ));
  const fake = fakeGithub({ pages: [candidates] });
  const { report } = await observe(fake);
  assert.equal(report.queryBudget.usedGets, MAX_GET_REQUESTS);
  assert.equal(report.queryBudget.exhausted, true);
  assert.equal(report.counts.byReason.query_budget_exhausted, 1);
  assert.equal(report.failClosed, true);
  assert.equal(fake.calls.length, MAX_GET_REQUESTS);
  assert.equal(MAX_GET_REQUESTS + BOOTSTRAP_GET_REQUESTS, MAX_TOTAL_GET_REQUESTS);
  assert.equal(MAX_TOTAL_GET_REQUESTS, 30);
});

test('limite deep di 20 e esplicito e fail-closed', async () => {
  const candidates = Array.from({ length: MAX_DEEP_CANDIDATES + 1 }, (_, index) => run(
    60000000000 + index,
    { head_sha: createHash('sha1').update(String(index)).digest('hex') },
  ));
  const { report } = await observe(fakeGithub({ pages: [candidates] }));
  assert.equal(report.counts.deepCandidates, MAX_DEEP_CANDIDATES + 1);
  assert.equal(report.counts.byReason.deep_candidate_limit_exceeded, 1);
  assert.equal(report.failClosed, true);
  assert.ok(report.queryBudget.usedGets <= MAX_GET_REQUESTS);
});

test('errori API, rete, rate limit e body invalido sono redatti e fail-closed', async (t) => {
  for (const scenario of [
    { name: 'http', expected: 'api_http_error', result: response(500, {}) },
    { name: 'rate', expected: 'api_rate_limited', result: response(429, {}) },
    { name: 'json', expected: 'api_invalid_json', result: response(200, '{') },
    {
      name: 'oversize',
      expected: 'api_response_too_large',
      result: response(200, 'x'.repeat(MAX_RESPONSE_BYTES + 1)),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const fetchImpl = async (url, options) => {
        calls.push({ options, url });
        return scenario.result;
      };
      const { json, report } = await observe({ calls, fetchImpl });
      assert.equal(report.failClosed, true);
      assert.equal(report.counts.byReason[scenario.expected], 1);
      assert.ok(!json.includes(TOKEN));
      assert.ok(!json.includes('Authorization'));
      assert.equal(calls[0].options.method, 'GET');
    });
  }
  await t.test('network', async () => {
    const { json, report } = await observe({
      calls: [],
      async fetchImpl() { throw new Error(TOKEN); },
    });
    assert.equal(report.failClosed, true);
    assert.equal(report.counts.byReason.api_network_error, 1);
    assert.ok(!json.includes(TOKEN));
  });
});

test('modalita non dry-run, repo errato e token assente non eseguono fetch', async (t) => {
  for (const [overrides, reason] of [
    [{ mode: 'recover' }, 'invalid_mode'],
    [{ repository: 'owner/other' }, 'invalid_repository'],
    [{ token: '' }, 'missing_token'],
  ]) {
    await t.test(reason, async () => {
      const fake = fakeGithub();
      const { report } = await observe(fake, overrides);
      assert.equal(report.failClosed, true);
      assert.equal(report.decision, 'observe_only');
      assert.equal(report.counts.byReason[reason], 1);
      assert.equal(fake.calls.length, 0);
    });
  }
});

test('assenza active/pending e JSON canonico restano espliciti', async () => {
  const { json, report } = await observe(fakeGithub({ pages: [[]] }));
  assert.equal(report.queue.activePendingPresent, false);
  assert.equal(report.queue.oldestAgeSeconds, null);
  assert.equal(report.counts.byReason.no_active_pending, 1);
  assert.equal(`${canonicalJson(report)}\n`, json);
  assert.ok(!json.includes(TOKEN));
});

test('workflow e runtime sono read-only/dry-run per costruzione', () => {
  const active = WORKFLOW.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.match(active, /cron: '37 \* \* \* \*'/);
  assert.match(active, /^  workflow_dispatch:$/m);
  assert.match(active, /^  actions: read$/m);
  assert.match(active, /^  contents: read$/m);
  assert.match(active, /^  group: translate-queue-recovery-watchdog-v1$/m);
  assert.match(active, /^  cancel-in-progress: false$/m);
  assert.match(active, /^  queue: max$/m);
  assert.match(active, /^    timeout-minutes: 5$/m);
  assert.match(active, /^          RECOVERY_MODE: dry-run$/m);
  assert.equal((active.match(/^\s*curl\s/gm) || []).length, BOOTSTRAP_GET_REQUESTS);
  assert.match(active, /--max-redirs 0/);
  assert.doesNotMatch(active, /(?:actions|contents): write|write-all|secrets\.|\bPAT\b|firebase/i);
  assert.doesNotMatch(active, /actions\/checkout|actions\/setup-node|npm (?:ci|install)/);
  assert.doesNotMatch(active, /\bgh\s+(?:api|workflow)|\bgit\s+(?:push|commit)/);
  assert.doesNotMatch(active, /\/(?:rerun|dispatches|cancel)(?:\b|\/)/);

  assert.equal((RUNTIME.match(/method: 'GET'/g) || []).length, 1);
  assert.doesNotMatch(RUNTIME, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
  assert.doesNotMatch(RUNTIME, /\/(?:rerun|dispatches|cancel)(?:\b|\/)/);
  assert.doesNotMatch(RUNTIME, /writeFile|appendFile|createGithubIssue|child_process/);
});

test('target e manifest sono pinning corpus-only esatti', () => {
  assert.equal(TARGET_WORKFLOW_ID, 342441975);
  assert.equal(TARGET_WORKFLOW_PATH, '.github/workflows/translate-pending.yml');
  assert.equal(TARGET_WORKFLOW_BLOB_SHA, 'f782b4b2761ab87ba7792d256b64ab09c2e206ea');
  assert.equal(QUEUE_MAX_BOUNDARY_SHA, '5e5114b73f37a0c47625f00baff13942fe8b186b');

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const expected = new Set([
    '.github/workflows/translate-queue-recovery-watchdog.yml',
    'scripts/ci/translate-queue-recovery.mjs',
    'generator/tests/translate-queue-recovery.test.mjs',
  ]);
  const entries = manifest.files.filter(({ path: entryPath }) => expected.has(entryPath));
  assert.equal(entries.length, expected.size);
  assert.ok(entries.every(({ mode }) => mode === 'corpus-only'));
  for (const entry of entries) {
    const digest = createHash('sha256')
      .update(readFileSync(path.join(ROOT, entry.path)))
      .digest('hex')
      .slice(0, 16);
    assert.equal(entry.baseline.corpus, digest, entry.path);
    assert.equal(entry.baseline.site, null, entry.path);
  }
  for (const removed of [
    '.github/workflows/translate-queue-rerun-probe.yml',
    'scripts/ci/verify-translate-queue-rerun-probe.mjs',
    'generator/tests/translate-queue-rerun-probe.test.mjs',
  ]) {
    assert.equal(manifest.files.some(({ path: entryPath }) => entryPath === removed), false);
  }
});
