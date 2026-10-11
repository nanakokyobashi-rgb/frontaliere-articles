import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSitemap } from '../../scripts/lib/build-sitemap.mjs';
import { readTopLevelString, scanTopLevelArticleRecords } from '../../scripts/lib/article-registry-reader.mjs';

const registry = fs.readFileSync(new URL('../../content/blog-articles-data.ts', import.meta.url), 'utf8');
const seo = fs.readFileSync(new URL('../../content/seo/seo-blog.ts', import.meta.url), 'utf8');
const ids = ['stop-ristorni-tassa-salute', 'smood-chiusura-impatto-lavoro'];
const locales = ['it', 'en', 'de', 'fr'];

for (const id of ids) {
  test(`${id}: unknown source date stays absent from SEO and sitemap without removing the URL`, () => {
    const record = scanTopLevelArticleRecords(registry).find((entry) => entry.id === id);
    assert.ok(record, 'registry entry exists');
    const date = readTopLevelString(record, 'date');
    assert.equal(date, '', 'contradictory publication date represented as unknown');
    assert.equal(record.properties.has('updatedAt'), false, 'no undocumented replacement update');
    const seoStart = seo.indexOf(` 'blog-${id}': {`);
    const seoEnd = seo.indexOf("\n 'blog-", seoStart + 1);
    assert.ok(seoStart >= 0 && seoEnd > seoStart, 'SEO entry exists');
    const metadata = seo.slice(seoStart, seoEnd);
    assert.match(metadata, /"@type": "NewsArticle"/);
    assert.doesNotMatch(metadata, /"date(?:Published|Modified)"\s*:/);
    const slugMap = { [id]: Object.fromEntries(locales.map(locale => [locale, id])) };
    const { xml } = buildSitemap([{ id, date }], 'frontaliere', slugMap, {});
    assert.equal((xml.match(/<url>/g) || []).length, 1, 'URL remains discoverable');
    assert.equal((xml.match(/hreflang=/g) || []).length, 5, 'four locales and x-default remain');
    assert.doesNotMatch(xml, /<lastmod>/);
  });
}

test('documented dates remain available independently of the unknown historical entries', () => {
  const id = 'documented';
  const date = '2026-02-18T11:49:14.807Z';
  const updatedAt = '2026-04-24';
  const slugMap = { [id]: Object.fromEntries(locales.map(locale => [locale, id])) };
  assert.ok(buildSitemap([{ id, date }], 'frontaliere', slugMap, {}).xml.includes(`<lastmod>${date}</lastmod>`));
  assert.ok(buildSitemap([{ id, date, updatedAt }], 'frontaliere', slugMap, {}).xml.includes(`<lastmod>${updatedAt}</lastmod>`));
});
