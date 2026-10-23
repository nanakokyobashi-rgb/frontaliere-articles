import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/localized-toponyms.mjs', 'utf8');

test('localized toponym matching keeps official-name markers explicit', () => {
  assert.match(SOURCE, /OFFICIAL_NAME_MARKERS/);
  assert.match(SOURCE, /export function withoutOfficialNameWords/);
});
