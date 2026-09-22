import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const tests = read('.github/workflows/tests.yml');
const recovery = read('.github/workflows/retry-code-check-after-body-edit.yml');
const script = recovery.slice(recovery.indexOf('          script: |\n') + '          script: |\n'.length)
  .split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// The workflow waits for a cancelled run to settle; keep the wait instant here.
process.env.BODY_RECOVERY_POLL_MS = '1';
process.env.BODY_RECOVERY_WAIT_MS = '50';
process.env.GITHUB_WORKSPACE = fileURLToPath(new URL('../..', import.meta.url));
const GOOD_BODY = '## Implementato\n\n- una modifica reale e descritta\n\n## Non implementato (ancora)\n\nNessuno.\n';
let prBody = GOOD_BODY;

const EDITED_AT = '2026-09-19T12:00:00Z';
const BEFORE_EDIT = '2026-09-19T11:50:00Z';
const AFTER_EDIT = '2026-09-19T12:01:00Z';

// `later`: fields the run takes on successive getWorkflowRun reads (the
// first read is the script's re-read of the listed run).
async function recover(bodyConclusion, status = 'completed', failedSteps = [], later = [], runOverrides = {}, cancelError = null, autoMerge = null, editTimestamp = EDITED_AT) {
  const reruns = [];
  const cancels = [];
  const failures = [];
  const autoMergeRevokes = [];
  const run = {
    id: 42, run_attempt: 1, status, conclusion: status === 'completed' ? 'failure' : null,
    head_branch: 'feature', event: 'pull_request', run_started_at: BEFORE_EDIT, ...runOverrides,
  };
  const polls = [...later];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: {
        node_id: 'PR_node', state: 'open', head: { sha: 'head', ref: 'feature' }, body: prBody,
        auto_merge: autoMerge,
      } }) },
      actions: {
        listWorkflowRuns: 'runs', listJobsForWorkflowRun: 'jobs',
        getWorkflowRun: async () => {
          if (polls.length) Object.assign(run, polls.shift());
          return { data: { ...run } };
        },
        cancelWorkflowRun: async ({ run_id }) => {
          if (cancelError) throw cancelError;
          cancels.push(run_id);
        },
        reRunWorkflow: async ({ run_id }) => { reruns.push(run_id); },
      },
    },
    graphql: async (_query, variables) => { autoMergeRevokes.push(variables.pullRequestId); },
    // Like the Jobs API: a step has no conclusion until the run gets there.
    paginate: async endpoint => endpoint === 'runs' ? [{ ...run }] : [{
      conclusion: run.status === 'completed' && failedSteps.length ? 'failure' : null,
      steps: [
        { name: 'PR-body completeness + multi-issue Closes (zero-Claude)', conclusion: run.status === 'completed' ? bodyConclusion : null },
        ...failedSteps.map(name => ({ name, conclusion: run.status === 'completed' ? 'failure' : null })),
      ],
    }],
  };
  await new AsyncFunction('github', 'context', 'core', script)(github, {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { pull_request: { number: 1, head: { sha: 'head' }, updated_at: editTimestamp } },
  }, { info() {}, warning() {}, setFailed(message) { failures.push(message); } });
  recover.lastCancels = cancels;
  recover.lastFailures = failures;
  recover.lastAutoMergeRevokes = autoMergeRevokes;
  return reruns;
}

test('body edits re-enter through the trusted recovery, not through a tests.yml `edited` trigger', () => {
  // `edited` on tests.yml restarted the whole suite on an unchanged HEAD and,
  // with cancel-in-progress, could kill the synchronize run (13/52 runs on
  // 2026-09-19). The corrected body re-enters via the recovery rerun below,
  // whose payload is the ORIGINAL event: the re-review must therefore depend
  // only on the body revision read from the API, never on the event action.
  assert.doesNotMatch(tests.match(/types: \[[^\]]+\]/)[0], /edited/);
  assert.doesNotMatch(tests, /BODY_EDITED/);
  assert.match(tests, /REVIEW_REVISION:/);
  assert.match(tests, /nessuna seconda review, anche dopo un body edit/);
  assert.match(tests, /review approvante del reviewer/);
  assert.match(tests, /has_clean_lgtm/);
  assert.ok(tests.indexOf('nessuna seconda review, anche dopo un body edit') < tests.indexOf('if [ -z "$changed" ]'));
  assert.match(recovery, /pull_request_target:\n    types: \[edited\]/);
  assert.match(recovery, /pull-requests: write/);
  assert.match(recovery, /disablePullRequestAutoMerge/);
  assert.equal((recovery.match(/core\.setFailed/g) || []).length, 1);
  assert.doesNotMatch(recovery, /createCheckRun/);
  // The only checkout is the trusted base (pull_request_target default ref),
  // sparse on the evaluator, without credentials: never the PR head.
  const checkout = recovery.slice(recovery.indexOf('uses: actions/checkout'), recovery.indexOf('- name: Retry'));
  assert.doesNotMatch(checkout, /ref:/);
  const sparseDirs = checkout.split('sparse-checkout: |\n')[1].split('\n')
    .map(line => line.trim()).filter(line => line && !line.includes(':'));
  assert.deepEqual(sparseDirs, ['scripts/lib', 'scripts/ci/lib']);
  // Every module the evaluator imports must be inside the sparse checkout,
  // or the green-run branch dies on ERR_MODULE_NOT_FOUND before any rerun.
  const root = new URL('../../', import.meta.url);
  const seen = new Set();
  const queue = ['scripts/lib/pr-body-contract-eval.mjs'];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = fs.readFileSync(new URL(rel, root), 'utf8');
    for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1] || m[2])));
    }
  }
  assert.ok(seen.size >= 4, [...seen].join(', '));
  for (const rel of seen) {
    assert.ok(sparseDirs.includes(path.posix.dirname(rel)), `${rel} is outside the recovery sparse checkout`);
  }
  assert.match(checkout, /persist-credentials: false/);
  // Corpus adaptation: tests.yml here checks out the dispatched ref, so a
  // dispatch on the base would test base code and anchor the check on the
  // base SHA. Without a run on the head, recovery waits for the next push.
  assert.doesNotMatch(recovery, /createWorkflowDispatch/);
});

test('a corrected failed body retries the code run', async () => {
  assert.deepEqual(await recover('failure'), [42]);
});

test('a body rejected only by the review gate retries the code run', async () => {
  // Without `edited` on tests.yml this is the only path by which a body the
  // reviewer rejected gets re-reviewed on the same HEAD.
  assert.deepEqual(await recover('success', 'completed', ['Require approving Codex review']), [42]);
  assert.deepEqual(await recover('success', 'completed', ['Classify review gate failure']), [42]);
});

test('a code failure next to the review gate keeps the existing verdict', async () => {
  assert.deepEqual(await recover('success', 'completed', [
    'Unit + closure gates (i gate sul contenuto girano altrove)',
    'Require approving Codex review',
  ]), []);
});

test('the review step names the recovery watches exist in tests.yml', () => {
  for (const name of ['Require approving Codex review', 'Classify review gate failure', 'Fail when required review gate is skipped']) {
    assert.match(recovery, new RegExp(`'${name}'`));
    assert.ok(tests.includes(`- name: ${name}\n`), name);
  }
});

test('a run still in flight from before the edit is cancelled and rerun on the new body', async () => {
  const cancelled = { status: 'completed', conclusion: 'cancelled' };
  assert.deepEqual(await recover('success', 'in_progress', [], [{}, cancelled]), [42]);
  assert.deepEqual(recover.lastCancels, [42]);
  // Started after the edit (a push, our own rerun, a duplicate delivery):
  // it already reads the current body, so it is neither cancelled nor rerun.
  assert.deepEqual(await recover('success', 'in_progress', [], [], { run_started_at: AFTER_EDIT }), []);
  assert.deepEqual(recover.lastCancels, []);
  // Someone else restarted it meanwhile: nothing left to do here.
  assert.deepEqual(await recover('success', 'in_progress', [], [{}, { run_attempt: 2 }]), []);
  // It completed between the listing and the re-read: classified, not cancelled.
  assert.deepEqual(await recover('failure', 'in_progress', [], [{ status: 'completed', conclusion: 'failure' }]), [42]);
  assert.deepEqual(recover.lastCancels, []);
  // It completed between the re-read and the cancel (409): classified anyway.
  const conflict = Object.assign(new Error('Cannot cancel a workflow run that is completed.'), { status: 409 });
  assert.deepEqual(await recover('failure', 'in_progress', [], [{}, { status: 'completed', conclusion: 'failure' }], {}, conflict), [42]);
  // Its verdict on the current body is not stale: a completed run that
  // started after the edit is not rerun either.
  assert.deepEqual(await recover('failure', 'completed', [], [], { run_started_at: AFTER_EDIT }), []);
  // Same-second start counts as before the edit (fail-safe).
  assert.deepEqual(await recover('failure', 'completed', [], [], { run_started_at: EDITED_AT }), [42]);
});

test('a green run is rerun only when the new body breaks the contract', async () => {
  const green = { conclusion: 'success' };
  prBody = GOOD_BODY;
  assert.deepEqual(await recover('success', 'completed', [], [], green), []);
  prBody = '## Implementato\n\n- solo questa sezione\n';
  try {
    assert.deepEqual(await recover('success', 'completed', [], [], green), [42]);
  } finally {
    prBody = GOOD_BODY;
  }
});

test('a cancelled or timed-out latest run is rerun after an edit', async () => {
  assert.deepEqual(await recover('success', 'completed', [], [], { conclusion: 'cancelled' }), [42]);
  assert.deepEqual(await recover('success', 'completed', [], [], { conclusion: 'timed_out' }), [42]);
  assert.deepEqual(await recover('success', 'completed', [], [], { conclusion: 'success' }), []);
});

test('a cancelled run that never settles fails closed instead of returning green', async () => {
  assert.deepEqual(await recover('success', 'in_progress'), []);
  assert.deepEqual(recover.lastCancels, [42]);
  assert.equal(recover.lastFailures.length, 1);
  assert.match(recover.lastFailures[0], /did not settle/);
});

test('a cancellation error other than the documented 409 race remains fatal', async () => {
  const error = Object.assign(new Error('permission denied'), { status: 403 });
  await assert.rejects(
    () => recover('success', 'in_progress', [], [], {}, error),
    /permission denied/,
  );
});

test('missing run metadata or an unknown conclusion fails closed', async () => {
  assert.deepEqual(await recover('success', 'completed', [], [], { run_started_at: undefined }), []);
  assert.match(recover.lastFailures[0], /timestamp/);
  assert.deepEqual(await recover('success', 'completed', [], [], { conclusion: 'neutral' }), []);
  assert.match(recover.lastFailures[0], /unverified conclusion/);
});

test('every fail-closed exit revokes native auto-merge before turning red', async () => {
  assert.deepEqual(
    await recover('success', 'completed', [], [], { run_started_at: undefined }, null, { enabled_by: 'bot' }),
    [],
  );
  assert.deepEqual(recover.lastAutoMergeRevokes, ['PR_node']);
  assert.match(recover.lastFailures[0], /timestamp/);

  assert.deepEqual(
    await recover('success', 'completed', [], [], {}, null, { enabled_by: 'bot' }, 'not-a-date'),
    [],
  );
  assert.deepEqual(recover.lastAutoMergeRevokes, ['PR_node']);
  assert.match(recover.lastFailures[0], /Edit timestamp/);
});

test('only a run of this PR branch and a PR-bound event is a target', async () => {
  assert.deepEqual(await recover('failure', 'completed', [], [], { head_branch: 'main', event: 'push' }), []);
  assert.deepEqual(await recover('failure', 'completed', [], [], { head_branch: 'other' }), []);
  // pr-autorebase dispatches tests.yml on the PR branch without pr_number:
  // no body contract, no review. Rerunning it would not re-enter the check.
  assert.deepEqual(await recover('failure', 'completed', [], [], { event: 'workflow_dispatch' }), []);
});

test('a passed body preserves both a later failure and tests running on the current body', async () => {
  assert.deepEqual(await recover('success'), []);
  assert.deepEqual(await recover('success', 'in_progress', [], [], { run_started_at: AFTER_EDIT }), []);
  assert.deepEqual(recover.lastCancels, []);
});

test('both Codex entry points use the shared sandbox prerequisites', () => {
  for (const name of ['claude-codex-fallback', 'setup-claude-haiku-fallback']) {
    assert.match(read(`.github/actions/${name}/action.yml`), /uses: \.\/\.github\/actions\/setup-codex-sandbox/);
  }
  const setup = read('.github/actions/setup-codex-sandbox/action.yml');
  assert.match(setup, /apparmor_parser -r \/etc\/apparmor.d\/bwrap-userns-restrict/);
  assert.match(setup, /bwrap --unshare-user --unshare-net/);
  assert.doesNotMatch(setup, /sysctl|danger-full-access/);
});


test('a failed body stops every later independent family so edit recovery can settle', () => {
  const afterBody = tests.split('        id: body_contract\n')[1].split('      # ═════════')[1];
  assert.ok(afterBody, 'the body preflight must precede the test families');
  const later = tests.slice(tests.indexOf('        id: unit_gates'));
  const conditions = [...later.matchAll(/^        if: (?:>-\n          )?([^\n]+)/gm)];
  assert.ok(conditions.length >= 10);
  for (const [, condition] of conditions) {
    assert.ok(condition.includes("steps.body_contract.outcome != 'failure'"), condition);
  }
});
