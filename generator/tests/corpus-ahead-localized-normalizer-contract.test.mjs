import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/localized-toponyms.mjs', 'utf8');

test('localized toponym module keeps one shared normalization entrypoint', () => {
  assert.match(SOURCE, /export function normalizeLocalizedToponymText/);
  assert.match(SOURCE, /LOCALIZED_TOPONYM_LOCALES/);
});
