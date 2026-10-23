import assert from 'node:assert/strict';
import test from 'node:test';

import { extractArticleText } from '../scripts/lib/extract-article-text.mjs';

test('mergeNoscriptFallbackBlocks mantiene ordine e filtra il tracking tra commenti e whitespace', () => {
  const first = 'Editorial fallback one remains in document order when adjacent blocks are merged.';
  const tracking = 'Tracking payload must never become article prose even when it sits between two fallbacks.';
  const second = 'Editorial fallback two remains after the tracking block without being reordered.';
  const html = '<article>'
    + `<noscript><p>${first}</p></noscript>`
    + '<!-- renderer marker -->\n'
    + `<noscript><div data-analytics="pixel"><p>${tracking}</p></div></noscript>`
    + ' \n '
    + `<noscript><p>${second}</p></noscript>`
    + '</article>';

  const result = extractArticleText(html, { scriptingDisabled: true });

  assert.equal(result.method, 'article-tag');
  assert.equal(result.text, `${first}\n\n${second}`);
  assert.doesNotMatch(result.text, /Tracking payload/);
});
