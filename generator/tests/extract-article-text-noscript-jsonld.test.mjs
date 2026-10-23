import assert from 'node:assert/strict';
import test from 'node:test';

import { extractArticleText } from '../scripts/lib/extract-article-text.mjs';

test('selectNoscriptJsonLdPrecedence scarta JSON-LD del blocco tracking e conserva quello editoriale', () => {
  const trackingBody = 'Tracking JSON-LD must not become article content. '.repeat(8);
  const editorialBody = 'Editorial JSON-LD remains authoritative over fallback prose. '.repeat(8);
  const fallback = 'Fallback prose is long enough to survive extraction but must lose to the editorial JSON-LD body.';
  const trackingJson = JSON.stringify({ '@type': 'NewsArticle', articleBody: trackingBody });
  const editorialJson = JSON.stringify({ '@type': 'NewsArticle', articleBody: editorialBody });
  const encode = value => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const html = '<main>'
    + '<noscript>&lt;div data-analytics="pixel"&gt;'
    + encode(`&lt;script type="application/ld+json"&gt;${trackingJson}&lt;/script&gt;`)
    + '&lt;/div&gt;</noscript>'
    + '<noscript>'
    + `&lt;script type="application/ld+json"&gt;${editorialJson}&lt;/script&gt;`
    + `&lt;p&gt;${fallback}&lt;/p&gt;`
    + '</noscript>'
    + '</main>';

  const result = extractArticleText(html, { scriptingDisabled: true });

  assert.equal(result.method, 'jsonld');
  assert.match(result.text, /Editorial JSON-LD remains authoritative/);
  assert.doesNotMatch(result.text, /Tracking JSON-LD must not become/);
  assert.doesNotMatch(result.text, /Fallback prose is long enough/);
});
