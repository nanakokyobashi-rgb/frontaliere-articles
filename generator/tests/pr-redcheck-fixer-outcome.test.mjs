/**
 * Contratto del verdetto body-only di `pr-redcheck-fixer.yml`.
 *
 * Il test esegue il vero script dello step finale con due risposte API
 * controllate: un body diverso deve essere progresso, lo stesso body deve
 * restare non-progresso. Il secondo caso impedisce che un `gh pr edit` no-op
 * trasformi un job rosso in un falso verde.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/pr-redcheck-fixer.yml'), 'utf8');
const REDFLAG_WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');
const CLASSIFY_NAME = 'Classify outcome (work-done, not CLI exit)';

function stepBlock(name) {
  const start = WORKFLOW.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step «${name}» non trovato`);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
}

function runScript(step) {
  const match = /\n {8}run: \|\n([\s\S]*)$/.exec(step);
  assert.ok(match, 'lo step non contiene un blocco `run: |`');
  return match[1]
    .split('\n')
    .map((line) => line.startsWith(' '.repeat(10)) ? line.slice(10) : line)
    .join('\n');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function fakeExecutable(dir, name, source) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${source}\n`);
  chmodSync(file, 0o755);
}

function runClassifier({ baseBody, currentBody, baseBodySha = sha256(baseBody), baseCaptureOutcome = 'success' }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pr-redcheck-outcome-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);

  fakeExecutable(bin, 'git', String.raw`
case "$1 $2" in
  "rev-parse HEAD") printf '%s\n' "$FAKE_HEAD" ;;
  "rev-parse origin/"*) printf '%s\n' "$FAKE_REMOTE" ;;
  fetch*) exit 0 ;;
  *) exit 64 ;;
esac
`);
  fakeExecutable(bin, 'gh', String.raw`
case "$*" in
  */issues/*/comments*) printf '0\n' ;;
  *) printf '%s' "$FAKE_BODY" ;;
esac
`);

  try {
    const result = spawnSync('/bin/bash', ['-c', runScript(stepBlock(CLASSIFY_NAME))], {
      cwd: temp,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO: 'example/repo',
        PR_NUMBER: '7',
        HEAD_REF: 'fix/body-outcome',
        BASE_SHA: 'base-sha',
        BASE_COMMENTS: '0',
        BASE_BODY_SHA: baseBodySha,
        BASE_CAPTURE_OUTCOME: baseCaptureOutcome,
        CLAUDE_OUTCOME: 'success',
        FAKE_HEAD: 'base-sha',
        FAKE_REMOTE: 'base-sha',
        FAKE_BODY: currentBody,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runBaseCapture({ body, emptyResponse = false }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pr-redcheck-base-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const output = path.join(temp, 'github-output');

  fakeExecutable(bin, 'git', String.raw`
case "$1 $2" in
  "rev-parse HEAD") printf '%s\n' 'base-sha' ;;
  *) exit 64 ;;
esac
`);
  fakeExecutable(bin, 'gh', String.raw`
case "$*" in
  */issues/*/comments*) printf '0\n' ;;
  */pulls/*)
    if [ "$FAKE_EMPTY_RESPONSE" = "1" ]; then exit 0; fi
    printf '%s\n' "$FAKE_BODY" ;;
  *) exit 64 ;;
esac
`);

  try {
    return spawnSync('/bin/bash', ['-c', runScript(stepBlock('Record base SHA (pre-Claude)'))], {
      cwd: temp,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO: 'example/repo',
        PR_NUMBER: '7',
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
        FAKE_BODY: body,
        FAKE_EMPTY_RESPONSE: emptyResponse ? '1' : '0',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('il digest del body è acquisito prima e classificato fail-closed', () => {
  const base = stepBlock('Record base SHA (pre-Claude)');
  const classify = stepBlock(CLASSIFY_NAME);

  assert.match(base, /set -uo pipefail/, 'la lettura del body deve propagare gli errori della pipeline');
  assert.match(base, /echo "body_sha=\$body_sha"/, 'la baseline deve salvare il digest del body della PR');
  assert.match(base, /gh api[\s\S]*> "\$body_file"/, 'lo status di gh deve essere osservabile prima del digest');
  assert.match(base, /if \[ ! -s "\$body_file" \]; then[\s\S]{0,220}?exit 1/, 'la baseline deve rifiutare una risposta API a zero byte');
  assert.match(base, /s\/\\r\$\/[\s\S]*s\/\[\[:space:\]\]\+\$\//, 'la baseline deve canonizzare CR e spazio in coda');
  assert.match(classify, /BASE_BODY_SHA: \$\{\{ steps\.base\.outputs\.body_sha \}\}/);
  assert.match(classify, /BASE_CAPTURE_OUTCOME: \$\{\{ steps\.base\.outcome \}\}/);

  const currentBodyAt = classify.indexOf('if ! now_body_sha=');
  const commentsAt = classify.indexOf('NOW_COMMENTS=');
  assert.ok(currentBodyAt !== -1 && commentsAt !== -1 && currentBodyAt < commentsAt,
    'il body deve essere confrontato prima del fallback sui commenti');
  assert.match(classify, /if \[ "\$now_body_sha" = "\$empty_body_sha" \]; then[\s\S]{0,240}?exit 1/, 'la lettura finale deve rifiutare il digest vuoto emesso da gh --jq');
  assert.match(classify, /empty_body_sha=\$\(printf '\\n'/, 'il digest vuoto finale deve riflettere il newline emesso da gh --jq');
  assert.match(classify, /s\/\\r\$\/[\s\S]*s\/\[\[:space:\]\]\+\$\//, 'la lettura finale deve canonizzare CR e spazio in coda');
  assert.match(classify, /if \[ "\$\{BASE_CAPTURE_OUTCOME:-\}" != "success" \][\s\S]{0,240}?exit 1/,
    'la baseline deve essere ancorata al guard reale e restare bounded');

  const steps = [...WORKFLOW.matchAll(/^      - name: [^\n]*/gm)];
  assert.equal(steps.at(-1)?.[0].trimEnd(), `      - name: ${CLASSIFY_NAME}`,
    'il verdetto deve restare nell\'ultimo step');
});

test('la cattura baseline accetta un body PR vuoto quando gh emette il newline JSON', () => {
  const result = runBaseCapture({ body: '' });
  assert.equal(result.status, 0,
    `un body PR vuoto e' riparabile e non deve bloccare Claude:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
});

test('la cattura baseline respinge una risposta API a zero byte anche con gh exit 0', () => {
  const result = runBaseCapture({ body: '', emptyResponse: true });
  assert.equal(result.status, 1,
    `una risposta API senza byte non può diventare una baseline valida:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
});

test('la baseline fallita o il digest invalido bloccano prima del confronto body', () => {
  const baseBody = '## Implementato\n\n- body iniziale';
  const changedBody = `${baseBody}\n- correzione sostanziale`;

  const failedCapture = runClassifier({
    baseBody,
    currentBody: changedBody,
    baseCaptureOutcome: 'failure',
  });
  assert.equal(failedCapture.status, 1,
    `una baseline fallita non può diventare progresso body-only:\nstdout=${failedCapture.stdout}\nstderr=${failedCapture.stderr}`);

  const invalidDigest = runClassifier({
    baseBody,
    currentBody: changedBody,
    baseBodySha: 'not-a-sha',
  });
  assert.equal(invalidDigest.status, 1,
    `un digest invalido non può diventare progresso body-only:\nstdout=${invalidDigest.stdout}\nstderr=${invalidDigest.stderr}`);
});

test('i fixer di PR serializzano il branch senza sfrattare la pending gemella', () => {
  const groupOf = (source) => source.match(/^  group: (.+)$/m)?.[1];
  const redcheckGroup = groupOf(WORKFLOW);
  const redflagGroup = groupOf(REDFLAG_WORKFLOW);
  assert.notEqual(redcheckGroup, redflagGroup,
    'i workflow devono evitare una coda condivisa che sfratta la pending gemella');
  assert.match(redcheckGroup || '', /^redcheck-fix-/);
  assert.match(redflagGroup || '', /^redflag-fix-\$\{\{ github\.event\.pull_request\.head\.ref \}\}$/);
  assert.match(WORKFLOW, /busy=[\s\S]*--workflow=pr-redflag-fixer\.yml/,
    'redcheck deve riconoscere un redflag gia\u0027 attivo prima del push');
  assert.match(REDFLAG_WORKFLOW, /while :[\s\S]*--workflow=pr-redcheck-fixer\.yml[\s\S]*sleep 10/,
    'redflag deve attendere il redcheck attivo invece di modificare il branch in parallelo');
});

test('body cambiato è progresso, body identico è non-progresso', () => {
  const baseBody = '## Implementato\n\n- body iniziale';

  const changed = runClassifier({
    baseBody,
    currentBody: `${baseBody}\n- correzione sostanziale`,
  });
  assert.equal(
    changed.status,
    0,
    `body cambiato deve essere progresso:\nstdout=${changed.stdout}\nstderr=${changed.stderr}`,
  );

  const identical = runClassifier({ baseBody, currentBody: baseBody });
  assert.equal(
    identical.status,
    1,
    `body identico deve restare non-progresso:\nstdout=${identical.stdout}\nstderr=${identical.stderr}`,
  );
});
