import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/canton-classifier.mjs', 'utf8');

test('canton classifier keeps source-domain weighting separate from assignment', () => {
  assert.match(SOURCE, /export const SOURCE_DOMAIN_WEIGHT = 3/);
  assert.match(SOURCE, /FRONTALIERE_TICINO_SOURCE_HOSTS/);
});
