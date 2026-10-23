import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/decisions-api.mjs', 'utf8');

test('decisions API keeps a bounded default timeout and explicit model', () => {
  assert.match(SOURCE, /DEFAULT_DECISIONS_API_TIMEOUT_MS = 30_000/);
  assert.match(SOURCE, /DECISIONS_API_MODEL = 'gpt-6-luna'/);
});
