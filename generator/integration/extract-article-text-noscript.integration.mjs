import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractArticleText } from '../scripts/lib/extract-article-text.mjs';

function icmsDate(text) {
  return `<div class="icms-lead-container"><div class="icms-block icms-information-date">${text}</div></div>`;
}

function extractIcmsDetail(markup, metadata = '') {
  return extractArticleText(`${metadata}<main>${markup}
    <p>The municipality will open a reading room for local residents this spring.</p>
    <p>Visitors can borrow books and attend workshops at the new public facility.</p>
  </main>`, { scriptingDisabled: true });
}

test('extracts a German iCMS detail date at UTC midnight and preserves the body', () => {
  const result = extractIcmsDetail(icmsDate('7. März 2024'));

  assert.equal(result.publishedAt, '2024-03-07T00:00:00.000Z');
  assert.equal(result.method, 'main-tag');
  assert.equal(result.paragraphCount, 2);
  assert.equal(result.text, 'The municipality will open a reading room for local residents this spring.\n\n'
    + 'Visitors can borrow books and attend workshops at the new public facility.');
});

test('extracts an iCMS detail date from the active article root', () => {
  const body = '<p>The municipality will open a reading room for local residents this spring.</p>'
    + '<p>Visitors can borrow books and attend workshops at the new public facility.</p>';
  const result = extractArticleText(`<article>${icmsDate('7. März 2024')}${body}</article>`, {
    scriptingDisabled: true,
  });

  assert.equal(result.publishedAt, '2024-03-07T00:00:00.000Z');
  assert.equal(result.method, 'article-tag');
});

test('uses the same editorial root selected for the body extraction', () => {
  const shortArticle = `<article>${icmsDate('7. März 2024')}
    <p>This teaser is not the article body.</p>
  </article>`;
  const main = `<main>${icmsDate('8. März 2024')}
    <p>The municipality will open a reading room for local residents this spring.</p>
    <p>Visitors can borrow books and attend workshops at the new public facility.</p>
  </main>`;

  const result = extractArticleText(shortArticle + main, { scriptingDisabled: true });

  assert.equal(result.publishedAt, '2024-03-08T00:00:00.000Z');
  assert.equal(result.method, 'main-tag');
});

test('does not accept an iCMS date from the document shell without an editorial root', () => {
  const result = extractArticleText(`${icmsDate('7. März 2024')}
    <p>Only one paragraph is available outside an article or main root.</p>`, {
    scriptingDisabled: true,
  });

  assert.equal(result.method, 'naive-fallback');
  assert.equal(Object.hasOwn(result, 'publishedAt'), false);
});

test('preserves the iCMS date in the naive fallback for a page without noscript', () => {
  const result = extractArticleText(`<main>${icmsDate('7. März 2024')}<p>Short notice.</p></main>`);

  assert.equal(result.method, 'naive-fallback');
  assert.equal(result.publishedAt, '2024-03-07T00:00:00.000Z');
});

test('preserves the JSON-LD publication date when the text is too short for structured extraction', () => {
  const html = '<script type="application/ld+json">{"datePublished":"2024-02-01","articleBody":"Short notice."}</script>'
    + '<main><p>Short notice.</p></main>';

  for (const scriptingDisabled of [false, true]) {
    const result = extractArticleText(html, { scriptingDisabled });
    assert.equal(result.method, 'naive-fallback');
    assert.equal(result.publishedAt, '2024-02-01T00:00:00.000Z');
  }
});

test('keeps the historical result shape for both naive fallbacks without a publication date', () => {
  const html = '<main><p>Short notice.</p></main>';

  for (const scriptingDisabled of [false, true]) {
    const result = extractArticleText(html, { scriptingDisabled });
    assert.deepEqual(result, { text: 'Short notice.', method: 'naive-fallback', paragraphCount: 0 });
  }
});

test('preserves the iCMS date when the noscript-safe fallback is selected', () => {
  const result = extractArticleText(`<main>${icmsDate('7. März 2024')}
    <noscript><div>Fallback content remains available when scripts are disabled.</div></noscript>
  </main>`, { scriptingDisabled: true });

  assert.equal(result.method, 'naive-fallback');
  assert.equal(result.publishedAt, '2024-03-07T00:00:00.000Z');
});

test('keeps JSON-LD, publication meta and explicit time ahead of the iCMS date', () => {
  const detail = icmsDate('7. März 2024');
  const time = '<time itemprop="datePublished" datetime="2024-02-03"></time>';
  const meta = '<meta property="article:published_time" content="2024-02-02">';
  const jsonLd = '<script type="application/ld+json">{"datePublished":"2024-02-01"}</script>';

  assert.equal(extractIcmsDetail(detail + time, jsonLd + meta).publishedAt, '2024-02-01T00:00:00.000Z');
  assert.equal(extractIcmsDetail(detail + time, meta).publishedAt, '2024-02-02T00:00:00.000Z');
  assert.equal(extractIcmsDetail(detail + time).publishedAt, '2024-02-03T00:00:00.000Z');
});

test('rejects invalid, incomplete or ambiguous iCMS publication dates', () => {
  for (const date of ['29. Februar 2023', '7. Dez. 2024', '7. Unbekannt 2024', 'Stand: 7. März 2024']) {
    assert.equal(extractIcmsDetail(icmsDate(date)).publishedAt, '', date);
  }
  assert.equal(extractIcmsDetail(icmsDate('7. März 2024') + icmsDate('8. März 2024')).publishedAt, '');
});

test('ignores inactive iCMS dates even when they coexist with a visible date', () => {
  const date = icmsDate('7. März 2024');
  for (const wrapper of ['nav', 'aside', 'footer', 'template', 'noscript', 'section hidden', 'section aria-hidden="true"']) {
    const inactive = `<${wrapper}>${date}</${wrapper.split(' ')[0]}>`;
    assert.equal(extractIcmsDetail(inactive).publishedAt, '', wrapper);
    assert.equal(extractIcmsDetail(inactive + icmsDate('8. März 2024')).publishedAt, '2024-03-08T00:00:00.000Z', wrapper);
  }
});

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
