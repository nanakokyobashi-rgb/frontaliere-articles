import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/canton-classifier.mjs', 'utf8');

test('canton classifier keeps national-scope exclusions explicit', () => {
  assert.match(SOURCE, /NATIONAL_SCOPE_HEADLINE_RE/);
  assert.match(SOURCE, /NATIONAL_SCOPE_LEAD_RE/);
});
