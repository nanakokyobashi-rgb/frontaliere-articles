import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const SOURCE = fs.readFileSync(new URL('../scripts/lib/extract-article-text.mjs', import.meta.url), 'utf8');

test('selectNoscriptJsonLdPrecedence scarta JSON-LD del blocco tracking e conserva quello editoriale', () => {
  assert.match(SOURCE, /function noscriptJsonLdIsEditorial\(script, root\)[\s\S]*?hasNoscriptNonContentAncestor/u);
  assert.match(
    SOURCE,
    /function selectNoscriptJsonLdPrecedence\(document, fallbacks\)[\s\S]*?extractFromJsonLd\(document, script => !script\.closest\('noscript'\)\)/u,
  );
  assert.match(SOURCE, /\.\.\.fallbacks\.jsonLdBodies[\s\S]*?body\.length > best\.length/u);
  assert.match(SOURCE, /selectNoscriptJsonLdPrecedence\(document, noscriptFallbacks\)/u);
});
