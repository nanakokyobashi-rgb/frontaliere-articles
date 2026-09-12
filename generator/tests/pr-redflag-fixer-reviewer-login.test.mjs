/**
 * pr-redflag-fixer job-level reviewer filter — App bot is a reviewer.
 *
 * `pr-redflag-fixer.yml` is `adapted` in loop-sync-manifest.json, so the
 * login `if:` is owned here. A `startsWith(..., 'claude')` only filter
 * skips `frontaliere-automation[bot]` reviews (site PRs #7610/#7609).
 * Reads the shipped workflow; does not reimplement the GitHub `if:` evaluator.
 * Head bump: force a new tests+review run after the consumer sweep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');

test('a frontaliere-automation[bot] review with 🔴 passes the job trigger and reaches author preflight', () => {
  const jobIf = src.match(/\n    if: \|\n([\s\S]*?)\n    runs-on:/)?.[1] ?? '';
  assert.match(jobIf, /startsWith\(github\.event\.review\.user\.login, 'frontaliere-automation'\)/);
  assert.match(jobIf, /contains\(github\.event\.review\.body, '🔴'\)/);
  assert.doesNotMatch(jobIf, /github\.event\.pull_request\.user\.type/,
    'il job-level if: deve lasciare il predicato autore al preflight osservabile');
  assert.doesNotMatch(jobIf, /github\.event\.pull_request\.head\.ref/,
    'il job-level if: deve lasciare il predicato branch al preflight osservabile');
  assert.match(src, /PR_AUTHOR_TYPE: \$\{\{ github\.event\.pull_request\.user\.type \}\}/);
  assert.match(src, /if \[ "\$PR_AUTHOR_TYPE" != "Bot" \] && ! printf '%s' "\$HEAD_REF" \| grep -q '\^fix\//);
  assert.doesNotMatch(src, /github\.event\.review\.user\.type == 'Bot'/,
    'il tipo del reviewer non identifica l autore della PR');
  assert.match(src, /contains\(github\.event\.review\.body, '🔴'\)/);
  assert.match(src, /startsWith\(github\.event\.review\.user\.login, 'claude'\) \|\|/);
});

test('no longer requires login to start with claude as the only reviewer match', () => {
  assert.doesNotMatch(
    src,
    /startsWith\(github\.event\.review\.user\.login, 'claude'\) &&\s*\n\s*contains\(github\.event\.review\.body, '🔴'\)/,
  );
});

test('collect-review jq, review-gate and auto-merge-eval use the same bot set', () => {
  // I consumer `.mjs` non contengono piu' il login in chiaro: importano
  // `REVIEWER_BOT_LOGIN_RE` da `scripts/ci/lib/constants.mjs`, ed e'
  // `generator/tests/reviewer-bot-login.test.mjs` a pinnare quel legame per
  // tutti e sei i consumer (qui resterebbe una copia della stessa regola).
  assert.match(src, /select\(\(\.user\.login\|test\("\^\(claude\|frontaliere-automation\)";"i"\)\)/);
  assert.match(src, /contains\("## Findings \("\)/);
  const testsYml = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.match(testsYml, /test\("\^\(claude\|frontaliere-automation\)";"i"\)/);
  assert.doesNotMatch(testsYml, /test\("claude";"i"\)/);
});

test('il push guard controlla il token che il push remote usa davvero', () => {
  const at = src.indexOf('- name: Configure push remote');
  const next = src.indexOf('\n      - name:', at + 1);
  const block = src.slice(at, next < 0 ? src.length : next);
  assert.match(block, /env\.APP_TOKEN != '' \|\| env\.GITHUB_PAT_NANAKO != ''/);
  assert.doesNotMatch(block, /env\.GITHUB_PAT != ''/);
});

test('il job redflag-fix conserva il checkout completo senza fetch shallow della base', () => {
  const fixerJob = src.match(/\n  redflag-fix:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n|$)/)?.[1] ?? '';
  assert.notEqual(fixerJob, '', 'job redflag-fix non trovato');
  assert.match(fixerJob, /fetch-depth: 0/);
  assert.doesNotMatch(fixerJob, /git fetch[^\n]*--depth=1/);
});
