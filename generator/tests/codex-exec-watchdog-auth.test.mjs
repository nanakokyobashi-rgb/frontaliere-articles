/**
 * codex-exec-watchdog-auth.test.mjs — esegue davvero i pezzi di shell della
 * action Codex che decidono l'esito di un `codex exec`, invece di cercarne il
 * testo.
 *
 * - Pipeline a tre stadi (printf | timeout codex | tee): lo stato di Codex e'
 *   PIPESTATUS[1], quello del tee PIPESTATUS[2]. Leggere [0]/[1] faceva
 *   passare ogni fallimento di Codex per "diagnostics stream could not be
 *   written" e non impostava mai `codex_timed_out` (run 36009410204).
 * - Watchdog per caller (`exec_timeout_seconds`, default 1800) in un
 *   intervallo chiuso; override solo sui caller batch, sotto il tetto dello
 *   step.
 * - Classificatore auth sullo stderr di Codex e alert unico "Codex auth
 *   down", chiuso dal primo run Codex che autentica di nuovo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACTION = fs.readFileSync(path.join(ROOT, '.github/actions/claude-codex-fallback/action.yml'), 'utf8');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');
const ALERT_TITLE = 'Codex auth down: CODEX_AUTH_JSON refresh token rejected';

const dedent = (text) => text.split('\n').map((line) => (line.startsWith('        ') ? line.slice(8) : line)).join('\n');

function segment(startMarker, endMarker) {
  const start = ACTION.indexOf(startMarker);
  assert.notEqual(start, -1, `inizio segmento non trovato: ${startMarker}`);
  const end = ACTION.indexOf(endMarker, start);
  assert.notEqual(end, -1, `fine segmento non trovata: ${endMarker}`);
  return dedent(ACTION.slice(start, end));
}

function stepRun(name) {
  const start = ACTION.indexOf(`    - name: ${name}\n`);
  assert.notEqual(start, -1, `step non trovato: ${name}`);
  const next = ACTION.indexOf('\n    - name: ', start + 1);
  const block = ACTION.slice(start, next === -1 ? undefined : next);
  const run = block.indexOf('      run: |\n');
  assert.notEqual(run, -1, `run mancante: ${name}`);
  return { block, script: dedent(block.slice(run + '      run: |\n'.length)) };
}

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Pipeline, watchdog e classificatore auth
// ---------------------------------------------------------------------------

const PIPELINE = segment(
  '        codex_stderr="$git_bridge_host_scratch/codex-run.stderr"',
  '        codex_review_posted=false\n',
);

const FAKE_CODEX = `#!/bin/bash
cat >/dev/null
case "$FAKE_MODE" in
  ok) echo '{"type":"turn.completed"}'; exit 0 ;;
  fail) echo '{"type":"thread.started"}'; echo 'ERROR codex_core: stream disconnected before completion' >&2; exit 1 ;;
  auth) echo 'ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used' >&2; exit 1 ;;
  auth-in-answer) echo '{"type":"item.completed","item":{"type":"agent_message","text":"401 Unauthorized: Failed to refresh token"}}'; exit 1 ;;
  auth-warning-ok) echo 'WARN codex_login: Failed to refresh token, retrying' >&2; echo '{"type":"turn.completed"}'; exit 0 ;;
  hang) echo '{"type":"thread.started"}'; exec sleep 30 ;;
esac
`;

function runPipeline(mode, { timeoutSeconds = 60, diagnosticsIsDirectory = false } = {}) {
  const root = tempRoot('codex-pipeline-');
  try {
    const fake = path.join(root, 'codex');
    fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 });
    fs.mkdirSync(path.join(root, 'host'));
    const diagnostics = path.join(root, diagnosticsIsDirectory ? 'diag-dir' : 'diag.jsonl');
    if (diagnosticsIsDirectory) fs.mkdirSync(diagnostics);
    else fs.writeFileSync(diagnostics, '');
    const script = [
      'set -euo pipefail',
      "prompt='review please'",
      'codex_env=("PATH=/usr/bin:/bin" "FAKE_MODE=$FAKE_MODE")',
      'codex_timeout_bin=/usr/bin/timeout',
      'codex_exec_kill_grace_seconds=1',
      'codex_exec_timeout_seconds="$TEST_TIMEOUT"',
      'codex_bin="$FAKE_CODEX"',
      "codex_filesystem='{}'",
      'codex_reasoning_effort=max',
      "codex_env_patterns='[]'",
      'CODEX_OUTPUT="$TEST_ROOT/last.txt"',
      'codex_diagnostics_destination="$TEST_DIAGNOSTICS"',
      'git_bridge_host_scratch="$TEST_ROOT/host"',
      PIPELINE,
      'printf "RESULT codex=%s diagnostics=%s timed_out=%s auth=%s\\n" "$codex_status" "$tee_status" "$codex_timed_out" "$codex_auth_failure"',
    ].join('\n');
    const result = spawnSync('/bin/bash', ['-c', script], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: '/usr/bin:/bin',
        FAKE_MODE: mode,
        FAKE_CODEX: fake,
        TEST_TIMEOUT: String(timeoutSeconds),
        TEST_ROOT: root,
        TEST_DIAGNOSTICS: diagnostics,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split('\n').find((candidate) => candidate.startsWith('RESULT ')) || '';
    const fields = Object.fromEntries(line.slice('RESULT '.length).split(' ').map((pair) => pair.split('=')));
    return {
      ...fields,
      stdout: result.stdout,
      stream: diagnosticsIsDirectory ? '' : fs.readFileSync(diagnostics, 'utf8'),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('pipeline: lo stato di Codex e del tee vengono dagli stadi giusti', () => {
  assert.match(ACTION, /codex_status="\$\{pipeline_status\[1\]:-1\}"/u);
  assert.match(ACTION, /tee_status="\$\{pipeline_status\[2\]:-1\}"/u);

  const ok = runPipeline('ok');
  assert.deepEqual([ok.codex, ok.diagnostics, ok.timed_out, ok.auth], ['0', '0', 'false', 'false']);

  // Run 36009410204: un fallimento di Codex non e' un errore del tee.
  const failed = runPipeline('fail');
  assert.deepEqual([failed.codex, failed.diagnostics, failed.timed_out, failed.auth], ['1', '0', 'false', 'false']);
  assert.doesNotMatch(failed.stdout, /diagnostics stream could not be written/u);
  // Lo stderr di Codex resta anche nello stream JSONL del classificatore.
  assert.match(failed.stream, /stream disconnected before completion/u);
  assert.match(failed.stream, /"thread\.started"/u);
});

test('pipeline: il watchdog imposta codex_timed_out e il marker JSONL', () => {
  const hung = runPipeline('hang', { timeoutSeconds: 1 });
  assert.equal(hung.codex, '124');
  assert.equal(hung.diagnostics, '0');
  assert.equal(hung.timed_out, 'true');
  assert.doesNotMatch(hung.stdout, /diagnostics stream could not be written/u);
  assert.match(hung.stdout, /exceeded its 1-second internal watchdog/u);
  assert.match(hung.stream, /\n\{"type":"codex_timeout","codex_timeout":true,"timeout_seconds":1\}\n/u);
});

test('pipeline: un vero errore di scrittura del diagnostics resta visibile', () => {
  const broken = runPipeline('ok', { diagnosticsIsDirectory: true });
  assert.notEqual(broken.diagnostics, '0');
  assert.equal(broken.codex, '1', 'un Codex riuscito senza stream non e\' un successo');
  assert.match(broken.stdout, /diagnostics stream could not be written/u);
});

test('classificatore auth: solo stderr di Codex con uscita non-zero', () => {
  assert.equal(runPipeline('auth').auth, 'true');
  assert.equal(runPipeline('auth-in-answer').auth, 'false', 'il testo della risposta non e\' un errore di auth');
  assert.equal(runPipeline('auth-warning-ok').auth, 'false', 'un run riuscito non e\' bloccato');
  assert.equal(runPipeline('fail').auth, 'false');
});

// ---------------------------------------------------------------------------
// Watchdog per caller
// ---------------------------------------------------------------------------

// Override espliciti: solo i caller batch che hanno misurato sessioni vicine
// o oltre il default. post-merge-followup: 1670s (35973121007) e 1803s,
// uccisa (36009410204).
const EXEC_TIMEOUT_OVERRIDES = { 'post-merge-followup.yml': '2520' };
// Setup Codex (Node, CLI, sandbox apt: ~105s misurati il 2026-09-24), kill
// grace di 30s e coda di finalize/cleanup.
const CODEX_SETUP_AND_TAIL_SECONDS = 300;

test('watchdog: default 1800 e solo secondi interi 60-7200', () => {
  assert.match(ACTION, /exec_timeout_seconds:\n\s+description: "[^"]+"\n\s+required: false\n\s+default: "1800"/u);
  assert.match(ACTION, /CODEX_EXEC_TIMEOUT_SECONDS: \$\{\{ inputs\.exec_timeout_seconds \}\}/u);
  const validation = segment(
    '        codex_exec_timeout_seconds="${CODEX_EXEC_TIMEOUT_SECONDS:-1800}"',
    '        codex_exec_kill_grace_seconds=30',
  );
  const validate = (value) => {
    const env = { PATH: '/usr/bin:/bin' };
    if (value !== undefined) env.CODEX_EXEC_TIMEOUT_SECONDS = value;
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${validation}\nprintf 'cap=%s\\n' "$codex_exec_timeout_seconds"`], {
      env,
      encoding: 'utf8',
    });
    return result.status === 0 ? result.stdout.trim().split('\n').pop() : `exit=${result.status}`;
  };
  assert.equal(validate(undefined), 'cap=1800');
  assert.equal(validate(''), 'cap=1800');
  assert.equal(validate('2520'), 'cap=2520');
  assert.equal(validate('60'), 'cap=60');
  assert.equal(validate('7200'), 'cap=7200');
  // 0 disattiverebbe GNU timeout: deve fallire, non ricadere sul default.
  for (const invalid of ['0', '59', '7201', '01800', '30m', ' 1800', '1800s', '-1']) {
    assert.equal(validate(invalid), 'exit=1', invalid);
  }
});

function codexCallerCaps(source) {
  const out = [];
  let job = null;
  let jobTimeout = null;
  let step = null;
  const flush = () => {
    if (!step) return;
    const body = step.join('\n');
    if (/^ {8}uses:\s*\.\/\.github\/actions\/claude-codex-fallback\s*$/mu.test(body)) {
      const stepTimeout = /^ {8}timeout-minutes:\s*(\d+)/mu.exec(body)?.[1];
      const override = /^ {10}exec_timeout_seconds:\s*'?(\d+)'?\s*$/mu.exec(body)?.[1];
      const caps = [stepTimeout, jobTimeout].filter(Boolean).map(Number);
      out.push({ job, override, effectiveSeconds: caps.length ? Math.min(...caps) * 60 : null });
    }
    step = null;
  };
  for (const line of source.split('\n')) {
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (jobMatch) {
      flush();
      job = jobMatch[1];
      jobTimeout = null;
      continue;
    }
    const jobTimeoutMatch = /^ {4}timeout-minutes:\s*(\d+)/u.exec(line);
    if (jobTimeoutMatch) {
      jobTimeout = jobTimeoutMatch[1];
      continue;
    }
    if (/^ {6}- /u.test(line)) {
      flush();
      step = [line];
    } else if (step) {
      step.push(line);
    }
  }
  flush();
  return out;
}

test('watchdog: override solo sui caller batch, sotto il tetto effettivo dello step', () => {
  const overrides = {};
  for (const name of fs.readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/u.test(file)).sort()) {
    for (const caller of codexCallerCaps(fs.readFileSync(path.join(WORKFLOW_DIR, name), 'utf8'))) {
      if (caller.override === undefined) continue;
      overrides[name] = caller.override;
      assert.ok(caller.effectiveSeconds, `${name}: serve un timeout-minutes`);
      assert.ok(
        Number(caller.override) + CODEX_SETUP_AND_TAIL_SECONDS <= caller.effectiveSeconds,
        `${name}: watchdog ${caller.override}s oltre il kill del runner (${caller.effectiveSeconds}s)`,
      );
    }
  }
  assert.deepEqual(overrides, EXEC_TIMEOUT_OVERRIDES);
});

// ---------------------------------------------------------------------------
// Alert "Codex auth down"
// ---------------------------------------------------------------------------

const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
  process.stdout.write(endpoint.includes('/comments') ? process.env.FAKE_GH_COMMENTS : process.env.FAKE_GH_ISSUES);
}
`;

function runStep(name, { issues = [], comments = [], workflow = 'post-merge-followup', digest = 'a'.repeat(64) } = {}) {
  const root = tempRoot('codex-auth-alert-');
  try {
    const fakeGh = path.join(root, 'gh');
    const log = path.join(root, 'gh.log');
    fs.writeFileSync(fakeGh, FAKE_GH, { mode: 0o755 });
    fs.writeFileSync(log, '');
    const result = spawnSync('/bin/bash', ['-c', stepRun(name).script], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        TRUSTED_GH: fakeGh,
        REPO: 'owner/repo',
        SERVER_URL: 'https://github.com',
        WORKFLOW_NAME: workflow,
        AUTH_DIGEST: digest,
        RUN_ID: '123',
        RUN_ATTEMPT: '2',
        FAKE_GH_LOG: log,
        FAKE_GH_ISSUES: JSON.stringify(issues),
        FAKE_GH_COMMENTS: JSON.stringify(comments),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((args) => args[0] === 'issue');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const marker = (fields) =>
  `<!-- CODEX_AUTH_BLOCKED_RUN: ${JSON.stringify({ version: 1, status: 'blocked', runId: 1, runAttempt: 1, ...fields })} -->`;

test('alert auth: step best-effort con GITHUB_TOKEN, titolo del sito, per ogni caller', () => {
  const raise = stepRun('Raise Codex authentication alert').block;
  assert.match(raise, /if: always\(\) && steps\.finalize\.outputs\.codex_auth_failure == 'true'\n/u,
    'senza monitor di recovery qui, l\'alert copre anche le PR');
  assert.match(raise, /continue-on-error: true/u);
  assert.match(raise, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.ok(raise.includes(`alert_title='${ALERT_TITLE}'`));
  const close = stepRun('Close recovered Codex authentication alert').block;
  assert.match(close, /if: always\(\) && steps\.codex\.outcome == 'success'\n/u);
  assert.match(close, /continue-on-error: true/u);
  assert.ok(close.includes(`alert_title='${ALERT_TITLE}'`));
  assert.match(ACTION, /CODEX_AUTH_FAILURE: \$\{\{ steps\.codex\.outputs\.codex_auth_failure \|\| steps\.codex_auth\.outputs\.codex_auth_failure \}\}/u);
  assert.match(ACTION, /printf 'codex_auth_digest=missing\\n'/u);
});

test('alert auth: apre l\'issue canonica col marker del run quando manca', () => {
  const pullRequestWithSameTitle = { number: 3, title: ALERT_TITLE, pull_request: {}, user: { login: 'github-actions[bot]' } };
  const [create, ...rest] = runStep('Raise Codex authentication alert', { issues: [pullRequestWithSameTitle] });
  assert.deepEqual(rest, []);
  assert.deepEqual(create.slice(0, 8), ['issue', 'create', '--repo', 'owner/repo', '--title', ALERT_TITLE, '--label', 'automation']);
  const body = create[create.indexOf('--body') + 1];
  assert.match(body, /Workflow: `post-merge-followup`/u);
  assert.match(body, /https:\/\/github\.com\/owner\/repo\/actions\/runs\/123/u);
  const json = /<!-- CODEX_AUTH_BLOCKED_RUN: (\{.*\}) -->/u.exec(body)?.[1];
  assert.deepEqual(JSON.parse(json || '{}'), {
    version: 1, status: 'blocked', workflow: 'post-merge-followup', runId: 123, runAttempt: 2, authDigest: 'a'.repeat(64),
  });
});

test('alert auth: una sola riga per credenziale e workflow', () => {
  const digest = 'a'.repeat(64);
  const alert = { number: 7, title: ALERT_TITLE, user: { login: 'github-actions[bot]' }, body: marker({ workflow: 'post-merge-followup', authDigest: digest }) };
  assert.deepEqual(runStep('Raise Codex authentication alert', { issues: [alert] }), []);
  const [comment, ...rest] = runStep('Raise Codex authentication alert', { issues: [alert], workflow: 'tests' });
  assert.deepEqual(rest, []);
  assert.deepEqual(comment.slice(0, 5), ['issue', 'comment', '7', '--repo', 'owner/repo']);
  assert.match(comment[comment.indexOf('--body') + 1], /"workflow":"tests"/u);
  const human = [{ user: { login: 'someone' }, body: marker({ workflow: 'tests', authDigest: digest }) }];
  assert.equal(runStep('Raise Codex authentication alert', { issues: [{ ...alert, body: '' }], comments: human, workflow: 'tests' }).length, 1,
    'un marker scritto da un umano non sopprime l\'alert');
});

test('alert auth: il primo run Codex che autentica chiude l\'alert aperto', () => {
  assert.deepEqual(runStep('Close recovered Codex authentication alert', { issues: [] }), []);
  const other = { number: 4, title: 'Codex auth down: something else' };
  assert.deepEqual(runStep('Close recovered Codex authentication alert', { issues: [other] }), []);
  const [close, ...rest] = runStep('Close recovered Codex authentication alert', {
    issues: [other, { number: 9, title: ALERT_TITLE }],
    workflow: 'issue-fix',
  });
  assert.deepEqual(rest, []);
  assert.deepEqual(close.slice(0, 7), ['issue', 'close', '9', '--repo', 'owner/repo', '--reason', 'completed']);
  assert.match(close[close.indexOf('--comment') + 1], /Codex authenticated again in `issue-fix`/u);
});
