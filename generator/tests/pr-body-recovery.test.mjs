import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const tests = read('.github/workflows/tests.yml');
const recovery = read('.github/workflows/retry-code-check-after-body-edit.yml');
const script = recovery.slice(recovery.indexOf('          script: |\n') + '          script: |\n'.length)
  .split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function recover(bodyConclusion, status = 'completed', failedSteps = []) {
  const reruns = [];
  const run = { id: 42, run_attempt: 1, status, conclusion: 'failure' };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { state: 'open', head: { sha: 'head' } } }) },
      actions: {
        listWorkflowRuns: 'runs', listJobsForWorkflowRun: 'jobs',
        getWorkflowRun: async () => ({ data: run }),
        reRunWorkflow: async ({ run_id }) => { reruns.push(run_id); },
      },
    },
    paginate: async endpoint => endpoint === 'runs' ? [run] : [{
      conclusion: failedSteps.length ? 'failure' : undefined,
      steps: [
        { name: 'PR-body completeness + multi-issue Closes (zero-Claude)', conclusion: bodyConclusion },
        ...failedSteps.map(name => ({ name, conclusion: 'failure' })),
      ],
    }],
  };
  await new AsyncFunction('github', 'context', 'core', script)(github, {
    repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 1, head: { sha: 'head' } } },
  }, { info() {} });
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
  assert.doesNotMatch(recovery, /actions\/checkout|createCheckRun/);
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

test('a passed body preserves both a later failure and running tests', async () => {
  assert.deepEqual(await recover('success'), []);
  assert.deepEqual(await recover('success', 'in_progress'), []);
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
