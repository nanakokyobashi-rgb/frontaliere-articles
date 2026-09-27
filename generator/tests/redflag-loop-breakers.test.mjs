/**
 * redflag-loop-breakers — gemello di valerielinc-ops/frontaliere-si-o-no#10068.
 *
 * Loop 🔴-fixer ↔ autorebase su PR `needs-human` (misurato sul sito, #9959:
 * 11 run redflag in 5h tutte al primo round, 45 merge di main in 24h, 43
 * review). Dal corpus#1932 il 🔴-fixer del corpus parte davvero (dispatch da
 * tests.yml), quindi le stesse tre uscite vanno chiuse qui:
 *   1. preflight: `needs-human` → notice + `actionable=false`;
 *   2. contesto sostituito in modo benigno prima di Codex → round rimborsato e
 *      job verde (il replay del precodex è in review-state-normalization);
 *      valori attesi malformati restano rossi;
 *   3. autorebase: conta solo l'ultimo verdetto del reviewer sulla revisione
 *      body corrente; niente passata su `needs-human` con verdetto bloccante.
 * Il push respinto del sito non ha un gemello: qui pusha Codex e il classify
 * tratta già il remoto avanzato come SUPERSEDED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  latestReviewerVerdict,
  needsHumanBlocksAutorebase,
} from '../../scripts/ci/pr-autorebase.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');
const AUTOREBASE = fs.readFileSync(path.join(ROOT, 'scripts/ci/pr-autorebase.mjs'), 'utf8');

/** Corpo di uno step `run: |`, senza parser YAML (come review-state-normalization). */
function stepRun(stepName) {
  const lines = WORKFLOW.split('\n');
  const start = lines.indexOf(`      - name: ${stepName}`);
  assert.notEqual(start, -1, `step non trovato: ${stepName}`);
  const runAt = lines.findIndex((line, i) => i > start && line === '        run: |');
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

// `--noprofile --norc` come review-state-normalization: senza, la shell di
// sviluppo può rimettere in testa al PATH lo shim `gh` reale.
function fakeBin(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

describe('1. preflight: needs-human ferma il loop', () => {
  // Il prefisso usa `grep -P` con locale C.UTF-8 (runner Linux): si esegue il
  // tratto che decide l'azionabilità di una PR con finding valido, dalla
  // lettura dello stato in poi.
  const pre = stepRun('PR still actionable?');
  const tail = pre.slice(pre.indexOf('state=$(gh pr view'));

  function runTail(needsHuman) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-redflag-preflight-'));
    try {
      const log = path.join(dir, 'gh.log');
      const out = path.join(dir, 'out');
      fs.writeFileSync(log, '');
      fs.writeFileSync(out, '');
      fakeBin(dir, 'gh', `echo "$*" >> "${log}"
case "$*" in
  *"--json state"*) echo OPEN ;;
  *needs-human*) echo "$FAKE_NEEDS_HUMAN" ;;
  *agent:autofix*) echo false ;;
  *branches*) echo x ;;
  *"run list"*) echo 0 ;;
esac`);
      const r = spawnSync('bash', ['--noprofile', '--norc', '-c', `set -uo pipefail\n${tail}`], {
        encoding: 'utf8',
        env: {
          PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: out, REPO: 'o/r', PR_NUMBER: '7',
          HEAD_REF: 'fix/x', PR_AUTHOR_TYPE: 'Bot', FAKE_NEEDS_HUMAN: needsHuman,
        },
      });
      return { ...r, out: fs.readFileSync(out, 'utf8'), log: fs.readFileSync(log, 'utf8') };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('needs-human → notice + actionable=false, prima del checkout', () => {
    const r = runTail('true');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /::notice::PR #7 ha la label needs-human/);
    assert.equal(r.out, 'actionable=false\n');
    assert.doesNotMatch(r.log, /branches\/|run list/);
  });

  it('senza needs-human (o label illeggibile) si procede come prima', () => {
    assert.equal(runTail('false').out, 'actionable=true\n');
    assert.equal(runTail('').out, 'actionable=true\n');
  });

  it('actionable=false spegne ogni job a valle', () => {
    assert.match(WORKFLOW, /\n  scope:\n    needs: preflight\n    if: needs\.preflight\.outputs\.actionable == 'true'/);
    assert.match(WORKFLOW, /\n  redflag-fix:\n[\s\S]{0,80}if: >-\n\s+needs\.preflight\.outputs\.actionable == 'true'/);
  });
});

describe('2. classify: run sostituita prima di Codex → round rimborsato, job verde', () => {
  const classify = stepRun('Classify outcome (work-done, not CLI exit)');
  const SHA = 'a'.repeat(40);

  function runClassify(precodexSuperseded) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-redflag-classify-'));
    try {
      const log = path.join(dir, 'gh.log');
      fs.writeFileSync(log, '');
      fakeBin(dir, 'gh', `echo "$*" >> "${log}"
case "$*" in
  *"api repos/o/r/pulls/7"*) echo '{"state":"open"}' ;;
  *"pr comment"*) exit 0 ;;
esac`);
      fakeBin(dir, 'git', `case "$1" in
  rev-parse) echo "${SHA}" ;;
  fetch) exit 0 ;;
  ls-remote) printf '%s\\trefs/heads/fix/x\\n' "${SHA}" ;;
  *) exit 64 ;;
esac`);
      fakeBin(dir, 'timeout', 'shift; exec "$@"');
      fakeBin(dir, 'sleep', 'exit 0');
      const helper = path.join(dir, 'helper.mjs');
      fs.writeFileSync(helper, 'process.stdout.write("{}\\n");\n');
      const env = path.join(dir, 'env');
      fs.writeFileSync(env, '');
      const r = spawnSync('bash', ['--noprofile', '--norc', '-c', classify], {
        encoding: 'utf8',
        env: {
          PATH: `${dir}:${process.env.PATH}`, GITHUB_ENV: env, REPO: 'o/r', PR_NUMBER: '7',
          HEAD_REF: 'fix/x', START_SHA: SHA, BASE_SHA: SHA, ACTION_OUTCOME: 'skipped',
          PRECODEX_SUPERSEDED: precodexSuperseded, FIX_ROUND: '1', FIX_ROUND_MARKER: 'REDFLAG_FIX_ROUND',
          MARKER_COMMENT_ID: '11', MARKER_HEAD: SHA, MARKER_BODY_REVISION: 'c'.repeat(64),
          TRUSTED_MARKER_HELPER: helper,
        },
      });
      return { ...r, log: fs.readFileSync(log, 'utf8') };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('precodex superseded → rimborso + notice + exit 0', () => {
    const r = runClassify('true');
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /::notice::run sostituita/);
    assert.doesNotMatch(r.stdout, /::error::/);
    assert.match(r.log, /REDFLAG_FIX_REFUNDED/);
  });

  it('precodex fallito per altro → resta rosso (rimborso compreso)', () => {
    for (const value of ['', 'false']) {
      const r = runClassify(value);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /::error::🔴-fix: Codex non invocato/);
    }
  });

  it('il classify legge superseded dal proprio precodex', () => {
    assert.match(WORKFLOW, /PRECODEX_SUPERSEDED: \$\{\{ steps\.precodex\.outputs\.superseded \}\}/);
  });
});

describe('3. autorebase: ultimo verdetto e veto needs-human', () => {
  const HEAD = 'a'.repeat(40);
  const OLD = 'b'.repeat(40);
  const REV = `body:${'c'.repeat(64)}`;
  const LGTM = '## Findings (Important: 0)\n\n## LGTM';
  const RED = '## Findings (1)\n🔴 Important: rotto';
  const review = (body, commit, at, { revision = REV, login = 'claude[bot]' } = {}) => ({
    user: { login, type: 'Bot' }, commit_id: commit, submitted_at: at, state: 'COMMENTED',
    body: `${body}\n<!-- REVIEW_INPUT_REVISION: ${revision} -->`,
  });

  it('un LGTM vecchio con la stessa revisione body non vale contro un 🔴 sulla HEAD', () => {
    assert.equal(latestReviewerVerdict([
      review(LGTM, OLD, '2026-09-26T10:00:00Z'),
      review(RED, HEAD, '2026-09-27T10:00:00Z'),
    ], HEAD, REV), 'blocking');
  });

  it('la review sulla HEAD prevale; senza, vale la più recente', () => {
    assert.equal(latestReviewerVerdict([
      review(LGTM, HEAD, '2026-09-27T09:00:00Z'),
      review(RED, OLD, '2026-09-27T10:00:00Z'),
    ], HEAD, REV), 'lgtm');
    assert.equal(latestReviewerVerdict([
      review(RED, OLD, '2026-09-26T10:00:00Z'),
      review(LGTM, 'c'.repeat(40), '2026-09-27T10:00:00Z'),
    ], HEAD, REV), 'lgtm');
    assert.equal(latestReviewerVerdict([
      review(RED, HEAD, '2026-09-27T12:00:00Z'),
      review(LGTM, HEAD, '2026-09-27T08:00:00Z'),
    ], HEAD, REV), 'blocking');
  });

  it('resta legato alla revisione body corrente e ai reviewer gestiti', () => {
    const otherRev = `body:${'d'.repeat(64)}`;
    assert.equal(latestReviewerVerdict([
      review(LGTM, HEAD, '2026-09-27T08:00:00Z'),
      review(RED, HEAD, '2026-09-27T12:00:00Z', { revision: otherRev }),
    ], HEAD, REV), 'lgtm');
    assert.equal(latestReviewerVerdict([
      review(LGTM, HEAD, '2026-09-27T08:00:00Z', { revision: otherRev }),
    ], HEAD, REV), 'none');
    assert.equal(latestReviewerVerdict([
      review(RED, HEAD, '2026-09-27T12:00:00Z', { login: 'someone' }),
      review(LGTM, HEAD, '2026-09-27T08:00:00Z'),
    ], HEAD, REV), 'lgtm');
    assert.equal(latestReviewerVerdict(null, HEAD, REV), 'unknown');
    assert.equal(latestReviewerVerdict([], HEAD, ''), 'unknown');
  });

  it('una review DISMISSED o PENDING non è un verdetto: il suo LGTM non sblocca', () => {
    const withState = (body, commit, at, state) => ({ ...review(body, commit, at), state });
    assert.equal(latestReviewerVerdict([
      review(RED, HEAD, '2026-09-27T10:00:00Z'),
      withState(LGTM, HEAD, '2026-09-27T11:00:00Z', 'DISMISSED'),
    ], HEAD, REV), 'blocking');
    assert.equal(latestReviewerVerdict([
      review(RED, HEAD, '2026-09-27T10:00:00Z'),
      withState(LGTM, HEAD, '2026-09-27T11:00:00Z', 'PENDING'),
    ], HEAD, REV), 'blocking');
    // Solo review gestite non terminali: verdetto illeggibile, non «nessuna review».
    assert.equal(latestReviewerVerdict([
      withState(LGTM, HEAD, '2026-09-27T11:00:00Z', 'DISMISSED'),
    ], HEAD, REV), 'unknown');
  });

  it('le letture paginate di review/eventi/commenti usano --slurp (niente `[...][...]` a JSON.parse)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    for (const file of ['pr-autorebase', 'auto-merge-eval', 'review-test-policy', 'followup-drainer', 'needs-human-prepass']) {
      const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'ci', `${file}.mjs`), 'utf8');
      const bare = src.split('\n').filter((line) => /\/(reviews|events|comments)[^'`]*`, '--paginate'\]/.test(line));
      assert.deepEqual(bare, [], `${file}.mjs legge una lista paginata senza --slurp né --jq`);
    }
  });

  it('needs-human veta solo con verdetto bloccante o illeggibile', () => {
    assert.equal(needsHumanBlocksAutorebase({ labels: ['needs-human'], verdict: 'blocking' }), true);
    assert.equal(needsHumanBlocksAutorebase({ labels: [{ name: 'needs-human' }], verdict: 'unknown' }), true);
    assert.equal(needsHumanBlocksAutorebase({ labels: ['needs-human'], verdict: 'lgtm' }), false);
    assert.equal(needsHumanBlocksAutorebase({ labels: ['needs-human'], verdict: 'none' }), false);
    assert.equal(needsHumanBlocksAutorebase({ labels: ['stale-review'], verdict: 'blocking' }), false);
  });

  it('il veto precede il ledger needs-human e ogni push', () => {
    const veto = AUTOREBASE.indexOf('if (needsHumanBlocksAutorebase({ labels, verdict: reviewerVerdict }))');
    const ledger = AUTOREBASE.indexOf('decideNeedsHumanPass({');
    const push = AUTOREBASE.indexOf('const pushed = pushBranch(branch)');
    assert.ok(veto > -1 && veto < ledger && ledger < push, `veto=${veto} ledger=${ledger} push=${push}`);
    assert.match(AUTOREBASE, /const lgtm = reviewerVerdict === 'lgtm';/);
    assert.doesNotMatch(AUTOREBASE, /function hasLgtmReview\(/);
  });
});
