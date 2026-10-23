import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/backfill-article-type.mjs', 'utf8');

test('article type backfill keeps source citation classification wired to the registry engine', () => {
  assert.match(SOURCE, /articleTypeFromItalianBody/);
  assert.match(SOURCE, /registryArticleTypeForRun/);
});
