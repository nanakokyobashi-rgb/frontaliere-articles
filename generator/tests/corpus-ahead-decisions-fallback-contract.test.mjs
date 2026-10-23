import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/decisions-api.mjs', 'utf8');

test('decisions API keeps typed timeout errors and provider provenance', () => {
  assert.match(SOURCE, /DECISIONS_API_TIMEOUT/);
  assert.match(SOURCE, /provider: 'openai-decisions'/);
});
