import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, parseTapSummary } from '../../scripts/ci/content-gates-main.mjs';

const goodPreflight = () => ({ ok: true, violations: [], perRoot: [] });
const tap = (failed = false) => `TAP version 13\n${failed ? 'not ok' : 'ok'} 1 - content check\n1..1\n# tests 1\n# suites 0\n# pass ${failed ? 0 : 1}\n# fail ${failed ? 1 : 0}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-gate-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const summaryFile = path.join(root, 'summary.json');
  const calls = [];
  return {
    root, summaryFile, calls,
    read: () => JSON.parse(fs.readFileSync(summaryFile, 'utf8')),
    options: { root, argv: ['--json', summaryFile], gates: ['fixture.test.mjs'], env: { GITHUB_SHA: 'fixture-sha' },
      checkPreflight: goodPreflight,
      runTests: () => ({ status: 0, stdout: tap(), stderr: '' }),
      createIssue: async (issue) => calls.push(['create', issue]),
      resolveIssue: async () => calls.push(['resolve']),
    },
  };
}

test('successful run writes deterministic counters and resolves the alert', async (t) => {
  const f = fixture(t);
  assert.equal(await main(f.options), 0);
  const first = fs.readFileSync(f.summaryFile, 'utf8');
  assert.equal(f.read().state, 'passed');
  assert.equal(f.read().tap.complete, true);
  assert.equal(f.read().tap.tests, 1);
  assert.deepEqual(f.calls, [['resolve']]);
  assert.equal(await main(f.options), 0);
  assert.equal(fs.readFileSync(f.summaryFile, 'utf8'), first);
});

for (const dryRun of [false, true]) {
  test(`offenders fail the process even when dryRun=${dryRun}`, async (t) => {
    const f = fixture(t);
    const result = await main({ ...f.options,
      argv: [...f.options.argv, ...(dryRun ? ['--dry-run'] : [])],
      runTests: () => ({ status: 1, stdout: tap(true), stderr: 'content/articles/problem.ts' }),
    });
    assert.equal(result, 1);
    assert.equal(f.read().exitCode, 1);
    assert.equal(f.read().state, 'failed');
    assert.deepEqual(f.read().offenders, ['content/articles/problem.ts']);
    assert.deepEqual(f.read().failures.tests, ['content check']);
    assert.equal(f.calls.length, dryRun ? 0 : 1);
    if (!dryRun) assert.equal(f.calls[0][0], 'create');
  });
}

for (const [name, result] of [
  ['truncated TAP with successful child status', { status: 0, stdout: 'ok 1 - incomplete\n' }],
  ['failing TAP with successful child status', { status: 0, stdout: tap(true) }],
  ['spawn error', { status: null, error: new Error('spawn unavailable') }],
  ['signal termination', { status: null, signal: 'SIGTERM', stdout: tap() }],
]) {
  test(`${name} cannot yield a passing summary`, async (t) => {
    const f = fixture(t);
    assert.equal(await main({ ...f.options, runTests: () => result }), 1);
    assert.equal(f.read().exitCode, 1);
    assert.notEqual(f.read().state, 'passed');
  });
}

test('preflight failure writes evidence without starting tests or notifications', async (t) => {
  const f = fixture(t);
  assert.equal(await main({ ...f.options,
    checkPreflight: () => ({ ok: false, violations: ['missing fixture corpus'], perRoot: [] }),
    runTests: () => assert.fail('must not start tests'),
  }), 1);
  assert.equal(f.read().state, 'preflight-failed');
  assert.equal(f.read().child, null);
  assert.deepEqual(f.calls, []);
});

test('notification error preserves a nonzero result and summary', async (t) => {
  const f = fixture(t);
  assert.equal(await main({ ...f.options, resolveIssue: async () => { throw new Error('notification unavailable'); } }), 1);
  assert.equal(f.read().state, 'execution-error');
  assert.equal(f.read().error, 'notification unavailable');
});

test('TAP summary rejects zero tests and inconsistent totals', () => {
  assert.equal(parseTapSummary(tap().replace('# tests 1', '# tests 2')).complete, false);
  assert.equal(parseTapSummary(tap().replace('1..1', '1..0').replace('# tests 1', '# tests 0').replace('# pass 1', '# pass 0')).complete, false);
});

for (const failed of [false, true]) {
  test(`real CLI drains large piped TAP and emits final artifact (failed=${failed})`, (t) => {
    const f = fixture(t);
    const gateFile = path.join(f.root, 'fixture.test.mjs');
    const cliFile = path.join(f.root, 'cli.mjs');
    fs.writeFileSync(gateFile, `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('large output', () => { console.log('x'.repeat(1024 * 1024)); console.log('FINAL_GATE_SENTINEL'); assert.equal(${failed}, false, 'content/articles/problem.ts'); });\n`);
    const runnerUrl = new URL('../../scripts/ci/content-gates-main.mjs', import.meta.url).href;
    fs.writeFileSync(cliFile, `import { main, runCli } from ${JSON.stringify(runnerUrl)};\nawait runCli(() => main({root:${JSON.stringify(f.root)}, gates:[${JSON.stringify(gateFile)}], argv:['--dry-run','--json',${JSON.stringify(f.summaryFile)}], checkPreflight:()=>({ok:true,violations:[],perRoot:[]}), env:{} }));\n`);
    // A standalone CLI must not inherit node:test's child IPC serializer mode.
    const cliEnv = { ...process.env };
    delete cliEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [cliFile], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: cliEnv });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, failed ? 1 : 0, result.stderr);
    assert.ok(result.stdout.length > 1024 * 1024);
    assert.ok(result.stdout.includes('FINAL_GATE_SENTINEL'));
    assert.match(result.stdout, /^# duration_ms /m);
    assert.equal(parseTapSummary(result.stdout).complete, true);
    assert.equal(f.read().tap.tests, 1);
    assert.equal(f.read().state, failed ? 'failed' : 'passed');
    assert.equal(f.read().exitCode, result.status);
  });
}

test('workflow uploads the runner summary even after gate failure', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/content-gates-main.yml', import.meta.url), 'utf8');
  assert.match(workflow, /--json "\$RUNNER_TEMP\/content-gates-main-summary\.json"/);
  assert.match(workflow, /name: Upload content gate summary\s+if: always\(\)\s+uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/content-gates-main-summary\.json/);
});
