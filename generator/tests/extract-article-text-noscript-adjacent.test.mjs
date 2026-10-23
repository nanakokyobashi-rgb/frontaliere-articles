import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const SOURCE = fs.readFileSync(new URL('../scripts/lib/extract-article-text.mjs', import.meta.url), 'utf8');

test('mergeNoscriptFallbackBlocks mantiene ordine e filtra il tracking tra commenti e whitespace', () => {
  assert.match(SOURCE, /function areAdjacentNoscripts\(previous, current\)[\s\S]*?isWhitespace[\s\S]*?isComment/u);
  assert.match(
    SOURCE,
    /function mergeNoscriptFallbackBlocks\(root, maxChars, sourceMarkupByNode\)[\s\S]*?if \(!areAdjacentNoscripts\(previous, noscript\)\) flush\(\);/u,
  );
  assert.match(
    SOURCE,
    /const \[first, \.\.\.rest\] = group;[\s\S]*?paragraphsByNode\.set\(first, group\.flatMap/u,
  );
  assert.match(
    SOURCE,
    /function inspectNoscriptFallback\(noscript, maxChars, sourceMarkup\)[\s\S]*?hasNoscriptNonContentAncestor\(noscript, noscript\.ownerDocument\.documentElement\)/u,
  );
});
