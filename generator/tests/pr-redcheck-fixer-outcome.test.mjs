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

function stepBlockFrom(source, name) {
  const start = source.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step «${name}» non trovato`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
}

function stepBlock(name) {
  return stepBlockFrom(WORKFLOW, name);
}

const FINALIZE_NAME = 'Finalize redcheck PR + HEAD + failed check claim';
const HEAD_SHA_40 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHECK_FAILURE_KEY = 'tests (node --test)';

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

function runClassifier({
  baseBody,
  currentBody,
  baseBodySha = sha256(baseBody),
  baseCaptureOutcome = 'success',
  head = 'base-sha',
  remote = 'base-sha',
  startSha = 'base-sha',
  baseSha = 'base-sha',
  actionOutcome = 'success',
  fixRound = '',
  fixRoundMarker = 'REDCHECK_FIX_ROUND',
  commentsJson = '[]',
  claimToken = '',
  source = WORKFLOW,
} = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pr-redcheck-outcome-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const ghLog = path.join(temp, 'gh.log');
  const githubEnv = path.join(temp, 'github.env');
  writeFileSync(ghLog, '');
  writeFileSync(githubEnv, '');

  fakeExecutable(bin, 'git', String.raw`
case "$1 $2" in
  "rev-parse HEAD") printf '%s\n' "$FAKE_HEAD" ;;
  "rev-parse origin/"*) printf '%s\n' "$FAKE_REMOTE" ;;
  fetch*) exit 0 ;;
  *) exit 64 ;;
esac
`);
  fakeExecutable(bin, 'gh', String.raw`
echo "$*" >> "$GH_LOG"
if echo "$*" | grep -q -- '-X DELETE'; then exit 0; fi
if echo "$*" | grep -q 'pr comment'; then exit 0; fi
if echo "$*" | grep -q 'issues/.*/comments'; then
  if echo "$*" | grep -q -- '--jq'; then
    printf '0\n'
    exit 0
  fi
  if echo "$*" | grep -q -- '--slurp'; then
    printf '[%s]\n' "$FAKE_COMMENTS_JSON"
    exit 0
  fi
  printf '%s\n' "$FAKE_COMMENTS_JSON"
  exit 0
fi
printf '%s' "$FAKE_BODY"
`);

  try {
    const result = spawnSync('/bin/bash', ['-c', `export PATH="$TEST_BIN:$PATH"\n${runScript(stepBlockFrom(source, CLASSIFY_NAME))}`], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_BIN: bin,
        REPO: 'example/repo',
        GH_REPO: 'example/repo',
        PR_NUMBER: '7',
        HEAD_REF: 'fix/body-outcome',
        HEAD_SHA: HEAD_SHA_40,
        CHECK_FAILURE_KEY,
        START_SHA: startSha,
        BASE_SHA: baseSha,
        BASE_COMMENTS: '0',
        BASE_BODY_SHA: baseBodySha,
        BASE_CAPTURE_OUTCOME: baseCaptureOutcome,
        ACTION_OUTCOME: actionOutcome,
        FIX_ROUND: fixRound,
        FIX_ROUND_MARKER: fixRoundMarker,
        CLAIM_TOKEN: claimToken,
        GITHUB_ENV: githubEnv,
        GH_LOG: ghLog,
        FAKE_HEAD: head,
        FAKE_REMOTE: remote,
        FAKE_BODY: currentBody,
        FAKE_COMMENTS_JSON: commentsJson,
        RUNNER_TEMP: temp,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    result.githubEnv = readFileSync(githubEnv, 'utf8');
    result.ghLog = readFileSync(ghLog, 'utf8');
    return result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function activeClaimComment({ token = 'tok-1', state = 'active' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const event = {
    version: 1,
    token,
    key: `pr:7|head:${HEAD_SHA_40}|failure:${CHECK_FAILURE_KEY}`,
    prNumber: '7',
    headSha: HEAD_SHA_40,
    checkFailureKey: CHECK_FAILURE_KEY,
    state,
    issuedAt: now,
    expiresAt: now + 3600,
    runId: '1',
  };
  return {
    id: 99,
    body: `<!-- REDCHECK_FIX_CLAIM: ${JSON.stringify(event)} -->\n_claim_`,
  };
}

function runFinalize({ claimStatus = 'released', codexOutcome = 'failure', commentsJson }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pr-redcheck-finalize-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const ghLog = path.join(temp, 'gh.log');
  writeFileSync(ghLog, '');

  fakeExecutable(bin, 'gh', String.raw`
echo "$*" >> "$GH_LOG"
if echo "$*" | grep -q 'pr comment'; then exit 0; fi
if echo "$*" | grep -q -- '--slurp'; then
  printf '[%s]\n' "$FAKE_COMMENTS_JSON"
  exit 0
fi
if echo "$*" | grep -q 'issues/.*/comments'; then
  printf '%s\n' "$FAKE_COMMENTS_JSON"
  exit 0
fi
exit 64
`);

  try {
    const result = spawnSync('/bin/bash', ['-c', `export PATH="$TEST_BIN:$PATH"\n${runScript(stepBlock(FINALIZE_NAME))}`], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_BIN: bin,
        GH_REPO: 'example/repo',
        CLAIM_ACTION: 'finalize',
        CLAIM_TOKEN: 'tok-1',
        CLAIM_STATUS: claimStatus,
        PR_NUMBER: '7',
        HEAD_SHA: HEAD_SHA_40,
        CHECK_FAILURE_KEY,
        GUARD_PROCEED: 'true',
        CODEX_OUTCOME: codexOutcome,
        GH_LOG: ghLog,
        FAKE_COMMENTS_JSON: commentsJson,
        GITHUB_OUTPUT: path.join(temp, 'github-output'),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    result.ghLog = readFileSync(ghLog, 'utf8');
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
  *issues/*/comments*) printf '0\n' ;;
  *pulls*)
    if [ "$FAKE_EMPTY_RESPONSE" = "1" ]; then exit 0; fi
    printf '%s\n' "$FAKE_BODY" ;;
  *) exit 64 ;;
esac
`);

  try {
    return spawnSync('/bin/bash', ['-c', `export PATH="$TEST_BIN:$PATH"\n${runScript(stepBlock('Record base SHA (pre-Codex)'))}`], {
      cwd: temp,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_BIN: bin,
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
  const base = stepBlock('Record base SHA (pre-Codex)');
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
  assert.match(classify, /if \[ ! -s "\$body_file" \]; then[\s\S]{0,240}?exit 1/, 'la lettura finale deve rifiutare una risposta API a zero byte');
  assert.match(classify, /s\/\\r\$\/[\s\S]*s\/\[\[:space:\]\]\+\$\//, 'la lettura finale deve canonizzare CR e spazio in coda');
  assert.match(classify, /if \[ "\$\{BASE_CAPTURE_OUTCOME:-\}" != "success" \][\s\S]{0,240}?exit 1/,
    'la baseline deve essere ancorata al guard reale e restare bounded');

  const steps = [...WORKFLOW.matchAll(/^      - name: ([^\n]*)/gm)].map((m) => m[1]);
  const classifyAt = steps.lastIndexOf(CLASSIFY_NAME);
  const finalizeAt = steps.lastIndexOf(FINALIZE_NAME);
  assert.ok(classifyAt >= 0 && finalizeAt >= 0 && classifyAt < finalizeAt,
    'il classify deve precedere il finalize così CLAIM_STATUS=released è visibile');
  assert.match(stepBlock(FINALIZE_NAME), /if \[ -n "\$\{CLAIM_STATUS:-\}" \]/,
    'il finalize non deve sovrascrivere un CLAIM_STATUS già deciso dal classify');
  const align = stepBlock('Align review workflows (merge origin/main, anti-401 drift)');
  const startAt = align.indexOf('start_sha=$(git rev-parse HEAD)');
  const mergeAt = align.search(/git merge /);
  assert.ok(startAt >= 0 && mergeAt >= 0 && startAt < mergeAt,
    'START_SHA deve essere lo SHA remoto della PR prima del merge origin/main');
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

test('i fixer di PR serializzano la PR senza sfrattare la pending gemella', () => {
  const groupOf = (source) => source.match(/^  group: (.+)$/m)?.[1];
  const redcheckGroup = groupOf(WORKFLOW);
  const redflagGroup = groupOf(REDFLAG_WORKFLOW);
  assert.notEqual(redcheckGroup, redflagGroup,
    'i workflow devono evitare una coda condivisa che sfratta la pending gemella');
  assert.match(redcheckGroup || '', /^redcheck-fix-/);
  assert.match(
    redflagGroup || '',
    /^redflag-fix-pr-\$\{\{ inputs\.pr \|\| github\.event\.pull_request\.number \|\| 'unknown' \}\}$/,
    'il fixer deve usare il numero PR anche su workflow_dispatch manuale',
  );
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

test('un push esterno supersede il round e rilascia il claim prima del ramo di errore', () => {
  const baseBody = '## Implementato\n\n- body iniziale';
  const roundComment = {
    id: 42,
    body: '<!-- REDCHECK_FIX_ROUND: 1 -->\n_❌-check-fixer round 1/2 avviato (auto)._',
  };
  const result = runClassifier({
    baseBody,
    currentBody: baseBody,
    startSha: 'pr-sha',
    baseSha: 'merged-sha',
    head: 'merged-sha',
    remote: 'external-sha',
    actionOutcome: 'failure',
    fixRound: '1',
    commentsJson: JSON.stringify([roundComment, activeClaimComment()]),
    claimToken: 'tok-1',
  });
  assert.equal(
    result.status,
    0,
    `un branch avanzato da un altro writer non deve diventare un falso rosso:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  assert.match(result.stdout, /run SUPERSEDED/);
  assert.match(result.githubEnv, /CLAIM_STATUS=released/);
  assert.match(result.stdout, /rimborsato/);
  assert.match(result.ghLog, /-X DELETE .*issues\/comments\/42/);
  assert.match(result.ghLog, /REDCHECK_FIX_REFUNDED: 1/);
});

test('un branch solo indietro rispetto a main non è SUPERSEDED', () => {
  const baseBody = '## Implementato\n\n- body iniziale';
  const result = runClassifier({
    baseBody,
    currentBody: baseBody,
    startSha: 'pr-sha',
    baseSha: 'merged-sha',
    head: 'merged-sha',
    remote: 'pr-sha',
    actionOutcome: 'failure',
    fixRound: '1',
    commentsJson: JSON.stringify([{
      id: 42,
      body: '<!-- REDCHECK_FIX_ROUND: 1 -->\n_round_',
    }]),
  });
  assert.equal(
    result.status,
    1,
    `un branch solo dietro main è non-progresso, non una race esterna:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  assert.doesNotMatch(result.stdout, /run SUPERSEDED/);
  assert.equal(result.githubEnv, '');
  assert.doesNotMatch(result.ghLog, /-X DELETE/);
});

test('il finalize ereditato dal classify lascia il claim released anche se Codex è failure', () => {
  const commentsJson = JSON.stringify([activeClaimComment()]);
  const result = runFinalize({
    claimStatus: 'released',
    codexOutcome: 'failure',
    commentsJson,
  });
  assert.equal(
    result.status,
    0,
    `il finalize deve accettare released dal classify:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  assert.match(result.stdout, /CLAIM_STATUS ereditato dal classify \(released\)/);
  assert.match(result.ghLog, /"state":"released"/);
});

test('redflag e redcheck hanno la stessa guardia per una race esterna', () => {
  for (const [name, source] of [['redflag', REDFLAG_WORKFLOW], ['redcheck', WORKFLOW]]) {
    const classify = source.slice(source.indexOf(CLASSIFY_NAME));
    assert.match(classify, /CLAIM_STATUS=released/,
      `${name}: il claim deve essere rilasciato sul superseded`);
    assert.match(classify, /\[ "\$REMOTE_SHA" != "\$START_SHA" \]/,
      `${name}: la guardia deve confrontare il remote con lo SHA pre-merge`);
    assert.match(classify, /\[ "\$REMOTE_SHA" != "\$HEAD_NOW" \]/,
      `${name}: la guardia deve escludere il push proprio`);
    assert.match(classify, /\$\{FIX_ROUND_MARKER%_ROUND\}_REFUNDED/,
      `${name}: il ramo superseded deve rimborsare il marker di round`);
    const supersededAt = classify.indexOf('run SUPERSEDED');
    const failureAt = classify.indexOf('if [ "$ACTION_OUTCOME"');
    assert.ok(supersededAt >= 0 && failureAt >= 0 && supersededAt < failureAt,
      `${name}: la race deve essere classificata prima del fallimento`);
  }
});

test('redflag rimborsa il marker di round su SUPERSEDED', () => {
  const baseBody = '## Implementato\n\n- body iniziale';
  const result = runClassifier({
    source: REDFLAG_WORKFLOW,
    baseBody,
    currentBody: baseBody,
    startSha: 'pr-sha',
    baseSha: 'merged-sha',
    head: 'merged-sha',
    remote: 'external-sha',
    actionOutcome: 'failure',
    fixRound: '2',
    fixRoundMarker: 'REDFLAG_FIX_ROUND',
    commentsJson: JSON.stringify([{
      id: 77,
      body: '<!-- REDFLAG_FIX_ROUND: 2 -->\n_🔴-fixer round 2/2 avviato (auto)._',
    }]),
  });
  assert.equal(
    result.status,
    0,
    `redflag superseded deve uscire verde:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  assert.match(result.stdout, /run SUPERSEDED/);
  assert.match(result.stdout, /rimborsato/);
  assert.match(result.ghLog, /-X DELETE .*issues\/comments\/77/);
  assert.match(result.ghLog, /REDFLAG_FIX_REFUNDED: 2/);
});
