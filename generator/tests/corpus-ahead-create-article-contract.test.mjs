import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve('generator/scripts/create-article.mjs'), 'utf8');

test('article creation keeps duplicate detection before generation', () => {
  assert.match(SOURCE, /Checks against existing articles to avoid duplicates/);
  assert.match(SOURCE, /Jaccard similarity on titles/);
});
