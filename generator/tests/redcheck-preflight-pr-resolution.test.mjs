/**
 * Il preflight del ❌-check fixer deve trovare la PR e la run rossa da
 * riparare. Due modi in cui non la trovava, entrambi silenziosi:
 *
 * - `workflow_dispatch` cercava la run fallita fra le ultime 20 run di
 *   `tests.yml` di tutto il repo: qui coprono circa 50 minuti (05:26Z → 06:17Z
 *   del 2026-09-25), quindi un dispatch su una PR rossa da più di un'ora
 *   finiva in no-op. Ora cerca per `head_sha`.
 * - `workflow_run` leggeva una sola pagina di PR aperte, e ogni errore
 *   dell'API diventava «nessuna PR». Sul sito lo stesso fallback ha nascosto
 *   per 5 giorni un `--slurp --jq` che il gh reale rifiuta
 *   (valerielinc-ops/frontaliere-si-o-no#9797).
 *
 * Il test esegue lo snippet VERO dello step con un gh finto che si comporta
 * come quello reale sulle combinazioni di flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redcheck-fixer.yml'), 'utf8');

function resolutionSnippet() {
  const start = source.indexOf('skip() { echo "$1"; echo "actionable=false" >> "$GITHUB_OUTPUT"; exit 0; }');
  const end = source.indexOf('\n          pr=$(gh api "repos/$REPO/pulls/$PR"', start);
  assert.notEqual(start, -1, 'la funzione skip del preflight non e\' stata trovata');
  assert.notEqual(end, -1, 'la lettura della PR dopo la risoluzione non e\' stata trovata');
  return source.slice(start, end).split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
}

const HEAD = '0123456789abcdef0123456789abcdef01234567';

function run({ dispatch, openPrs = '42', failedRuns = '123', failMode = '', prHead = HEAD }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redcheck-resolution-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'calls');
  const output = path.join(dir, 'output');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(output, '');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
printf '%s\\n' "$*" >> "${calls}"
case " $* " in
  *" --slurp "*) case " $* " in *" --jq "*|*" --template "*)
    echo 'the \`--slurp\` option is not supported with \`--jq\` or \`--template\`' >&2; exit 1;; esac;;
esac
if [ "$1" = run ] && [ "$2" = list ]; then echo 0; exit 0; fi
case "$2" in
  */pulls/42) echo "$PR_HEAD";;
  */actions/workflows/tests.yml/runs\\?head_sha=*)
    [ "$FAIL_MODE" = runs ] && exit 1
    [ -n "$FAILED_RUNS" ] && echo "$FAILED_RUNS";;
  */pulls\\?state=open*)
    [ "$FAIL_MODE" = pulls ] && exit 1
    [ -n "$OPEN_PRS" ] && printf '%s\\n' "$OPEN_PRS";;
  *) exit 1;;
esac
exit 0
`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const script = `set -uo pipefail\n${resolutionSnippet()}\necho "RESOLVED PR=$PR RUN_ID=\${RUN_ID:-}"\n`;
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      REPO: 'o/r',
      EVENT_NAME: dispatch ? 'workflow_dispatch' : 'workflow_run',
      DISPATCH_PR: dispatch ? '42' : '',
      RUN_ID: dispatch ? '' : '777',
      RUN_SHA: dispatch ? '' : HEAD,
      RUN_BRANCH: 'fix/issue-1',
      OPEN_PRS: openPrs,
      FAILED_RUNS: failedRuns,
      FAIL_MODE: failMode,
      PR_HEAD: prHead,
    },
  });
  const ghCalls = fs.readFileSync(calls, 'utf8');
  const githubOutput = fs.readFileSync(output, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { result, ghCalls, githubOutput };
}

test('dispatch: la run rossa si trova per head_sha, non fra le ultime 20 del repo', () => {
  const { result, ghCalls } = run({ dispatch: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESOLVED PR=42 RUN_ID=123/);
  assert.match(ghCalls, new RegExp(`actions/workflows/tests\\.yml/runs\\?head_sha=${HEAD}&status=failure`));
  assert.doesNotMatch(ghCalls, /^run list/m);
});

test('dispatch: nessuna run rossa sulla HEAD e\' un no-op', () => {
  const { result, githubOutput } = run({ dispatch: true, failedRuns: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nessuna run tests fallita/);
  assert.match(githubOutput, /actionable=false/);
});

test('dispatch: run illeggibili o HEAD malformata fanno fallire il job', () => {
  assert.notEqual(run({ dispatch: true, failMode: 'runs' }).result.status, 0);
  const malformed = run({ dispatch: true, prHead: '' });
  assert.notEqual(malformed.result.status, 0);
  assert.doesNotMatch(malformed.ghCalls, /runs\?head_sha=&/);
});

test('workflow_run: la PR si cerca paginata, senza --slurp, e vince la prima', () => {
  const { result, ghCalls } = run({ dispatch: false, openPrs: '42\n77' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESOLVED PR=42 RUN_ID=777/);
  const list = ghCalls.split('\n').find((line) => line.includes('pulls?state=open')) ?? '';
  assert.match(list, /--paginate/);
  assert.doesNotMatch(list, /--slurp/);
});

test('workflow_run: una lista illeggibile fa fallire il job invece di sembrare «nessuna PR»', () => {
  const { result, githubOutput } = run({ dispatch: false, failMode: 'pulls' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(githubOutput, /actionable=/);
});

test('workflow_run: nessuna PR sul branch e\' un no-op', () => {
  const { result, githubOutput } = run({ dispatch: false, openPrs: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nessuna PR aperta/);
  assert.match(githubOutput, /actionable=false/);
});
