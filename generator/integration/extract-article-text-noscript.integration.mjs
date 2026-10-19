import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractArticleText } from '../scripts/lib/extract-article-text.mjs';

test('rejects a malformed raw-text noscript without hiding later source prose', () => {
  const rejected = 'Paragraph before an unclosed raw-text element belongs to the rejected fallback.';
  const outer = 'Stable source prose after the malformed noscript remains available to the extractor.';
  const html = '<main><noscript>'
    + `<p>${rejected}</p>`
    + '<script type="application/ld+json">{"articleBody":"unterminated"}'
    + '</noscript>'
    + `<p>${outer}</p></main>`;

  const result = extractArticleText(html, { scriptingDisabled: true });

  assert.match(result.text, /Stable source prose/);
  assert.doesNotMatch(result.text, /Paragraph before an unclosed/);
  assert.doesNotMatch(result.text, /unterminated/);
});

test('merges adjacent editorial noscript blocks in order and omits tracking blocks', () => {
  const first = 'First adjacent editorial fallback paragraph retains its original document position.';
  const tracking = 'Adjacent tracking payload remains excluded even when surrounded by editorial blocks.';
  const second = 'Second adjacent editorial fallback paragraph follows the first without reordering.';
  const html = '<article>'
    + `<noscript><p>${first}</p></noscript>`
    + `<noscript><div data-track-pixel="1"><p>${tracking}</p></div></noscript>`
    + `<noscript><p>${second}</p></noscript>`
    + '</article>';

  const result = extractArticleText(html, { scriptingDisabled: true });

  assert.equal(result.method, 'article-tag');
  assert.equal(result.text, `${first}\n\n${second}`);
  assert.doesNotMatch(result.text, /Adjacent tracking payload/);
});

test('prefers JSON-LD inside normalized noscript over fallback paragraphs', () => {
  const articleBody = 'Structured JSON-LD body wins over fallback prose and remains authoritative. '.repeat(4);
  const fallbackOne = 'Fallback prose paragraph one is long enough to survive extraction but must not outrank JSON-LD.';
  const fallbackTwo = 'Fallback prose paragraph two is long enough to survive extraction but must not outrank JSON-LD.';
  const html = '<main><noscript>'
    + `&lt;script type="application/ld+json"&gt;${JSON.stringify({ '@type': 'NewsArticle', articleBody })}&lt;/script&gt;`
    + `&lt;p&gt;${fallbackOne}&lt;/p&gt;`
    + `&lt;p&gt;${fallbackTwo}&lt;/p&gt;`
    + '</noscript></main>';

  const result = extractArticleText(html, { scriptingDisabled: true });

  assert.equal(result.method, 'jsonld');
  assert.match(result.text, /Structured JSON-LD body wins/);
  assert.doesNotMatch(result.text, /Fallback prose paragraph one/);
  assert.doesNotMatch(result.text, /Fallback prose paragraph two/);
});
