import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/canton-classifier.mjs', 'utf8');

test('canton classifier keeps title and excerpt weighting explicit', () => {
  assert.match(SOURCE, /export const FIELD_WEIGHTS = Object\.freeze\(\{ title: 3, excerpt: 2, tags: 2, body: 1 \}\)/);
  assert.match(SOURCE, /export const BODY_TERM_CAP = 3/);
});
