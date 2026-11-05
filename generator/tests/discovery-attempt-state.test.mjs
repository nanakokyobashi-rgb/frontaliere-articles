import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISCOVERY_ATTEMPT_COUNTER_FIELDS,
  DISCOVERY_RECOVERY_THRESHOLD,
  discoveryRecoveryDecision,
  loadDiscoveryAttemptState,
  recordDiscoveryAttempt,
  saveDiscoveryAttemptState,
} from '../scripts/lib/scheduler/discoveryAttemptState.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('recovery becomes due after three unsuccessful proven attempts', () => {
  let state = loadDiscoveryAttemptState({ path: path.join(HERE, 'missing-discovery-state.json') });
  assert.equal(DISCOVERY_RECOVERY_THRESHOLD, 3);

  for (let i = 0; i < 2; i += 1) {
    state = recordDiscoveryAttempt(state, { section: 'frontaliere', poolKind: 'proven' });
    assert.equal(discoveryRecoveryDecision(state, { section: 'frontaliere' }).shouldForceDiscovery, false);
  }

  state = recordDiscoveryAttempt(state, { section: 'frontaliere', poolKind: 'proven' });
  const decision = discoveryRecoveryDecision(state, { section: 'frontaliere' });
  assert.equal(decision.outstandingProvenFailures, 3);
  assert.equal(decision.shouldForceDiscovery, true);
});

test('a discovery attempt resets the outstanding proven failures without decreasing counters', () => {
  let state = loadDiscoveryAttemptState({ path: path.join(HERE, 'missing-discovery-state.json') });
  for (let i = 0; i < 3; i += 1) {
    state = recordDiscoveryAttempt(state, { section: 'frontaliere', poolKind: 'proven' });
  }

  const before = state;
  state = recordDiscoveryAttempt(state, { section: 'frontaliere', poolKind: 'discovery' });
  const after = discoveryRecoveryDecision(state, { section: 'frontaliere' });
  assert.equal(after.provenAttempts, before.frontaliereProvenAttempts);
  assert.equal(after.outstandingProvenFailures, 0);
  assert.equal(after.shouldForceDiscovery, false);
  assert.ok(state.frontaliereDiscoveryResetAt >= before.frontaliereDiscoveryResetAt);
});

test('a successful proven publication clears its own retry debt', () => {
  let state = loadDiscoveryAttemptState({ path: path.join(HERE, 'missing-discovery-state.json') });
  for (let i = 0; i < 3; i += 1) {
    state = recordDiscoveryAttempt(state, { section: 'frontaliere', poolKind: 'proven' });
  }

  state = recordDiscoveryAttempt(state, { section: 'frontaliere', poolKind: 'proven', generated: true });
  const decision = discoveryRecoveryDecision(state, { section: 'frontaliere' });
  assert.equal(decision.provenAttempts, 4);
  assert.equal(decision.outstandingProvenFailures, 0);
  assert.equal(decision.shouldForceDiscovery, false);
});

test('frontaliere and svizzera recovery counters are independent', () => {
  let state = loadDiscoveryAttemptState({ path: path.join(HERE, 'missing-discovery-state.json') });
  for (let i = 0; i < 3; i += 1) {
    state = recordDiscoveryAttempt(state, { section: 'frontaliere', poolKind: 'proven' });
  }
  assert.equal(discoveryRecoveryDecision(state, { section: 'frontaliere' }).shouldForceDiscovery, true);
  assert.equal(discoveryRecoveryDecision(state, { section: 'svizzera' }).shouldForceDiscovery, false);
});

test('state persists and keeps every mergeable counter monotonic', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'discovery-attempt-state-'));
  const statePath = path.join(dir, 'data', 'discovery-attempt-state.json');
  try {
    let state = loadDiscoveryAttemptState({ path: statePath });
    state = recordDiscoveryAttempt(state, { section: 'svizzera', poolKind: 'proven' });
    state = recordDiscoveryAttempt(state, { section: 'svizzera', poolKind: 'discovery' });
    assert.equal(saveDiscoveryAttemptState(state, { path: statePath }), true);

    const reloaded = loadDiscoveryAttemptState({ path: statePath });
    assert.equal(reloaded.svizzeraProvenAttempts, 1);
    assert.equal(reloaded.svizzeraDiscoveryResetAt, 1);
    assert.deepEqual(DISCOVERY_ATTEMPT_COUNTER_FIELDS.map((field) => reloaded[field]), [0, 0, 1, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow recovery CLI records a no-report cooperative stop from its marker', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'discovery-attempt-cli-'));
  try {
    const markerPath = path.join(dir, 'discovery-attempt.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      section: 'frontaliere',
      poolKind: 'proven',
      recoveryEligible: true,
    })}\n`);
    const script = path.resolve(HERE, '../scripts/record-discovery-attempt.mjs');
    const run = spawnSync(process.execPath, [script, markerPath], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const state = loadDiscoveryAttemptState({ path: path.join(dir, 'data', 'discovery-attempt-state.json') });
    assert.equal(state.frontaliereProvenAttempts, 1);
    assert.equal(state.frontaliereDiscoveryResetAt, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the active generator records terminal attempts and workflow merges every counter', () => {
  const generatorSource = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf8');
  const workflow = readFileSync(path.resolve(HERE, '../../.github/workflows/generate-article.yml'), 'utf8');
  const coreWorkflow = readFileSync(path.resolve(HERE, '../../.github/workflows/generate-article-core.yml'), 'utf8');

  assert.match(generatorSource, /persistDiscoveryAttemptOutcome\(RUN_REPORT\.status\)/);
  assert.match(generatorSource, /const noArticleOutcome = \['deferred', 'skipped', 'error'\]\.includes\(status\)/);
  assert.match(generatorSource, /recoveryDecision\.shouldForceDiscovery/);
  assert.match(generatorSource, /DISCOVERY_RECOVERY_DECISION section=/);
  assert.match(generatorSource, /writeDiscoveryAttemptMarker\(/);
  assert.match(workflow, /record-discovery-attempt\.mjs/);
  assert.match(workflow, /git restore --source=HEAD --worktree/);
  assert.match(workflow, /DISCOVERY_ATTEMPT_MARKER="\$attempt_pool_marker"/);
  assert.match(
    workflow,
    /failure\(\) && steps\.generate\.outcome == 'failure' && steps\.generate\.outputs\.article != 'true'/,
  );
  const commitStart = workflow.indexOf('      - name: Commit and push');
  const reportStart = workflow.indexOf('RUN_REPORT="$RUNNER_TEMP/create-article-run-report.json"', commitStart);
  const noChangesGate = workflow.slice(
    workflow.indexOf('git add -A', commitStart),
    reportStart,
  );
  assert.ok(commitStart >= 0 && reportStart > commitStart, 'il commit step deve contenere un gate report delimitabile');
  assert.match(noChangesGate, /if git diff --cached --quiet; then[\s\S]*cooperative_stop.*article/);
  assert.ok(
    noChangesGate.indexOf('cooperative_stop') < noChangesGate.indexOf('exit 0'),
    'the no-change exit must leave cooperative-stop runs for marker recovery',
  );
  const cooperativeNoReportBranch = workflow.slice(
    workflow.indexOf('elif [ "${{ steps.generate.outputs.cooperative_stop }}" = "true"'),
    workflow.indexOf('elif [ "${{ steps.generate.outputs.article }}" != "true" ] && [ "${{ steps.generate.outputs.declared }}" = "true" ]'),
  );
  assert.match(cooperativeNoReportBranch, /node generator\/scripts\/record-discovery-attempt\.mjs/);
  assert.match(cooperativeNoReportBranch, /git add -- "\$recovery_state"/);
  const failedGenerationRecoveryBranch = workflow.slice(
    workflow.indexOf('if [ "${{ steps.generate.outcome }}" = "failure" ]; then', commitStart),
    workflow.indexOf('else\n            git add -A', commitStart),
  );
  assert.match(failedGenerationRecoveryBranch, /generation failed without an article/);
  assert.match(failedGenerationRecoveryBranch, /git reset --hard HEAD[\s\S]*git clean -fd/);
  assert.match(failedGenerationRecoveryBranch, /node generator\/scripts\/record-discovery-attempt\.mjs/);
  assert.doesNotMatch(failedGenerationRecoveryBranch, /cooperative_stop/);
  assert.match(
    coreWorkflow,
    /failure\(\) && steps\.generate\.outcome == 'failure' && steps\.generate\.outputs\.article != 'true'/,
  );
  const coreCommitStart = coreWorkflow.indexOf('      - name: Commit and push');
  const coreFailedGenerationRecoveryBranch = coreWorkflow.slice(
    coreWorkflow.indexOf('if [ "${{ steps.generate.outcome }}" = "failure" ]; then', coreCommitStart),
    coreWorkflow.indexOf('else\n            git add -A', coreCommitStart),
  );
  assert.match(coreFailedGenerationRecoveryBranch, /git reset --hard HEAD[\s\S]*git clean -fd/);
  assert.match(coreFailedGenerationRecoveryBranch, /node generator\/scripts\/record-discovery-attempt\.mjs/);
  assert.doesNotMatch(coreFailedGenerationRecoveryBranch, /cooperative_stop/);
  for (const field of DISCOVERY_ATTEMPT_COUNTER_FIELDS) {
    assert.ok(
      workflow.includes(`--merge-counter data/discovery-attempt-state.json:${field}`),
      `missing conflict-safe merge declaration for ${field}`,
    );
  }
});
