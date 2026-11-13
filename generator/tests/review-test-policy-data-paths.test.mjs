import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  isNonRuntimeCodePath,
} from '../../scripts/ci/review-test-policy.mjs';

const WORKFLOW = readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8');

test('classifica i dati generati e gli asset statici senza allargarsi al codice', () => {
  for (const path of [
    'content/blog-body/it/article.ts',
    'content/blog-meta-it.ts',
    'data/articles.json',
    'public/images/article.webp',
    'feeds/sitemap.xml',
    'exports/articles.csv',
    'exports/articles.jsonl',
  ]) assert.equal(isNonRuntimeCodePath(path), true, path);

  for (const path of [
    'engine/articleReaders.ts',
    'generator/build-api.mjs',
    'package.json',
    '../content/article.ts',
    'content/../engine/article.ts',
  ]) assert.equal(isNonRuntimeCodePath(path), false, path);
});

test('il filtro NONCODE_RE del workflow copre immagini e XML con gli escape corretti', () => {
  const match = WORKFLOW.match(/^\s+NONCODE_RE:\s+'([^']+)'$/mu);
  assert.ok(match, 'tests.yml deve dichiarare NONCODE_RE');
  const nonCode = new RegExp(match[1]);

  for (const path of [
    'content/blog-body/it/article.ts',
    'assets/article.webp',
    'feeds/sitemap.xml',
    'exports/articles.jsonl',
  ]) assert.equal(nonCode.test(path), true, path);
  assert.equal(nonCode.test('engine/articleReaders.ts'), false);
});
