import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const tests = read('.github/workflows/tests.yml');
const recovery = read('.github/workflows/retry-code-check-after-body-edit.yml');
const script = recovery.slice(recovery.indexOf('          script: |\n') + '          script: |\n'.length)
  .split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function recover(bodyConclusion, status = 'completed') {
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
      steps: [{ name: 'PR-body completeness + multi-issue Closes (zero-Claude)', conclusion: bodyConclusion }],
    }],
  };
  await new AsyncFunction('github', 'context', 'core', script)(github, {
    repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 1, head: { sha: 'head' } } },
  }, { info() {} });
  return reruns;
}

test('metadata edits do not start the code pipeline; recovery uses only trusted API calls', () => {
  assert.doesNotMatch(tests.match(/types: \[[^\]]+\]/)[0], /edited|labeled/);
  assert.match(recovery, /pull_request_target:\n    types: \[edited\]/);
  assert.doesNotMatch(recovery, /actions\/checkout|createCheckRun/);
});

test('a corrected failed body retries the code run', async () => {
  assert.deepEqual(await recover('failure'), [42]);
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
