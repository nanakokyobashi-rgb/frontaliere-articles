/**
 * Deterministic contract for the temporary NON-PRODUCTION rerun probe.
 *
 * The workflow assertions intentionally scan critical YAML blocks without adding a YAML
 * dependency. They fail closed when a block cannot be located; GitHub/CI remains the syntax
 * parser for the workflow itself. The executable behavior is tested through the same
 * zero-dependency module fetched by the job at its immutable head SHA.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_HOLD_SECONDS,
  MAX_RECORD_BYTES,
  PROBE_SCHEDULE,
  PROBE_SCHEDULE_CUTOFF_MS,
  PROBE_SCHEMA,
  PROBE_WINDOW_START_MS,
  buildProbeRecord as buildProbeRecordWithClock,
  resolveProbeOutput,
  runProbe,
  validateProbeCutoff,
  validateScheduleWindow,
} from '../../scripts/ci/verify-translate-queue-rerun-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/translate-queue-rerun-probe.yml');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const ACTIVE = WORKFLOW.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const MANUAL_TOKEN = 'rerun-preservation-20260901';
const IN_WINDOW_MS = Date.parse('2026-09-01T18:00:00.000Z');

/** Every non-cutoff test is independent from the wall clock by construction. */
function buildProbeRecord(environment, now = IN_WINDOW_MS) {
  return buildProbeRecordWithClock(environment, now);
}

function environment(overrides = {}) {
  const runnerTemp = mkdtempSync(path.join(os.tmpdir(), 'translate-rerun-probe-'));
  return {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_RUN_ID: '33344455566',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: SHA,
    PROBE_TOKEN: MANUAL_TOKEN,
    PROBE_ROLE: 'candidate',
    PROBE_HOLD_SECONDS: '0',
    PROBE_SCHEDULE: '',
    RUNNER_TEMP: runnerTemp,
    PROBE_OUTPUT: path.join(runnerTemp, 'translate-queue-rerun-probe', 'record.json'),
    GITHUB_STEP_SUMMARY: path.join(runnerTemp, 'step-summary.md'),
    ...overrides,
  };
}

function scheduledEnvironment(attempt) {
  const runId = '33344455577';
  return environment({
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: String(attempt),
    PROBE_TOKEN: `schedule-${runId}`,
    PROBE_ROLE: 'candidate',
    PROBE_HOLD_SECONDS: '0',
    PROBE_SCHEDULE: PROBE_SCHEDULE,
  });
}

function block(text, startPattern, nextPattern, label) {
  const start = text.search(startPattern);
  assert.notEqual(start, -1, `${label}: inizio blocco non trovato`);
  const rest = text.slice(start + 1);
  const end = rest.search(nextPattern);
  assert.notEqual(end, -1, `${label}: fine blocco non trovata`);
  return rest.slice(0, end);
}

function invalid(overrides, expected) {
  assert.throws(() => buildProbeRecord(environment(overrides)), expected);
}

test('manual attempt 1/2 conserva binding e cambia soltanto attempt', () => {
  const first = buildProbeRecord(environment()).record;
  const second = buildProbeRecord(environment({ GITHUB_RUN_ATTEMPT: '2' })).record;
  assert.deepEqual(first, {
    attempt: 1,
    eventName: 'workflow_dispatch',
    headSha: SHA,
    holdSeconds: 0,
    role: 'candidate',
    runId: '33344455566',
    schedule: null,
    schema: PROBE_SCHEMA,
    tokenSha256: `sha256:${createHash('sha256').update(MANUAL_TOKEN).digest('hex')}`,
  });
  assert.deepEqual(second, { ...first, attempt: 2 });
});

test('schedule attempt 1/2 forza candidate/0 e la schedule esatta', () => {
  const first = buildProbeRecord(scheduledEnvironment(1), IN_WINDOW_MS).record;
  const second = buildProbeRecord(scheduledEnvironment(2), IN_WINDOW_MS).record;
  assert.equal(first.eventName, 'schedule');
  assert.equal(first.schedule, '*/5 16-20 1 9 *');
  assert.equal(first.role, 'candidate');
  assert.equal(first.holdSeconds, 0);
  assert.equal(first.runId, second.runId);
  assert.equal(first.tokenSha256, second.tokenSha256);
  assert.equal(first.attempt, 1);
  assert.equal(second.attempt, 2);
});

test('schedule attempt 1 e calendar-bound, ma i rerun restano ammessi dopo cutoff', () => {
  assert.equal(PROBE_WINDOW_START_MS, Date.parse('2026-09-01T16:00:00.000Z'));
  assert.equal(PROBE_SCHEDULE_CUTOFF_MS, Date.parse('2026-09-01T21:15:00.000Z'));
  assert.doesNotThrow(() => validateScheduleWindow(
    { attempt: 1, schedule: PROBE_SCHEDULE },
    Date.parse('2026-09-01T20:55:00.000Z'),
  ));
  assert.throws(() => validateScheduleWindow(
    { attempt: 1, schedule: PROBE_SCHEDULE },
    Date.parse('2027-09-01T16:00:00.000Z'),
  ), /probe_window_closed/);
  assert.throws(() => buildProbeRecord(
    scheduledEnvironment(1),
    PROBE_SCHEDULE_CUTOFF_MS + 1,
  ), /probe_window_closed/);
  assert.doesNotThrow(() => buildProbeRecord(
    scheduledEnvironment(2),
    Date.parse('2027-09-01T16:00:00.000Z'),
  ));
});

test('cutoff globale respinge ogni attempt 1, ma non i rerun manuali', () => {
  const beforeCutoff = PROBE_SCHEDULE_CUTOFF_MS - 1;
  const afterCutoff = PROBE_SCHEDULE_CUTOFF_MS + 1;
  const nextYear = Date.parse('2027-09-01T16:00:00.000Z');
  assert.doesNotThrow(() => buildProbeRecord(environment(), beforeCutoff));
  assert.throws(() => buildProbeRecord(environment(), afterCutoff), /probe_window_closed/);
  assert.throws(() => validateProbeCutoff(1, nextYear), /probe_window_closed/);
  assert.throws(() => buildProbeRecord(environment(), nextYear), /probe_window_closed/);
  assert.doesNotThrow(() => buildProbeRecord(
    environment({ GITHUB_RUN_ATTEMPT: '2' }),
    nextYear,
  ));
});

test('il JSON e canonico, bounded e contiene solo lo hash del token', () => {
  const { record, json } = buildProbeRecord(environment());
  assert.ok(Buffer.byteLength(json) <= MAX_RECORD_BYTES);
  assert.equal(json, `${JSON.stringify(record, Object.keys(record).sort())}\n`);
  assert.ok(!json.includes(MANUAL_TOKEN), 'il token raw non deve entrare nel record');
  assert.match(record.tokenSha256, /^sha256:[a-f0-9]{64}$/);
});

test('event, run id, attempt e SHA invalidi falliscono chiusi', () => {
  invalid({ GITHUB_EVENT_NAME: 'push' }, /invalid_event_name/);
  invalid({ GITHUB_RUN_ID: '0' }, /invalid_run_id/);
  invalid({ GITHUB_RUN_ID: '1'.repeat(21) }, /invalid_run_id/);
  invalid({ GITHUB_RUN_ATTEMPT: '0' }, /invalid_run_attempt/);
  invalid({ GITHUB_RUN_ATTEMPT: '1000' }, /invalid_run_attempt/);
  invalid({ GITHUB_SHA: 'A'.repeat(40) }, /invalid_head_sha/);
  invalid({ GITHUB_SHA: 'a'.repeat(39) }, /invalid_head_sha/);
});

test('token, role e hold invalidi falliscono chiusi', () => {
  invalid({ PROBE_TOKEN: '' }, /invalid_probe_token/);
  invalid({ PROBE_TOKEN: 'secret token' }, /invalid_probe_token/);
  invalid({ PROBE_TOKEN: 'a'.repeat(65) }, /invalid_probe_token/);
  invalid({ PROBE_ROLE: 'observer' }, /invalid_probe_role/);
  invalid({ PROBE_HOLD_SECONDS: '-1' }, /invalid_hold_seconds/);
  invalid({ PROBE_HOLD_SECONDS: String(MAX_HOLD_SECONDS + 1) }, /invalid_hold_seconds/);
  invalid({ PROBE_ROLE: 'candidate', PROBE_HOLD_SECONDS: '1' }, /invalid_role_hold_binding/);
  invalid({ PROBE_ROLE: 'blocker', PROBE_HOLD_SECONDS: '0' }, /invalid_role_hold_binding/);
  assert.equal(
    buildProbeRecord(environment({ PROBE_ROLE: 'blocker', PROBE_HOLD_SECONDS: '900' })).record.holdSeconds,
    900,
  );
});

test('schedule non puo ereditare input manuali o una cadenza diversa', () => {
  assert.throws(
    () => buildProbeRecord(
      { ...scheduledEnvironment(1), PROBE_SCHEDULE: '0 * * * *' },
      Date.parse('2026-09-01T18:00:00.000Z'),
    ),
    /invalid_schedule/,
  );
  assert.throws(
    () => buildProbeRecord(
      { ...scheduledEnvironment(1), PROBE_TOKEN: MANUAL_TOKEN },
      Date.parse('2026-09-01T18:00:00.000Z'),
    ),
    /invalid_schedule_token/,
  );
  assert.throws(
    () => buildProbeRecord(
      { ...scheduledEnvironment(1), PROBE_ROLE: 'blocker' },
      Date.parse('2026-09-01T18:00:00.000Z'),
    ),
    /invalid_schedule_mode/,
  );
  invalid({ PROBE_SCHEDULE: PROBE_SCHEDULE }, /unexpected_manual_schedule/);
});

test('runProbe ordinario usa un clock fisso e un output sotto RUNNER_TEMP', async () => {
  const env = environment();
  assert.equal(resolveProbeOutput(env).output, env.PROBE_OUTPUT);
  assert.throws(
    () => resolveProbeOutput({ ...env, PROBE_OUTPUT: path.join(env.RUNNER_TEMP, '..', 'record.json') }),
    /invalid_probe_output/,
  );
  assert.throws(
    () => resolveProbeOutput({ ...env, RUNNER_TEMP: 'relative', PROBE_OUTPUT: 'relative/record.json' }),
    /invalid_runner_temp/,
  );

  let slept = null;
  let logged = '';
  const blocker = environment({ PROBE_ROLE: 'blocker', PROBE_HOLD_SECONDS: '1' });
  const result = await runProbe(
    blocker,
    async (milliseconds) => { slept = milliseconds; },
    (text) => { logged += text; },
    IN_WINDOW_MS,
  );
  assert.equal(slept, 1000);
  assert.equal(result.record.attempt, 1);
  assert.equal(statSync(result.output).mode & 0o777, 0o600);
  assert.equal(readFileSync(result.output, 'utf8'), buildProbeRecord(blocker).json);
  assert.equal(logged, result.json);
  assert.match(readFileSync(blocker.GITHUB_STEP_SUMMARY, 'utf8'), /```json/);
  assert.ok(readFileSync(blocker.GITHUB_STEP_SUMMARY, 'utf8').includes(result.json));
  assert.ok(!readFileSync(result.output, 'utf8').includes(MANUAL_TOKEN));
  assert.ok(!logged.includes(MANUAL_TOKEN));
  assert.ok(!readFileSync(blocker.GITHUB_STEP_SUMMARY, 'utf8').includes(MANUAL_TOKEN));
});

test('workflow: trigger e schedule temporanea sono esatti e fail-closed', () => {
  assert.match(
    WORKFLOW,
    /^# Cleanup: remove this workflow and its schedule in an immediate PR after the probe\.$/m,
  );
  assert.match(ACTIVE, /^name: NON-PRODUCTION Translate Queue Rerun Preservation Probe$/m);
  assert.match(ACTIVE, /format\('NON-PRODUCTION rerun-probe \{0\} \{1\}', inputs\.probe_token, inputs\.role\)/);
  const on = block(ACTIVE, /\non:\s*\n/, /\npermissions:\s*\n/, 'on');
  assert.deepEqual(
    [...on.matchAll(/^  ([a-z_]+):$/gm)].map((match) => match[1]),
    ['workflow_dispatch', 'schedule'],
  );
  assert.equal((on.match(/cron: '\*\/5 16-20 1 9 \*'/g) || []).length, 1);
  assert.doesNotMatch(on, /cron: '\*\/5 \* \* \* \*'/);
  for (const input of ['probe_token', 'role', 'hold_seconds']) {
    assert.match(on, new RegExp(`^      ${input}:$`, 'm'), `${input}: input assente`);
  }
  assert.match(on, /role:[\s\S]*type: choice[\s\S]*- candidate[\s\S]*- blocker/);
  assert.match(on, /hold_seconds:[\s\S]*default: '0'[\s\S]*type: string/);
});

test('workflow: concurrency riproduce il pending replacement senza cancellare il blocker', () => {
  const concurrency = block(ACTIVE, /\nconcurrency:\s*\n/, /\njobs:\s*\n/, 'concurrency');
  assert.match(concurrency, /^  group: translation-queue-rerun-probe$/m);
  assert.match(concurrency, /^  cancel-in-progress: false$/m);
  assert.doesNotMatch(concurrency, /^\s+queue:/m);
  assert.equal((ACTIVE.match(/^concurrency:$/gm) || []).length, 1);
});

test('workflow: job bounded, read-only, senza checkout, secret o comandi produttivi', () => {
  const permissions = block(ACTIVE, /\npermissions:\s*\n/, /\nconcurrency:\s*\n/, 'permissions');
  assert.deepEqual(
    permissions.split('\n').filter((line) => /^  [a-z-]+:/.test(line)),
    ['  actions: read', '  contents: read'],
  );
  assert.deepEqual(ACTIVE.match(/^permissions:.*$/gm), ['permissions:']);
  assert.doesNotMatch(ACTIVE, /^[ \t]+permissions:/m);
  assert.doesNotMatch(ACTIVE, /\bwrite-all\b|^\s+[a-z-]+:\s*write\s*$/m);
  assert.doesNotMatch(ACTIVE, /secrets(?:\.|\s*\[)|github\.token|GITHUB_TOKEN|GH_TOKEN/);
  assert.doesNotMatch(ACTIVE, /actions\/checkout|\bnpm (?:ci|install)\b|\bgit push\b|\bgh\s/);
  assert.doesNotMatch(ACTIVE, /translate-pending\.yml|create-article|build-api|publish-api/);

  const jobs = ACTIVE.slice(ACTIVE.indexOf('\njobs:\n'));
  assert.deepEqual([...jobs.matchAll(/^  ([a-z][\w-]*):$/gm)].map((match) => match[1]), ['probe']);
  assert.deepEqual(jobs.match(/^    runs-on: .+$/gm), ['    runs-on: ubuntu-latest']);
  assert.doesNotMatch(jobs, /self-hosted/);
  const timeout = Number((jobs.match(/^    timeout-minutes: (\d+)$/m) || [])[1]);
  assert.ok(Number.isFinite(timeout) && timeout <= 20);
  const scriptPaths = [...jobs.matchAll(/PROBE_SCRIPT: (\$\{\{ runner\.temp \}\}\/verify-translate-queue-rerun-probe\.mjs)/g)]
    .map((match) => match[1]);
  assert.deepEqual(scriptPaths, [scriptPaths[0], scriptPaths[0]]);
  assert.equal(scriptPaths[0], '${{ runner.temp }}/verify-translate-queue-rerun-probe.mjs');
  assert.match(jobs, /run: node "\$PROBE_SCRIPT"/);
  assert.match(jobs, /--output "\$PROBE_SCRIPT" "\$PROBE_SCRIPT_URL"/);
  assert.match(jobs, /PROBE_SCRIPT_URL: https:\/\/raw\.githubusercontent\.com\/\$\{\{ github\.repository \}\}\/\$\{\{ github\.sha \}\}\/scripts\/ci\/verify-translate-queue-rerun-probe\.mjs/);
  assert.match(jobs, /\[\[ "\$RUN_HEAD_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]/);
  assert.match(jobs, /PROBE_TOKEN: \$\{\{ github\.event_name == 'schedule' && format\('schedule-\{0\}', github\.run_id\) \|\| inputs\.probe_token \}\}/);
  assert.match(jobs, /PROBE_SCHEDULE: \$\{\{ github\.event\.schedule \|\| '' \}\}/);
  assert.match(jobs, /name: translate-queue-rerun-probe-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(jobs, /PROBE_ROLE: \$\{\{ github\.event_name == 'schedule' && 'candidate' \|\| inputs\.role \}\}/);
  assert.match(jobs, /PROBE_HOLD_SECONDS: \$\{\{ github\.event_name == 'schedule' && '0' \|\| inputs\.hold_seconds \}\}/);

  const uploadUses = jobs.match(/^\s+uses: actions\/upload-artifact@.*$/gm) || [];
  assert.deepEqual(uploadUses, [
    '        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
  ]);
  assert.doesNotMatch(uploadUses[0], /@(?:v\d|main|master|HEAD)\b|@[a-f0-9]{1,39}(?:\s|#|$)/);
});

test('workflow: il fetch ha retry e tempo totale strettamente bounded', () => {
  const attempts = [...ACTIVE.matchAll(/for attempt in ((?:\d+ ?)+); do/g)][0]?.[1]
    .trim().split(/\s+/).map(Number);
  assert.deepEqual(attempts, [1, 2, 3]);
  const maxTime = Number((ACTIVE.match(/--max-time (\d+)/) || [])[1]);
  const connectTimeout = Number((ACTIVE.match(/--connect-timeout (\d+)/) || [])[1]);
  const backoff = Number((ACTIVE.match(/^\s+sleep (\d+)$/m) || [])[1]);
  assert.deepEqual({ maxTime, connectTimeout, backoff }, { maxTime: 20, connectTimeout: 5, backoff: 2 });
  assert.ok(attempts.length * maxTime + (attempts.length - 1) * backoff <= 64);
  assert.match(ACTIVE, /if \[ "\$attempt" -eq 3 \]; then\n\s+exit 1/);
});

test('manifest: i tre artifact sono corpus-only con ragione specifica e baseline locale', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const rel of [
    '.github/workflows/translate-queue-rerun-probe.yml',
    'scripts/ci/verify-translate-queue-rerun-probe.mjs',
    'generator/tests/translate-queue-rerun-probe.test.mjs',
  ]) {
    const entry = byPath.get(rel);
    assert.ok(entry, `${rel}: voce manifest assente`);
    assert.equal(entry.mode, 'corpus-only');
    assert.equal(entry.baseline.site, null);
    assert.match(entry.reason, /NON-PRODUCTION|non produttiv/i);
    assert.match(entry.reason, /rerun|job-zero/i);
    assert.match(entry.reason, /PR immediata.*cleanup/i);
    const hash = createHash('sha256').update(readFileSync(path.join(ROOT, rel))).digest('hex').slice(0, 16);
    assert.equal(entry.baseline.corpus, hash, `${rel}: baseline non congelata sul contenuto`);
  }
});
