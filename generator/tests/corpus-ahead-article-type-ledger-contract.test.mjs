import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('generator/scripts/backfill-article-type.mjs', 'utf8');

test('article type backfill keeps complete-ledger validation before fallback', () => {
  assert.match(SOURCE, /assertCompleteArticleTypeLedger/);
  assert.match(SOURCE, /ARTICLE_TYPE_READINGS_MANIFEST_PATH/);
});
