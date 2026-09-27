/**
 * redflag-dispatch-from-review.test.mjs — il 🔴-fixer deve partire anche
 * quando la review e' pubblicata col GITHUB_TOKEN.
 *
 * La review Codex di `tests.yml` e' postata con `codex_github_token:
 * secrets.GITHUB_TOKEN`, quindi l'autore e' `github-actions[bot]`. GitHub non
 * avvia workflow da eventi creati da quel token: il trigger
 * `pull_request_review: submitted` di `pr-redflag-fixer.yml` non scattava mai
 * (fermo dal 17-09; es. review 🔴 sulla PR #1924 del 27-09 senza alcuna run).
 * `workflow_dispatch` e' l'eccezione ammessa, e questo test tiene insieme i
 * quattro pezzi che la rendono operativa: output del gate, step di dispatch,
 * permesso `actions: write`, ramo dispatch del fixer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tests = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
const fixer = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');
const gate = fs.readFileSync(path.join(ROOT, 'scripts/ci/review-gate.mjs'), 'utf8');

const DISPATCH_NAME = 'Dispatch 🔴-fixer for a GITHUB_TOKEN review';

function stepBlock(source, name) {
  const start = source.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step «${name}» non trovato`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
}

test('la review Codex e\' pubblicata col GITHUB_TOKEN: e\' la premessa del dispatch', () => {
  assert.match(tests, /codex_github_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

test('il gate espone redflag_open e il login dell\'autore della review', () => {
  assert.match(gate, /writeGateOutput\('redflag_open', 'true'\)/);
  assert.match(gate, /writeGateOutput\('redflag_review_login',/);
});

test('tests.yml dispatcha il fixer dopo il gate, solo per un 🔴 vivo di github-actions[bot]', () => {
  const step = stepBlock(tests, DISPATCH_NAME);
  assert.ok(tests.indexOf('        id: review_gate\n') < tests.indexOf(`      - name: ${DISPATCH_NAME}`),
    'il dispatch deve seguire il gate che scrive gli output');
  assert.match(step, /steps\.review_gate\.outputs\.redflag_open == 'true'/);
  // Un'identita' App avvia gia' `pull_request_review`: dispatch solo per il
  // GITHUB_TOKEN, cosi' non si duplicano run.
  assert.match(step, /steps\.review_gate\.outputs\.redflag_review_login == 'github-actions\[bot\]'/);
  assert.match(step, /always\(\)/, 'il gate esce 1 proprio sul 🔴: senza always() lo step non gira mai');
  assert.match(step, /gh workflow run pr-redflag-fixer\.yml --repo "\$GITHUB_REPOSITORY" -f pr="\$PR_NUMBER"/);
  assert.match(step, /PR_NUMBER: \$\{\{ steps\.resolve\.outputs\.pr_number \}\}/);
  // Non-gating: un rosso qui toccherebbe `vitestFailureIsReviewGate`.
  assert.doesNotMatch(step, /exit 1/);
});

test('il token del job puo\' fare workflow_dispatch', () => {
  const perms = tests.slice(tests.indexOf('\npermissions:\n'), tests.indexOf('\nconcurrency:\n'));
  assert.match(perms, /^  actions: write$/m);
});

test('il ramo dispatch del fixer ritrova la review dal solo numero PR e serializza per PR', () => {
  assert.match(fixer, /workflow_dispatch:\n\s+inputs:\n\s+pr:/);
  assert.match(fixer, /github\.event_name == 'workflow_dispatch' \|\|/);
  assert.match(fixer, /PR_NUMBER="\$\{DISPATCH_PR:-\}"/);
  // Il filtro dei reviewer accetta github-actions[bot] solo col marker Codex,
  // che la review di tests.yml porta sempre.
  assert.match(tests, /review_marker: '<!-- CODEX_FALLBACK_REVIEW -->'/);
  assert.match(fixer, /github-actions\\\\\[bot\\\\\]\$";"i"\)\)\s*\n\s*and \(\(\.body \/\/ ""\) \| contains\("<!-- CODEX_FALLBACK_REVIEW -->"\)\)/);
  // Concurrency per-PR senza cancel: dispatch ed evento review non corrono in parallelo.
  assert.match(fixer, /group: redflag-fix-pr-\$\{\{ inputs\.pr \|\| github\.event\.pull_request\.number/);
  assert.match(fixer, /cancel-in-progress: false/);
});
