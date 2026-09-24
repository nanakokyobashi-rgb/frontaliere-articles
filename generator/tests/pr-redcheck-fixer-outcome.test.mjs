/**
 * Contratto del verdetto body-only di `pr-redcheck-fixer.yml`.
 *
 * Il test esegue il vero script dello step finale con due risposte API
 * controllate: un body diverso deve essere progresso, lo stesso body deve
 * restare non-progresso. Il secondo caso impedisce che un `gh pr edit` no-op
 * trasformi un job rosso in un falso verde.
 * Copre anche il guard deterministico del cap round, distinguendo una
 * snapshot stantia da uno stato malformato.
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

function roundMarkerComment({ marker = 'REDCHECK_FIX_ROUND', round = 1, id = 42, body }) {
  const bodyRevision = sha256(`${body}\n`);
  return {
    id,
    user: { login: 'fixture-bot' },
    body: `<!-- ${marker}: ${round} -->\n<!-- ${marker}_HEAD: ${HEAD_SHA_40} -->\n<!-- ${marker}_BODY: ${bodyRevision} -->\n_round ${round}/2 avviato (auto)._`,
  };
}

function fakeExecutable(dir, name, source) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${source}\n`);
  chmodSync(file, 0o755);
}

function runRoundGuard({ roundState, expectedHead = HEAD_SHA_40, expectedBodyRevision }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pr-redcheck-round-guard-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const githubOutput = path.join(temp, 'github-output');
  writeFileSync(githubOutput, '');

  fakeExecutable(bin, 'node', String.raw`
printf '%s\n' "$FAKE_ROUND_STATE"
`);
  fakeExecutable(bin, 'gh', String.raw`
case "$*" in
  *issues/*/comments*) printf '%s\n' '[[{"body":""}]]' ;;
  *workflow\ run*) exit 0 ;;
  *) exit 64 ;;
esac
`);

  const script = runScript(stepBlock('Round cap + capability guard + tier'))
    .replaceAll('${{ steps.trusted_marker.outputs.available }}', 'true')
    .replaceAll('${{ steps.trusted_marker.outputs.path }}', '$TRUSTED_MARKER')
    .replaceAll('${{ needs.preflight.outputs.head_sha }}', '$EXPECTED_HEAD');
  try {
    const result = spawnSync('/bin/bash', ['-c', `export PATH="$TEST_BIN:$PATH"\n${script}`], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_BIN: bin,
        GITHUB_PAT_NANAKO: 'runtime-token',
        GH_TOKEN: 'runtime-token',
        REPO: 'example/repo',
        PR_NUMBER: '7',
        HEAD_REF: 'fix/body-outcome',
        EXPECTED_HEAD: expectedHead,
        EXPECTED_BODY_REVISION: expectedBodyRevision,
        TRUSTED_MARKER: path.join(temp, 'trusted-marker.mjs'),
        FAKE_ROUND_STATE: JSON.stringify(roundState),
        GITHUB_OUTPUT: githubOutput,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    result.githubOutput = readFileSync(githubOutput, 'utf8');
    return result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('il guard tratta un cambio HEAD come no-op e un body-only come retry concreto', () => {
  const body = '## Implementato\n\n- snapshot';
  const bodyRevision = sha256(`${body}\n`);
  const headStale = runRoundGuard({
    roundState: { headSha: 'b'.repeat(40), bodyRevision, round: 0 },
    expectedBodyRevision: bodyRevision,
  });
  assert.equal(headStale.status, 0,
    `snapshot HEAD stantia non deve rendere rosso il job:\nstdout=${headStale.stdout}\nstderr=${headStale.stderr}`);
  assert.match(headStale.stdout, /Snapshot PR HEAD cambiato dopo il preflight/);
  assert.match(headStale.githubOutput, /proceed=false/);
  assert.match(headStale.githubOutput, /retryable=false/);

  const bodyStale = runRoundGuard({
    roundState: { headSha: HEAD_SHA_40, bodyRevision: 'c'.repeat(64), round: 0 },
    expectedBodyRevision: bodyRevision,
  });
  assert.equal(bodyStale.status, 0,
    `snapshot body-only deve dispatchare un retry concreto:\nstdout=${bodyStale.stdout}\nstderr=${bodyStale.stderr}`);
  assert.match(bodyStale.stdout, /riavvio concreto di pr-redcheck-fixer/);
  assert.match(bodyStale.githubOutput, /proceed=false/);
  assert.match(bodyStale.githubOutput, /retryable=true/);
  assert.match(bodyStale.githubOutput, /retry_dispatched=true/);
});

test('il guard resta fail-closed su uno stato round o SHA atteso malformato', () => {
  const body = '## Implementato\n\n- snapshot';
  const bodyRevision = sha256(`${body}\n`);
  const scenarios = [
    {
      roundState: { headSha: HEAD_SHA_40, bodyRevision, round: 'not-a-number' },
      expectedHead: HEAD_SHA_40,
      expectedBodyRevision: bodyRevision,
    },
    {
      roundState: { headSha: HEAD_SHA_40, bodyRevision, round: 0 },
      expectedHead: '',
      expectedBodyRevision: bodyRevision,
    },
    {
      roundState: { headSha: HEAD_SHA_40, bodyRevision, round: 0 },
      expectedHead: 'not-a-sha',
      expectedBodyRevision: bodyRevision,
    },
    {
      roundState: { headSha: HEAD_SHA_40, bodyRevision, round: 0 },
      expectedHead: HEAD_SHA_40,
      expectedBodyRevision: '',
    },
    {
      roundState: { headSha: HEAD_SHA_40, bodyRevision, round: 0 },
      expectedHead: HEAD_SHA_40,
      expectedBodyRevision: 'not-a-sha',
    },
  ];

  for (const scenario of scenarios) {
    const result = runRoundGuard(scenario);
    assert.equal(result.status, 1,
      `stato round/SHA malformato non deve autorizzare Claude:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /Round REDCHECK_FIX_ROUND malformato/);
    assert.match(result.githubOutput, /proceed=false/);
    assert.match(result.githubOutput, /retryable=true/);
  }
});

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
  markerCommentId = '',
  commentsJson = '[]',
  refundCommentStatus = 0,
  claimToken = '',
  source = WORKFLOW,
  fetchStatuses = '',
  fetchedSequence = '',
  rereadSequence = '',
  lsRemoteStatuses = '',
} = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pr-redcheck-outcome-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const ghLog = path.join(temp, 'gh.log');
  const githubEnv = path.join(temp, 'github.env');
  const gitState = path.join(temp, 'git-state');
  mkdirSync(gitState);
  const sleepLog = path.join(temp, 'sleep.log');
  writeFileSync(sleepLog, '');
  const timeoutLog = path.join(temp, 'timeout.log');
  writeFileSync(timeoutLog, '');
  const trustedMarkerHelper = path.join(temp, 'trusted-marker.mjs');
  writeFileSync(ghLog, '');
  writeFileSync(githubEnv, '');
  writeFileSync(trustedMarkerHelper, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const idAt = args.indexOf('--comment-id');
const id = idAt >= 0 ? args[idAt + 1] : '';
if (!id || !args.includes('--delete-verified')) process.exit(2);
const result = spawnSync('gh', ['api', '--method', 'DELETE', \`repos/\${process.env.REPO}/issues/comments/\${id}\`], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);

  // Fake git a sequenze: ogni tentativo di fetch/lettura consuma il valore
  // successivo di FAKE_FETCH_STATUSES / FAKE_FETCHED / FAKE_REREAD (spazi come
  // separatore; vuoto = exit 0 / FAKE_REMOTE). Il ref remote-tracking resta
  // leggibile anche dopo un fetch fallito: e' la fotografia stantia che il
  // classificatore NON deve usare (#1763).
  fakeExecutable(bin, 'git', String.raw`
next_value() {
  n=$(cat "$FAKE_GIT_STATE/$1" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$FAKE_GIT_STATE/$1"
  printf '%s\n' $2 | sed -n "$n p"
}
case "$1 $2" in
  "rev-parse HEAD") printf '%s\n' "$FAKE_HEAD" ;;
  "rev-parse origin/"*) printf '%s\n' "$FAKE_REMOTE" ;;
  "rev-parse --verify")
    v=$(next_value fetched "$FAKE_FETCHED")
    [ -n "$v" ] || v="$FAKE_REMOTE"
    printf '%s\n' "$v" ;;
  "ls-remote "*)
    v=$(next_value reread "$FAKE_REREAD")
    [ -n "$v" ] || v="$FAKE_REMOTE"
    printf '%s\trefs/heads/%s\n' "$v" "$HEAD_REF"
    st=$(next_value ls-remote "$FAKE_LSREMOTE_STATUSES")
    [ -n "$st" ] || st=0
    exit "$st" ;;
  fetch*)
    echo fetch >> "$FAKE_GIT_STATE/fetch.log"
    st=$(next_value fetch "$FAKE_FETCH_STATUSES")
    [ -n "$st" ] || st=0
    exit "$st" ;;
  *) exit 64 ;;
esac
`);
  fakeExecutable(bin, 'sleep', String.raw`echo "$1" >> "$SLEEP_LOG"`);
  // timeout deterministico: registra il limite e il sottocomando, poi lo esegue.
  fakeExecutable(bin, 'timeout', String.raw`
echo "$1 $2 $3" >> "$TIMEOUT_LOG"
shift
exec "$@"
`);
fakeExecutable(bin, 'gh', String.raw`
echo "$*" >> "$GH_LOG"
if echo "$*" | grep -q -- '-X DELETE'; then exit 0; fi
if echo "$*" | grep -q 'api user'; then printf '{"login":"fixture-bot"}\n'; exit 0; fi
if echo "$*" | grep -q 'pr comment'; then exit "$REFUND_COMMENT_STATUS"; fi
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
        MARKER_COMMENT_ID: markerCommentId,
        MARKER_HEAD: HEAD_SHA_40,
        MARKER_BODY_REVISION: sha256(`${baseBody}\n`),
        TRUSTED_MARKER_HELPER: trustedMarkerHelper,
        CLAIM_TOKEN: claimToken,
        GITHUB_ENV: githubEnv,
        GH_LOG: ghLog,
        FAKE_HEAD: head,
        FAKE_REMOTE: remote,
        FAKE_GIT_STATE: gitState,
        FAKE_FETCH_STATUSES: fetchStatuses,
        FAKE_FETCHED: fetchedSequence,
        FAKE_REREAD: rereadSequence,
        FAKE_LSREMOTE_STATUSES: lsRemoteStatuses,
        SLEEP_LOG: sleepLog,
        TIMEOUT_LOG: timeoutLog,
        FAKE_BODY: currentBody,
        FAKE_COMMENTS_JSON: commentsJson,
        REFUND_COMMENT_STATUS: String(refundCommentStatus),
        RUNNER_TEMP: temp,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    result.githubEnv = readFileSync(githubEnv, 'utf8');
    result.ghLog = readFileSync(ghLog, 'utf8');
    result.sleepLog = readFileSync(sleepLog, 'utf8');
    result.timeoutLog = readFileSync(timeoutLog, 'utf8');
    const fetchLog = path.join(gitState, 'fetch.log');
    result.fetchCount = readFileSync(fetchLog, { encoding: 'utf8', flag: 'a+' })
      .split('\n').filter(Boolean).length;
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
  assert.match(base, /sha256sum "\$body_file"/, 'la baseline deve hashare la fence jq senza normalizzarla');
  assert.doesNotMatch(base, /s\/\\r\$\/[\s\S]*s\/\[\[:space:\]\]\+\$\//, 'la baseline non deve alterare i byte del body');
  assert.match(classify, /BASE_BODY_SHA: \$\{\{ steps\.base\.outputs\.body_sha \}\}/);
  assert.match(classify, /BASE_CAPTURE_OUTCOME: \$\{\{ steps\.base\.outcome \}\}/);

  const currentBodyAt = classify.indexOf('if ! now_body_sha=');
  const commentsAt = classify.indexOf('NOW_COMMENTS=');
  assert.ok(currentBodyAt !== -1 && commentsAt !== -1 && currentBodyAt < commentsAt,
    'il body deve essere confrontato prima del fallback sui commenti');
  assert.match(classify, /if \[ ! -s "\$body_file" \]; then[\s\S]{0,240}?exit 1/, 'la lettura finale deve rifiutare una risposta API a zero byte');
  assert.match(classify, /sha256sum "\$body_file"/, 'la lettura finale deve hashare la fence jq senza normalizzarla');
  assert.doesNotMatch(classify, /s\/\\r\$\/[\s\S]*s\/\[\[:space:\]\]\+\$\//, 'la lettura finale non deve alterare i byte del body');
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
    WORKFLOW,
    /workflow_dispatch:\n\s+inputs:\n\s+pr:[\s\S]*?\n\s+head_ref:\n\s+description:/,
    'il redispatch deve ricevere il branch oltre al numero PR',
  );
  assert.match(
    WORKFLOW,
    /group: redcheck-fix-\$\{\{ github\.event\.pull_request\.head\.ref \|\| github\.event\.workflow_run\.head_branch \|\| github\.event\.inputs\.head_ref \}\}/,
    'workflow_run e workflow_dispatch devono condividere la chiave basata sul branch',
  );
  assert.match(
    WORKFLOW,
    /gh workflow run pr-redcheck-fixer\.yml[\s\S]*--field "pr=\$PR_NUMBER" \\\n\s+--field "head_ref=\$HEAD_REF"/,
    'il retry body-only deve passare lo stesso branch della run originaria',
  );
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

test('la finalizzazione claim verifica errore e stato strutturati', () => {
  const finalize = stepBlock(FINALIZE_NAME);
  assert.match(finalize, /claim_error=false/,
    'un exit 0 del callee non basta: claim_error deve essere verificato');
  assert.match(finalize, /claim_state=\$\{CLAIM_STATUS\}/,
    'la finalizzazione deve provare lo stato richiesto dal cleanup');
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

// Il SUPERSEDED di redcheck (claim released, DELETE del marker, handle
// `REDCHECK_FIX_REFUNDED`, ordine tentativo → DELETE → handle, rosso su un
// rimborso non scrivibile) gira con l'helper vero contro un `gh` con stato in
// `redcheck-superseded-refund-idempotency.test.mjs` (#9617): il fake helper
// stateless qui sotto non puo' provare l'idempotenza del rimborso.

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
    commentsJson: JSON.stringify([roundMarkerComment({ body: baseBody })]),
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

// #1763: la head remota letta dal classificatore deve essere verificata.
// Scenario base di una race esterna (START_SHA=pr-sha, remote=external-sha):
// con una head verificata e' SUPERSEDED + rimborso; con una head NON
// verificata deve diventare un errore esplicito, senza scrivere stato.
function supersedeScenario(source, overrides = {}) {
  const baseBody = '## Implementato\n\n- body iniziale';
  const marker = source === REDFLAG_WORKFLOW ? 'REDFLAG_FIX_ROUND' : 'REDCHECK_FIX_ROUND';
  return runClassifier({
    source,
    baseBody,
    currentBody: baseBody,
    startSha: 'pr-sha',
    baseSha: 'merged-sha',
    head: 'merged-sha',
    remote: 'external-sha',
    actionOutcome: 'failure',
    fixRound: '1',
    fixRoundMarker: marker,
    markerCommentId: '42',
    commentsJson: JSON.stringify([
      roundMarkerComment({ marker, body: baseBody }),
      activeClaimComment(),
      activeClaimComment({ state: 'released' }),
    ]),
    claimToken: source === REDFLAG_WORKFLOW ? '' : 'tok-1',
    ...overrides,
  });
}

function assertFailClosed(name, result) {
  assert.equal(result.status, 1,
    `${name}: head remota non verificata deve dare job ROSSO:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /::error::REMOTE_HEAD_UNVERIFIED/, `${name}: errore esplicito atteso`);
  assert.doesNotMatch(result.stdout, /run SUPERSEDED/, `${name}: nessun SUPERSEDED spurio`);
  assert.doesNotMatch(result.stdout, /round SUCCESS/, `${name}: nessun SUCCESS su head stantia`);
  // L'esito transitorio arriva al finalize: il claim resta retryable invece
  // di essere ricostruito come terminale dall'outcome di Codex.
  assert.equal(result.githubEnv, 'CLAIM_STATUS=failed-transient\n',
    `${name}: unico stato esportato = failed-transient (mai released)`);
  assert.doesNotMatch(result.ghLog, /pr comment|DELETE|_REFUND/,
    `${name}: nessun marker terminale/rimborso, nessuna DELETE del marker di round`);
  assert.equal(result.fetchCount, 3, `${name}: retry bounded a 3 tentativi`);
  assert.deepEqual(result.sleepLog.split('\n').filter(Boolean), ['5', '10'],
    `${name}: backoff crescente fra i tentativi`);
}

for (const [name, source] of [['redcheck', WORKFLOW], ['redflag', REDFLAG_WORKFLOW]]) {
  test(`${name}: fetch fallito non classifica sulla ref remote-tracking stantia`, () => {
    // La ref stantia (external-sha) direbbe SUPERSEDED: il fetch fallito deve
    // impedirne l'uso.
    assertFailClosed(name, supersedeScenario(source, { fetchStatuses: '128 128 128' }));
    // Stessa cosa per il ramo SUCCESS: una ref stantia uguale a HEAD_NOW non
    // prova che il push sia atterrato.
    assertFailClosed(`${name} success-branch`, supersedeScenario(source, {
      remote: 'merged-sha',
      fetchStatuses: '1 1 1',
    }));
  });

  test(`${name}: head cambiata fra fetch e rilettura non produce SUPERSEDED`, () => {
    assertFailClosed(name, supersedeScenario(source, {
      fetchedSequence: 'external-1 external-2 external-3',
      rereadSequence: 'external-2 external-3 external-4',
    }));
  });

  test(`${name}: ls-remote che stampa una riga valida ma esce non-zero è una lettura fallita`, () => {
    assertFailClosed(name, supersedeScenario(source, { lsRemoteStatuses: '2 2 2' }));
  });

  test(`${name}: fetch e rilettura hanno un timeout per comando`, () => {
    const result = supersedeScenario(source);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const calls = result.timeoutLog.split('\n').filter(Boolean);
    assert.deepEqual(calls, ['60 git fetch', '30 git ls-remote'],
      `${name}: ogni comando di rete passa da timeout`);
  });

  test(`${name}: un errore transitorio recupera con una head verificata`, () => {
    const fetchRecovered = supersedeScenario(source, { fetchStatuses: '128 0' });
    assert.equal(fetchRecovered.status, 0,
      `fetch recuperato al 2° tentativo:\nstdout=${fetchRecovered.stdout}\nstderr=${fetchRecovered.stderr}`);
    assert.match(fetchRecovered.stdout, /run SUPERSEDED/);
    assert.equal(fetchRecovered.fetchCount, 2);
    assert.deepEqual(fetchRecovered.sleepLog.split('\n').filter(Boolean), ['5']);

    // La head si muove una volta: si classifica sulla lettura stabile
    // successiva, non su quella intermedia.
    const moved = supersedeScenario(source, {
      fetchedSequence: 'external-1 external-2',
      rereadSequence: 'external-2 external-2',
    });
    assert.equal(moved.status, 0, `stdout=${moved.stdout}\nstderr=${moved.stderr}`);
    assert.match(moved.stdout, /remote=external-2 /);
    assert.doesNotMatch(moved.stdout, /remote=external-1 /);
    assert.match(moved.stdout, /run SUPERSEDED/);
  });
}

test('dopo REMOTE_HEAD_UNVERIFIED il finalize redcheck chiude il claim failed-transient e resta retryable', async () => {
  const classified = supersedeScenario(WORKFLOW, { fetchStatuses: '128 128 128' });
  assert.equal(classified.status, 1);
  const inherited = /^CLAIM_STATUS=(.+)$/m.exec(classified.githubEnv)?.[1];
  assert.equal(inherited, 'failed-transient');

  // Codex 'success' ricostruirebbe `completed` (terminale): lo stato ereditato
  // dal classify deve prevalere.
  const finalized = runFinalize({
    claimStatus: inherited,
    codexOutcome: 'success',
    // Il fake gh restituisce la lista gia' comprensiva dell'evento pubblicato,
    // come nel test del finalize `released`.
    commentsJson: JSON.stringify([activeClaimComment(), activeClaimComment({ state: 'failed-transient' })]),
  });
  assert.equal(finalized.status, 0, `stdout=${finalized.stdout}\nstderr=${finalized.stderr}`);
  assert.match(finalized.stdout, /CLAIM_STATUS ereditato dal classify \(failed-transient\)/);
  assert.match(finalized.stdout, /claim_state=failed-transient/);

  const { redcheckFixClaimDecision, redcheckFixClaimKey } = await import('../../scripts/ci/redcheck-review-prefilter.mjs');
  const key = redcheckFixClaimKey({ prNumber: '7', headSha: HEAD_SHA_40, checkFailureKey: CHECK_FAILURE_KEY });
  const decision = redcheckFixClaimDecision({
    key,
    comments: [activeClaimComment(), activeClaimComment({ state: 'failed-transient' })],
  });
  assert.equal(decision.allowed, true, `il claim failed-transient deve restare retryable: ${JSON.stringify(decision)}`);
  assert.equal(decision.reason, 'same-red-claim-retryable');
});

test('redflag e redcheck leggono la head remota con lo stesso blocco verificato', () => {
  const extract = (source) => {
    const classify = runScript(stepBlockFrom(source, CLASSIFY_NAME));
    const start = classify.indexOf('# Head remota verificata prima di classificare');
    const end = classify.indexOf('REMOTE_HEAD_UNVERIFIED');
    assert.ok(start >= 0 && end > start, 'blocco head remota non trovato');
    return classify.slice(start, end);
  };
  assert.equal(extract(REDFLAG_WORKFLOW), extract(WORKFLOW),
    'i due gemelli devono condividere la stessa lettura verificata della head');
  for (const source of [WORKFLOW, REDFLAG_WORKFLOW]) {
    const classify = runScript(stepBlockFrom(source, CLASSIFY_NAME));
    assert.doesNotMatch(classify, /git fetch[^\n]*\|\| true/,
      'il fetch della head non deve essere best-effort');
    assert.doesNotMatch(classify, /ls-remote[^\n]*\|\| echo/,
      'una rilettura non-zero non deve essere mascherata da un fallback');
    const guardAt = classify.indexOf('REMOTE_HEAD_UNVERIFIED');
    for (const verdict of ['round SUCCESS', 'CLAIM_STATUS=released', 'run SUPERSEDED']) {
      assert.ok(classify.indexOf(verdict) > guardAt,
        `il guard fail-closed deve precedere «${verdict}»`);
    }
  }
});

test('il finalize ereditato dal classify lascia il claim released anche se Codex è failure', () => {
  const commentsJson = JSON.stringify([activeClaimComment(), activeClaimComment({ state: 'released' })]);
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
  assert.match(result.stdout, /claim_state=released/);
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
    markerCommentId: '77',
    commentsJson: JSON.stringify([roundMarkerComment({
      marker: 'REDFLAG_FIX_ROUND', round: 2, id: 77, body: baseBody,
    })]),
  });
  assert.equal(
    result.status,
    0,
    `redflag superseded deve uscire verde:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  assert.match(result.stdout, /run SUPERSEDED/);
  assert.match(result.stdout, /rimborsato/);
  assert.match(result.ghLog, /api .*DELETE .*issues\/comments\/77/);
  assert.match(result.ghLog, /REDFLAG_FIX_REFUNDED: 2/);
});

test('il rimborso pubblica il handle definitivo solo dopo la DELETE trusted', () => {
  const baseBody = '## Implementato\n\n- body iniziale';
  const scenarios = [
    {
      name: 'redflag superseded',
      source: REDFLAG_WORKFLOW,
      actionOutcome: 'failure',
      startSha: 'pr-sha',
      baseSha: 'merged-sha',
      head: 'merged-sha',
      remote: 'external-sha',
      marker: 'REDFLAG_FIX_ROUND',
      expectedStatus: 0,
    },
    {
      name: 'redflag skipped',
      source: REDFLAG_WORKFLOW,
      actionOutcome: 'skipped',
      marker: 'REDFLAG_FIX_ROUND',
      expectedStatus: 1,
    },
  ];

  for (const scenario of scenarios) {
    const result = runClassifier({
      ...scenario,
      baseBody,
      currentBody: baseBody,
      fixRound: '1',
      fixRoundMarker: scenario.marker,
      markerCommentId: '42',
      commentsJson: JSON.stringify([roundMarkerComment({
        marker: scenario.marker,
        round: 1,
        id: 42,
        body: baseBody,
      })]),
    });
    assert.equal(result.status, scenario.expectedStatus, scenario.name + ': esito inatteso:\n'
      + result.stdout + '\n' + result.stderr);
    const lines = result.ghLog.trim().split('\n');
    const expectedAttempt = scenario.marker.replace('_ROUND', '_REFUND_ATTEMPT') + ': 1';
    const expectedFinal = scenario.marker.replace('_ROUND', '_REFUNDED') + ': 1';
    const attemptAt = lines.findIndex((line) => line.includes(expectedAttempt));
    const deleteAt = lines.findIndex((line) => line.includes('api --method DELETE')
      && line.includes('/issues/comments/42'));
    const finalAt = lines.findIndex((line) => line.includes(expectedFinal));
    assert.ok(attemptAt >= 0, scenario.name + ': commento provvisorio assente\n' + result.ghLog);
    assert.ok(deleteAt > attemptAt, scenario.name + ': DELETE prima del commento provvisorio\n'
      + result.ghLog);
    assert.ok(finalAt > deleteAt, scenario.name + ': handle definitivo prima della DELETE\n'
      + result.ghLog);
  }
});

test('redflag distingue failure/skipped/cancelled/success e contabilizza il marker', () => {
  const baseBody = '## Implementato\n\n- body iniziale';
  const scenarios = [
    { outcome: 'failure', status: 1, refunded: false },
    { outcome: 'skipped', status: 1, refunded: true },
    { outcome: 'cancelled', status: 1, refunded: false },
    { outcome: 'success', status: 0, refunded: false },
  ];

  for (const { outcome, status, refunded } of scenarios) {
    const result = runClassifier({
      source: REDFLAG_WORKFLOW,
      baseBody,
      currentBody: baseBody,
      actionOutcome: outcome,
      fixRound: '1',
      fixRoundMarker: 'REDFLAG_FIX_ROUND',
      markerCommentId: '42',
      commentsJson: JSON.stringify([roundMarkerComment({
        marker: 'REDFLAG_FIX_ROUND', round: 1, id: 42, body: baseBody,
      })]),
    });
    assert.equal(
      result.status,
      status,
      `${outcome}: esito inatteso:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    if (refunded) {
      assert.match(result.ghLog, /api --method DELETE .*issues\/comments\/42/, `${outcome}: marker non cancellato`);
      assert.match(result.ghLog, /REDFLAG_FIX_REFUNDED: 1/, `${outcome}: handle di rimborso assente`);
    } else {
      assert.doesNotMatch(result.ghLog, /issues\/comments\/42/, `${outcome}: marker rimborsato senza prova di skipped`);
      assert.doesNotMatch(result.ghLog, /REDFLAG_FIX_REFUNDED: 1/, `${outcome}: handle di rimborso inatteso`);
    }
  }
});

test('un rimborso non scrivibile conserva il marker prima della DELETE', () => {
  const baseBody = '## Implementato\n\n- body iniziale';
  const scenarios = [
    {
      name: 'redflag skipped',
      source: REDFLAG_WORKFLOW,
      actionOutcome: 'skipped',
      expectedStatus: 1,
    },
    {
      name: 'redflag superseded',
      source: REDFLAG_WORKFLOW,
      actionOutcome: 'failure',
      startSha: 'pr-sha',
      baseSha: 'merged-sha',
      head: 'merged-sha',
      remote: 'external-sha',
      expectedStatus: 0,
    },
  ];

  for (const scenario of scenarios) {
    const result = runClassifier({
      ...scenario,
      baseBody,
      currentBody: baseBody,
      fixRound: '1',
      fixRoundMarker: scenario.source === REDFLAG_WORKFLOW
        ? 'REDFLAG_FIX_ROUND'
        : 'REDCHECK_FIX_ROUND',
      markerCommentId: '42',
      refundCommentStatus: 1,
      commentsJson: JSON.stringify([roundMarkerComment({
        marker: scenario.source === REDFLAG_WORKFLOW
          ? 'REDFLAG_FIX_ROUND'
          : 'REDCHECK_FIX_ROUND',
        round: 1,
        id: 42,
        body: baseBody,
      })]),
    });
    assert.equal(
      result.status,
      scenario.expectedStatus,
      `${scenario.name}: esito inatteso:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(result.ghLog, /pr comment/, `${scenario.name}: rimborso non tentato`);
    assert.doesNotMatch(
      result.ghLog,
      /api .*DELETE .*issues\/comments\/42/,
      `${scenario.name}: marker cancellato prima del rimborso`,
    );
  }
});
