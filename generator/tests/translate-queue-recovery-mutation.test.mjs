import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLAIM_ROOT,
  MAX_CLAIM_BYTES,
  MAX_PHASE_GET_REQUESTS,
  RECOVERY_REASON_CODES,
  createRecoveryClaim,
  runRecoveryClaim,
} from '../../scripts/ci/translate-queue-recovery-claim.mjs';
import {
  MAX_EXECUTOR_POST_REQUESTS,
  createRecoveryExecutorClient,
  runRecoveryExecutor,
} from '../../scripts/ci/translate-queue-recovery-executor.mjs';
import {
  QUEUE_MAX_BOUNDARY_SHA,
  TARGET_BRANCH,
  TARGET_REPOSITORY,
  TARGET_WORKFLOW_BLOB_SHA,
  TARGET_WORKFLOW_ID,
  TARGET_WORKFLOW_PATH,
} from '../../scripts/ci/translate-queue-recovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/translate-queue-recovery.yml');
const CLAIM_RUNTIME_PATH = path.join(ROOT, 'scripts/ci/translate-queue-recovery-claim.mjs');
const EXECUTOR_RUNTIME_PATH = path.join(ROOT, 'scripts/ci/translate-queue-recovery-executor.mjs');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const CLAIM_RUNTIME = readFileSync(CLAIM_RUNTIME_PATH, 'utf8');
const EXECUTOR_RUNTIME = readFileSync(EXECUTOR_RUNTIME_PATH, 'utf8');
const TOKEN = 'test-token-must-never-be-serialized';
const TARGET_RUN_ID = '33534757741';
const TARGET_HEAD_SHA = 'a'.repeat(40);
const CLAIM_COMMIT_SHA = 'c'.repeat(40);
const NOW = Date.parse('2026-09-01T21:00:00.000Z');

function response(status, body = {}, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    headers: { get: (key) => normalized.get(String(key).toLowerCase()) ?? null },
    ok: status >= 200 && status < 300,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function targetRun(overrides = {}) {
  return {
    conclusion: 'cancelled',
    created_at: '2026-09-01T20:30:00.000Z',
    event: 'workflow_dispatch',
    head_branch: TARGET_BRANCH,
    head_sha: TARGET_HEAD_SHA,
    id: Number(TARGET_RUN_ID),
    path: TARGET_WORKFLOW_PATH,
    run_attempt: 1,
    status: 'completed',
    workflow_id: TARGET_WORKFLOW_ID,
    ...overrides,
  };
}

function queueRun(id, status, overrides = {}) {
  return targetRun({
    conclusion: null,
    created_at: '2026-09-01T20:45:00.000Z',
    id,
    status,
    ...overrides,
  });
}

function fakeGithub({
  ancestryStatus = 'ahead',
  apiFault = null,
  dropClaimAfterPut = false,
  initialClaim = null,
  jobsByRun = {},
  malformedPutResponse = false,
  pages = null,
  postError = false,
  postStatus = 201,
  putStatus = 201,
  run = targetRun(),
  totalCount = null,
  workflowBlobSha = TARGET_WORKFLOW_BLOB_SHA,
} = {}) {
  const calls = [];
  const state = { claimBytes: initialClaim };
  const listedPages = pages ?? [[run]];
  const listedTotal = totalCount ?? listedPages.reduce((sum, page) => sum + page.length, 0);

  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ options, url });
    if (apiFault !== null) {
      const fault = await apiFault({ callNumber: calls.length, options, url });
      if (fault !== null && fault !== undefined) return fault;
    }

    const listPath = `/repos/${TARGET_REPOSITORY}/actions/workflows/${TARGET_WORKFLOW_ID}/runs`;
    if (options.method === 'GET' && url.pathname === listPath) {
      const page = Number(url.searchParams.get('page'));
      return response(200, {
        total_count: listedTotal,
        workflow_runs: listedPages[page - 1] ?? [],
      });
    }
    if (options.method === 'GET'
        && url.pathname === `/repos/${TARGET_REPOSITORY}/actions/runs/${TARGET_RUN_ID}`) {
      return response(200, run);
    }
    const comparePrefix = `/repos/${TARGET_REPOSITORY}/compare/${QUEUE_MAX_BOUNDARY_SHA}...`;
    if (options.method === 'GET' && url.pathname.startsWith(comparePrefix)) {
      return response(200, { status: ancestryStatus });
    }
    if (options.method === 'GET'
        && url.pathname === `/repos/${TARGET_REPOSITORY}/contents/${TARGET_WORKFLOW_PATH}`) {
      return response(200, { sha: workflowBlobSha, type: 'file' });
    }
    const jobsMatch = url.pathname.match(new RegExp(
      `^/repos/${TARGET_REPOSITORY}/actions/runs/([1-9][0-9]*)/jobs$`,
    ));
    if (options.method === 'GET' && jobsMatch) {
      const count = jobsByRun[jobsMatch[1]] ?? 0;
      return response(200, {
        jobs: count === 0 ? [] : [{ id: 1 }],
        total_count: count,
      });
    }

    const contentsPrefix = `/repos/${TARGET_REPOSITORY}/contents/`;
    if (url.pathname.startsWith(contentsPrefix)) {
      const claimPath = decodeURIComponent(url.pathname.slice(contentsPrefix.length));
      assert.match(claimPath, new RegExp(`^${CLAIM_ROOT}/[a-f0-9]{64}\\.json$`));
      if (options.method === 'GET') {
        if (state.claimBytes === null) return response(404, { message: 'Not Found' });
        const bytes = Buffer.isBuffer(state.claimBytes)
          ? state.claimBytes
          : Buffer.from(String(state.claimBytes), 'utf8');
        return response(200, {
          content: bytes.toString('base64'),
          encoding: 'base64',
          path: claimPath,
          sha: gitBlobSha(bytes),
          size: bytes.length,
          type: 'file',
        });
      }
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        const bytes = Buffer.from(body.content, 'base64');
        state.claimBytes = dropClaimAfterPut ? null : bytes;
        if (putStatus !== 201) return response(putStatus, { message: 'conflict' });
        if (malformedPutResponse) return response(201, { content: null, commit: null });
        return response(201, {
          commit: { sha: CLAIM_COMMIT_SHA },
          content: { path: claimPath, sha: gitBlobSha(bytes) },
        });
      }
    }

    if (options.method === 'POST'
        && url.pathname === `/repos/${TARGET_REPOSITORY}/actions/runs/${TARGET_RUN_ID}/rerun`) {
      if (postError) throw new Error(TOKEN);
      return response(postStatus, '');
    }
    throw new Error(`unexpected test request: ${options.method} ${url.pathname}${url.search}`);
  };
  return { calls, fetchImpl, state };
}

async function observe(fake, overrides = {}) {
  return runRecoveryClaim({
    fetchImpl: fake.fetchImpl,
    mode: 'observe_only',
    now: NOW,
    phase: 'observe',
    repository: TARGET_REPOSITORY,
    targetRunId: TARGET_RUN_ID,
    token: TOKEN,
    ...overrides,
  });
}

async function claim(fake, overrides = {}) {
  return runRecoveryClaim({
    fetchImpl: fake.fetchImpl,
    mode: 'claim_and_rerun',
    now: NOW,
    phase: 'claim',
    repository: TARGET_REPOSITORY,
    targetRunId: TARGET_RUN_ID,
    token: TOKEN,
    ...overrides,
  });
}

async function execute(fake, overrides = {}) {
  const recoveryClaim = createRecoveryClaim({
    headSha: TARGET_HEAD_SHA,
    targetRunId: TARGET_RUN_ID,
  });
  if (fake.state.claimBytes === null) fake.state.claimBytes = recoveryClaim.bytes;
  return runRecoveryExecutor({
    claimCommitSha: CLAIM_COMMIT_SHA,
    claimKey: recoveryClaim.claimKey,
    fetchImpl: fake.fetchImpl,
    now: NOW,
    repository: TARGET_REPOSITORY,
    targetRunId: TARGET_RUN_ID,
    token: TOKEN,
    workflowRunAttempt: '1',
    ...overrides,
  });
}

function mutatingCalls(fake) {
  return fake.calls.filter(({ options }) => ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method));
}

test('observe_only classifica un candidato ma non possiede effetti remoti', async () => {
  const fake = fakeGithub();
  const { json, report } = await observe(fake);
  assert.equal(report.decision, 'observe_only');
  assert.equal(report.primaryReason, 'eligible_observe_only');
  assert.equal(report.complete, true);
  assert.equal(report.failClosed, false);
  assert.ok(report.reasonCodes.includes('queue_empty'));
  assert.ok(report.reasonCodes.includes('eligible_observe_only'));
  assert.equal(mutatingCalls(fake).length, 0);
  assert.ok(report.queryBudget.usedGets <= MAX_PHASE_GET_REQUESTS);
  assert.ok(!json.includes(TOKEN));
  assert.ok(!json.includes('Authorization'));
});

test('report canonico e ordinamento reason code sono stabili', async () => {
  const first = await observe(fakeGithub());
  const second = await observe(fakeGithub());
  assert.equal(first.json, second.json);
  assert.deepEqual(
    first.report.reasonCodes,
    RECOVERY_REASON_CODES.filter((code) => first.report.reasonCodes.includes(code)),
  );
});

test('schedule resta blocked anche quando il target sarebbe altrimenti recuperabile', async () => {
  const run = targetRun({ event: 'schedule' });
  const fake = fakeGithub({ run });
  const { report } = await claim(fake);
  assert.equal(report.primaryReason, 'schedule_preservation_not_proven');
  assert.equal(report.capabilities.recoverySchedule.state, 'blocked');
  assert.equal(mutatingCalls(fake).length, 0);
  assert.equal(fake.calls.length, 1, 'schedule deve bloccarsi prima della scansione/deep GET');
});

test('distingue active, pending, entrambi e assenza simultanea', async (t) => {
  for (const scenario of [
    { expected: 'active_present', rows: [queueRun(33534757742, 'in_progress')] },
    { expected: 'pending_present', rows: [queueRun(33534757743, 'queued')] },
    {
      expected: 'active_and_pending_present',
      rows: [queueRun(33534757742, 'in_progress'), queueRun(33534757743, 'pending')],
    },
    { expected: 'queue_empty', rows: [] },
  ]) {
    await t.test(scenario.expected, async () => {
      const fake = fakeGithub({ pages: [[targetRun(), ...scenario.rows]] });
      const { report } = await observe(fake);
      if (scenario.expected === 'queue_empty') {
        assert.equal(report.decision, 'observe_only');
        assert.ok(report.reasonCodes.includes('queue_empty'));
      } else {
        assert.equal(report.decision, 'blocked');
        assert.equal(report.primaryReason, scenario.expected);
      }
      assert.equal(mutatingCalls(fake).length, 0);
    });
  }
});

test('classifica deterministicamente l intera matrice di ineligibility', async (t) => {
  const cases = [
    ['workflow_mismatch', { run: targetRun({ workflow_id: 1 }) }],
    ['path_mismatch', { run: targetRun({ path: '.github/workflows/other.yml' }) }],
    ['head_branch_mismatch', { run: targetRun({ head_branch: 'feature' }) }],
    ['event_not_recoverable', { run: targetRun({ event: 'push' }) }],
    ['already_recovered_observed', { run: targetRun({ run_attempt: 2 }) }],
    ['target_state_not_recoverable', {
      run: targetRun({ conclusion: null, status: 'in_progress' }),
    }],
    ['target_state_not_recoverable', { run: targetRun({ conclusion: 'success' }) }],
    ['boundary_non_descendant', { ancestryStatus: 'behind' }],
    ['workflow_blob_mismatch', { workflowBlobSha: 'b'.repeat(40) }],
    ['cancelled_with_jobs', { jobsByRun: { [TARGET_RUN_ID]: 2 } }],
  ];
  for (const [reason, options] of cases) {
    await t.test(reason, async () => {
      const fake = fakeGithub(options);
      const { report } = await claim(fake);
      assert.equal(report.decision, 'blocked');
      assert.equal(report.primaryReason, reason);
      assert.equal(mutatingCalls(fake).length, 0);
    });
  }
});

test('metadata impossibili e ancestry inconclusiva falliscono chiusi', async (t) => {
  for (const scenario of [
    { expected: 'observation_incomplete', options: { run: targetRun({ created_at: 'not-a-date' }) } },
    { expected: 'head_sha_mismatch', options: { run: targetRun({ head_sha: 'not-a-sha' }) } },
    { expected: 'boundary_unknown', options: { ancestryStatus: 'mystery' } },
  ]) {
    await t.test(scenario.expected, async () => {
      const fake = fakeGithub(scenario.options);
      const { report } = await claim(fake);
      assert.equal(report.complete, false);
      assert.equal(report.failClosed, true);
      assert.equal(report.primaryReason, scenario.expected);
      assert.equal(mutatingCalls(fake).length, 0);
    });
  }
});

test('input run ID resta una stringa decimale e mode/phase invalidi non fanno fetch', async (t) => {
  for (const overrides of [
    { targetRunId: Number(TARGET_RUN_ID) },
    { targetRunId: '01' },
    { mode: 'recover' },
    { phase: 'execute' },
  ]) {
    await t.test(JSON.stringify(overrides), async () => {
      const fake = fakeGithub();
      const { report } = await observe(fake, overrides);
      assert.equal(report.failClosed, true);
      assert.equal(fake.calls.length, 0);
    });
  }
});

test('API error, rate limit, rete e paginazione inconclusiva bloccano ogni write', async (t) => {
  const scenarios = [
    () => fakeGithub({ apiFault: async () => response(500, {}) }),
    () => fakeGithub({
      apiFault: async () => response(403, {}, { 'x-ratelimit-remaining': '0' }),
    }),
    () => fakeGithub({ apiFault: async () => { throw new Error(TOKEN); } }),
    () => fakeGithub({
      pages: [
        Array.from({ length: 100 }, (_, index) => targetRun({ id: 40000000000 + index })),
        Array.from({ length: 100 }, (_, index) => targetRun({ id: 40000000100 + index })),
      ],
      totalCount: 201,
    }),
  ];
  for (const makeFake of scenarios) {
    await t.test(String(scenarios.indexOf(makeFake)), async () => {
      const fake = makeFake();
      const { json, report } = await claim(fake);
      assert.equal(report.complete, false);
      assert.equal(report.failClosed, true);
      assert.equal(report.primaryReason, 'observation_incomplete');
      assert.equal(mutatingCalls(fake).length, 0);
      assert.ok(!json.includes(TOKEN));
    });
  }
});

test('claim e content address sono canonici, stabili e bounded', () => {
  const first = createRecoveryClaim({ headSha: TARGET_HEAD_SHA, targetRunId: TARGET_RUN_ID });
  const second = createRecoveryClaim({ headSha: TARGET_HEAD_SHA, targetRunId: TARGET_RUN_ID });
  assert.equal(first.claimKey, second.claimKey);
  assert.equal(first.claimPath, `${CLAIM_ROOT}/${first.claimKey}.json`);
  assert.ok(first.bytes.equals(second.bytes));
  assert.ok(first.bytes.length <= MAX_CLAIM_BYTES);
  assert.equal(first.document.maxMutationRequests, 1);
  assert.equal(first.document.sourceEvent, 'workflow_dispatch');
  assert.equal(first.document.sourceRunAttempt, 1);
  assert.equal(first.document.workflowBlobSha, TARGET_WORKFLOW_BLOB_SHA);
});

test('claim create-only 201 viene verificato byte-identical e abilita solo questa invocazione', async () => {
  const fake = fakeGithub();
  const { report } = await claim(fake);
  assert.equal(report.decision, 'claim_created');
  assert.equal(report.primaryReason, 'claim_created');
  assert.equal(report.claim.commitSha, CLAIM_COMMIT_SHA);
  assert.equal(report.mutationBudget.usedPuts, 1);
  assert.equal(mutatingCalls(fake).filter(({ options }) => options.method === 'PUT').length, 1);
  assert.equal(mutatingCalls(fake).filter(({ options }) => options.method === 'POST').length, 0);
  assert.ok(report.queryBudget.usedGets <= MAX_PHASE_GET_REQUESTS);
});

test('risposta claim malformata o verifica post-201 assente consuma senza autorizzare', async (t) => {
  for (const options of [
    { malformedPutResponse: true },
    { dropClaimAfterPut: true },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const fake = fakeGithub(options);
      const { report } = await claim(fake);
      assert.equal(report.decision, 'blocked');
      assert.equal(report.primaryReason, 'claim_conflict');
      assert.equal(report.failClosed, true);
      assert.equal(fake.calls.filter(({ options: request }) => request.method === 'PUT').length, 1);
      assert.equal(fake.calls.filter(({ options: request }) => request.method === 'POST').length, 0);
    });
  }
});

test('PUT claim 5xx o timeout non viene mai ritentato', async (t) => {
  for (const network of [false, true]) {
    await t.test(network ? 'network' : 'http-500', async () => {
      const fake = fakeGithub({
        apiFault: async ({ options }) => {
          if (options.method !== 'PUT') return null;
          if (network) throw new Error(TOKEN);
          return response(500, {});
        },
      });
      const { report } = await claim(fake);
      assert.equal(report.decision, 'blocked');
      assert.equal(report.failClosed, true);
      assert.equal(fake.calls.filter(({ options }) => options.method === 'PUT').length, 1);
      assert.equal(fake.calls.filter(({ options }) => options.method === 'POST').length, 0);
    });
  }
});

test('race CAS 409/422 si risolve una sola volta e non autorizza executor', async (t) => {
  for (const putStatus of [409, 422]) {
    await t.test(String(putStatus), async () => {
      const fake = fakeGithub({ putStatus });
      const { report } = await claim(fake);
      assert.equal(report.decision, 'blocked');
      assert.equal(report.primaryReason, 'already_claimed_no_retry');
      assert.equal(report.mutationBudget.usedPuts, 1);
      assert.equal(fake.calls.filter(({ options }) => options.method === 'PUT').length, 1);
      assert.equal(fake.calls.filter(({ options }) => options.method === 'POST').length, 0);
    });
  }
});

test('claim esistente o incoerente e crash dopo claim non possono generare retry', async (t) => {
  const exact = createRecoveryClaim({ headSha: TARGET_HEAD_SHA, targetRunId: TARGET_RUN_ID });
  await t.test('existing exact', async () => {
    const fake = fakeGithub({ initialClaim: exact.bytes });
    const { report } = await claim(fake);
    assert.equal(report.primaryReason, 'already_claimed_no_retry');
    assert.equal(mutatingCalls(fake).length, 0);
  });
  await t.test('existing conflicting', async () => {
    const fake = fakeGithub({ initialClaim: Buffer.from('{"forged":true}\n') });
    const { report } = await claim(fake);
    assert.equal(report.primaryReason, 'claim_conflict');
    assert.ok(report.reasonCodes.includes('claim_conflict'));
    assert.equal(report.failClosed, true);
    assert.equal(mutatingCalls(fake).length, 0);
  });
  await t.test('crash after durable claim', async () => {
    const fake = fakeGithub();
    const first = await claim(fake);
    assert.equal(first.report.decision, 'claim_created');
    const second = await claim(fake);
    assert.equal(second.report.primaryReason, 'already_claimed_no_retry');
    assert.equal(fake.calls.filter(({ options }) => options.method === 'PUT').length, 1);
    assert.equal(fake.calls.filter(({ options }) => options.method === 'POST').length, 0);
  });
});

test('executor rilegge il claim sotto lock e invia un solo POST all endpoint esatto', async () => {
  const fake = fakeGithub();
  const { report } = await execute(fake);
  assert.equal(report.decision, 'rerun_requested');
  assert.equal(report.primaryReason, 'rerun_requested');
  assert.ok(report.reasonCodes.includes('claim_verified'));
  assert.ok(report.reasonCodes.includes('rerun_authorized'));
  assert.equal(report.mutationBudget.usedPosts, 1);
  const writes = mutatingCalls(fake);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.method, 'POST');
  assert.equal(writes[0].url.pathname,
    `/repos/${TARGET_REPOSITORY}/actions/runs/${TARGET_RUN_ID}/rerun`);
  assert.equal(writes[0].options.body, undefined);
});

test('post-claim state change consuma il claim senza POST', async (t) => {
  for (const run of [
    targetRun({ run_attempt: 2 }),
    targetRun({ conclusion: null, status: 'queued' }),
  ]) {
    await t.test(`${run.status}-${run.run_attempt}`, async () => {
      const exact = createRecoveryClaim({ headSha: TARGET_HEAD_SHA, targetRunId: TARGET_RUN_ID });
      const fake = fakeGithub({ initialClaim: exact.bytes, run });
      const { report } = await execute(fake);
      assert.equal(report.decision, 'blocked');
      assert.equal(report.primaryReason, 'post_claim_state_changed');
      assert.equal(fake.calls.filter(({ options }) => options.method === 'POST').length, 0);
    });
  }
});

test('rerun del workflow di recovery non puo rieseguire executor', async () => {
  const fake = fakeGithub();
  const { report } = await execute(fake, { workflowRunAttempt: '2' });
  assert.equal(report.decision, 'blocked');
  assert.equal(report.primaryReason, 'invalid_input');
  assert.equal(fake.calls.length, 0);
});

test('POST 403/409/422/5xx/timeout resta ambiguo, fail-closed e senza retry', async (t) => {
  for (const scenario of [
    { name: '403', postStatus: 403 },
    { name: '409', postStatus: 409 },
    { name: '422', postStatus: 422 },
    { name: '500', postStatus: 500 },
    { name: 'network', postError: true },
  ]) {
    await t.test(scenario.name, async () => {
      const fake = fakeGithub(scenario);
      const { json, report } = await execute(fake);
      assert.equal(report.decision, 'blocked');
      assert.equal(report.primaryReason, 'mutation_outcome_unknown_or_failed');
      assert.equal(report.failClosed, true);
      assert.equal(fake.calls.filter(({ options }) => options.method === 'POST').length, 1);
      assert.ok(!json.includes(TOKEN));
    });
  }
});

test('client executor impedisce un secondo POST anche se richiamato direttamente', async () => {
  const calls = [];
  const client = createRecoveryExecutorClient({
    clock: () => 0,
    deadlineAt: 1_000,
    fetchImpl: async (url, options) => {
      calls.push({ options, url: new URL(url) });
      return response(201, '');
    },
    token: TOKEN,
  });
  await client.rerun(TARGET_RUN_ID);
  await assert.rejects(client.rerun(TARGET_RUN_ID), /mutation_outcome_unknown_or_failed/);
  assert.equal(calls.length, MAX_EXECUTOR_POST_REQUESTS);
});

test('deadline di processo scaduta blocca prima di qualunque fetch o write', async () => {
  let ticks = 0;
  const fake = fakeGithub();
  const { report } = await observe(fake, {
    clock: () => (ticks++ === 0 ? 0 : 240_001),
  });
  assert.equal(report.complete, false);
  assert.equal(report.failClosed, true);
  assert.equal(report.primaryReason, 'observation_incomplete');
  assert.equal(fake.calls.length, 0);
});

test('workflow limita trigger, permission, concurrency e runtime per costruzione', () => {
  assert.match(WORKFLOW, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(WORKFLOW, /^  schedule:/m);
  assert.match(WORKFLOW, /default: observe_only/);
  assert.match(WORKFLOW, /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(WORKFLOW, /- claim_and_rerun/);
  assert.match(WORKFLOW, /group: translate-queue-recovery-v2/);
  assert.match(WORKFLOW, /group: jobs-data-pipeline/);
  assert.equal((WORKFLOW.match(/queue: max/g) ?? []).length, 2);
  assert.equal((WORKFLOW.match(/cancel-in-progress: false/g) ?? []).length, 2);

  const claimJob = WORKFLOW.slice(WORKFLOW.indexOf('  claim:'), WORKFLOW.indexOf('  executor:'));
  const executorJob = WORKFLOW.slice(WORKFLOW.indexOf('  executor:'));
  assert.match(claimJob, /actions: read/);
  assert.match(claimJob, /contents: write/);
  assert.doesNotMatch(claimJob, /actions: write/);
  assert.match(executorJob, /actions: write/);
  assert.match(executorJob, /contents: read/);
  assert.match(executorJob, /RECOVERY_WORKFLOW_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.equal((executorJob.match(/^      - name:/gm) ?? []).length, 1);

  assert.doesNotMatch(
    WORKFLOW,
    /secrets\.|GITHUB_PAT|firebase|actions\/checkout|setup-node|npm (?:ci|install)|(?:^|\s)gh\s/i,
  );
  assert.equal((WORKFLOW.match(/raw\.githubusercontent\.com\/\$\{\{ github\.repository \}\}\/\$\{\{ github\.sha \}\}/g) ?? []).length, 7);
  assert.equal((WORKFLOW.match(/--max-redirs 0/g) ?? []).length, 7);
  assert.equal((WORKFLOW.match(/timeout-minutes: 5/g) ?? []).length, 3);
});

test('runtime separa PUT claim e POST executor senza endpoint alternativi', () => {
  assert.match(CLAIM_RUNTIME, /'PUT'/);
  assert.doesNotMatch(CLAIM_RUNTIME, /'POST'|'DELETE'|\/dispatches|\/cancel|rerun-failed/);
  assert.match(EXECUTOR_RUNTIME, /'POST'/);
  assert.doesNotMatch(EXECUTOR_RUNTIME, /'PUT'|'DELETE'|\/dispatches|\/cancel|rerun-failed/);
  assert.match(EXECUTOR_RUNTIME, /\/actions\/runs\/\$\{targetRunId\}\/rerun/);
});

test('manifest dichiara tutti i nuovi file corpus-only con digest esatto', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const expected = [
    '.github/workflows/translate-queue-recovery.yml',
    'scripts/ci/translate-queue-recovery-claim.mjs',
    'scripts/ci/translate-queue-recovery-executor.mjs',
    'generator/tests/translate-queue-recovery-mutation.test.mjs',
  ];
  for (const expectedPath of expected) {
    const entry = manifest.files.find(({ path: entryPath }) => entryPath === expectedPath);
    assert.ok(entry, expectedPath);
    assert.equal(entry.mode, 'corpus-only');
    assert.equal(entry.baseline.site, null);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(ROOT, expectedPath)))
      .digest('hex')
      .slice(0, 16);
    assert.equal(entry.baseline.corpus, digest, expectedPath);
  }
});
