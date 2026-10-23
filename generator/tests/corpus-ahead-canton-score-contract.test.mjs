import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/canton-classifier.mjs', 'utf8');

test('canton classifier keeps bounded score and assignment limits', () => {
  assert.match(SOURCE, /export const MIN_SCORE = 8/);
  assert.match(SOURCE, /export const MAX_CANTONS = 3/);
});
