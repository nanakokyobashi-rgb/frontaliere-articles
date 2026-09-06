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

test('a frontaliere-automation[bot] review with 🔴 would pass the job-level trigger', () => {
  assert.match(src, /github\.event\.review\.user\.type == 'Bot'/);
  assert.match(src, /contains\(github\.event\.review\.body, '🔴'\)/);
  assert.match(src, /startsWith\(github\.event\.review\.user\.login, 'frontaliere-automation'\)/);
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
  assert.match(src, /select\(\.user\.login\|test\("\^\(claude\|frontaliere-automation\)";"i"\)\)/);
  const testsYml = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.match(testsYml, /test\("\^\(claude\|frontaliere-automation\)";"i"\)/);
  assert.doesNotMatch(testsYml, /test\("claude";"i"\)/);
});
