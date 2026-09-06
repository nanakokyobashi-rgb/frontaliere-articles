/**
 * pr-redflag-fixer job-level reviewer filter — App bot is a reviewer.
 *
 * `pr-redflag-fixer.yml` is `adapted` in loop-sync-manifest.json, so the
 * login `if:` is owned here. A `startsWith(..., 'claude')` only filter
 * skips `frontaliere-automation[bot]` reviews (site PRs #7610/#7609).
 * Reads the shipped workflow; does not reimplement the GitHub `if:` evaluator.
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
  assert.match(src, /github\.event\.review\.user\.login == 'frontaliere-automation\[bot\]'/);
  assert.match(src, /startsWith\(github\.event\.review\.user\.login, 'claude'\) \|\|/);
});

test('no longer requires login to start with claude as the only reviewer match', () => {
  assert.doesNotMatch(
    src,
    /startsWith\(github\.event\.review\.user\.login, 'claude'\) &&\s*\n\s*contains\(github\.event\.review\.body, '🔴'\)/,
  );
});
