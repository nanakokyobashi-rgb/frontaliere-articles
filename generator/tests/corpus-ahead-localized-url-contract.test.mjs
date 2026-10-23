import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/localized-toponyms.mjs', 'utf8');

test('localized toponym projection keeps URL removal as a named stage', () => {
  assert.match(SOURCE, /export function withoutUrls/);
  assert.match(SOURCE, /function normalizeToponymMatchText/);
});
