import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/lib/article-topic-selector.mjs', 'utf8');

test('topic picker keeps consumed candidates outside the selection path', () => {
  assert.match(SOURCE, /const consumedIds = new Set\(opts\.consumed\?\.ids \|\| \[\]\)/);
  assert.match(SOURCE, /if \(consumedIds\.has\(cand\.id\)\) continue/);
});
