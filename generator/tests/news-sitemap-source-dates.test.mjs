import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isWithinNewsWindow, NEWS_SITEMAP_WINDOW_HOURS } from '../data/news-sitemap-whitelist.mjs';
import { xmlEsc, SITE, publishedArticleLocales } from '../../scripts/lib/build-sitemap.mjs';
import { isReservedPublishedSlug } from '../../scripts/lib/published-slug-guard.mjs';
import { sanitizeXmlDocument, assertNoControlChars } from '../../scripts/lib/sanitize-control-chars.mjs';

// Execute the actual news-emission block without loading the unrelated TS corpus
// or touching disk. Eligibility, escaping and XML sanitisation remain production code.
const source = fs.readFileSync(new URL('../../scripts/build-api.mjs', import.meta.url), 'utf8');
const start = source.indexOf('{\n  /**\n   * Per-article SEO text');
const end = source.indexOf('// ── Hero images', start);
assert.ok(start >= 0 && end > start, 'locate the production news emitter');
const emitter = source.slice(start, end);
const published = '2026-10-02T12:00:00.000Z';
const locales = ['it', 'en', 'de', 'fr'];

const titlesFor = (entries) => Object.fromEntries(
  locales.map(l => [l, Object.fromEntries(entries.map(a => [`blog.article.${a.id}.title`, `${l.toUpperCase()} headline ${a.id}`]))]),
);

function render(entries, clock, { meta = titlesFor(entries), slugPrefix = 'fisco' } = {}) {
  const outputs = new Map();
  const slugMap = Object.fromEntries(entries.map(a => [a.id, Object.fromEntries(locales.map(l => [l, `${slugPrefix}-${a.id}-${l}`]))]));
  class Clock extends Date { static now() { return Date.parse(clock); } }
  const context = {
    Date: Clock, RSS_SECTIONS: [], ROOT: '/', OUT: '/out', path,
    fs: { writeFileSync: (p, body) => outputs.set(p, body) },
    // Le sezioni vengono dal core (C1): il blocco itera API_SECTIONS e legge
    // registro, mappa slug, meta per locale e ombre per id di sezione.
    API_SECTIONS: [{ section: 'frontaliere' }, { section: 'svizzera' }],
    SECTION_REGISTRIES: { frontaliere: entries, svizzera: [] },
    slugMapOf: (section) => (section === 'frontaliere' ? slugMap : {}),
    SECTION_SLUG_MODULES: {
      frontaliere: { fallbackReasons: {} },
      svizzera: { fallbackReasons: {} },
    },
    SECTION_META_BY_LOCALE: { frontaliere: meta, svizzera: {} },
    SECTION_SITEMAP_SHADOW: { frontaliere: new Set(), svizzera: new Set() },
    SECTION_PATHS: { frontaliere: Object.fromEntries(locales.map(l => [l, `/${l}/news/`])), svizzera: {} },
    SITE, LOCALES: locales, NEWS_CANDIDATES: 'news.xml', isWithinNewsWindow, publishedArticleLocales,
    NEWS_SITEMAP_WINDOW_HOURS, isReservedPublishedSlug, xmlEsc, sanitizeXmlDocument, assertNoControlChars,
    reportStrippedControlChars() {}, byteSize: s => Buffer.byteLength(s), written: {}, newsCandidateCount: 0,
    console: { log() {} },
  };
  vm.runInNewContext(emitter, context, { timeout: 1000 });
  assert.ok(outputs.has('/out/news.xml'), 'emitter writes a sitemap');
  return outputs.get('/out/news.xml');
}

const fixtures = [{ id: 'one', date: published }, { id: 'two', date: published }];
test('unchanged news content keeps identical sitemap dates across build days', () => {
  const first = render(fixtures, '2026-10-02T18:00:00Z');
  const second = render(fixtures, '2026-10-03T18:00:00Z');
  assert.equal(first, second);
  // Two articles x four published locale pages.
  assert.equal((first.match(/<url>/g) || []).length, 8);
  assert.equal((first.match(new RegExp(`<lastmod>${published}</lastmod>`, 'g')) || []).length, 8);
});

test('editorial update changes only its article and preserves publication date', () => {
  const before = render(fixtures, '2026-10-03T18:00:00Z');
  const updated = '2026-10-03T09:00:00.000Z';
  const after = render([{ ...fixtures[0], updatedAt: updated }, fixtures[1]], '2026-10-03T18:00:00Z');
  // The updated article's four locale blocks come first (registry order).
  let expected = before;
  for (let i = 0; i < locales.length; i++) {
    expected = expected.replace(`<lastmod>${published}</lastmod>`, `<lastmod>${updated}</lastmod>`);
  }
  assert.equal(after, expected);
  assert.equal((after.match(/<news:publication_date>/g) || []).length, 8);
  assert.ok(after.includes(`<news:publication_date>${published}</news:publication_date>`));
});

test('unknown publication cannot acquire a synthetic news date from the build clock', () => {
  const xml = render([{ id: 'unknown', date: '', updatedAt: published }], '2026-10-03T18:00:00Z');
  assert.equal((xml.match(/<url>/g) || []).length, 0);
  assert.doesNotMatch(xml, /<lastmod>|<news:publication_date>/);
});

test('every published locale page is its own Google News entry, in its own language', () => {
  const xml = render([{ id: 'one', date: published }], '2026-10-02T18:00:00Z');
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  assert.equal(blocks.length, 4);
  for (const l of locales) {
    const block = blocks.find(b => b.includes(`<loc>${SITE}/${l}/news/fisco-one-${l}/</loc>`));
    assert.ok(block, `no <url> for the ${l} page`);
    assert.match(block, new RegExp(`<news:language>${l}</news:language>`));
    assert.match(block, new RegExp(`<news:title>${l.toUpperCase()} headline one</news:title>`));
    // the alternates still name all four language versions plus x-default
    assert.equal((block.match(/xhtml:link rel="alternate"/g) || []).length, 5);
  }
});

test('topic does not gate the news sitemap: an off-whitelist article inside the window is listed', () => {
  const xml = render([{ id: 'hockey', date: published }], '2026-10-02T18:00:00Z', { slugPrefix: 'hockey-club-lugano-vittoria' });
  assert.equal((xml.match(/<url>/g) || []).length, 4);
});

test('the 48h window still applies, and a future date is refused', () => {
  assert.equal((render([{ id: 'old', date: published }], '2026-10-04T12:00:01Z').match(/<url>/g) || []).length, 0);
  assert.equal((render([{ id: 'future', date: published }], '2026-10-02T11:00:00Z').match(/<url>/g) || []).length, 0);
});

test('a locale without its own headline is skipped, never announced with an empty title', () => {
  const meta = titlesFor([{ id: 'one' }]);
  delete meta.de['blog.article.one.title'];
  const xml = render([{ id: 'one', date: published }], '2026-10-02T18:00:00Z', { meta });
  assert.equal((xml.match(/<url>/g) || []).length, 3);
  assert.doesNotMatch(xml, /<news:language>de<\/news:language>/);
  assert.doesNotMatch(xml, /<news:title><\/news:title>/);
});

test('a raw i18n title key is skipped, never announced as a Google News headline', () => {
  const meta = titlesFor([{ id: 'one' }]);
  meta.de['blog.article.one.title'] = 'blog.article.one.title';
  const xml = render([{ id: 'one', date: published }], '2026-10-02T18:00:00Z', { meta });
  assert.equal((xml.match(/<url>/g) || []).length, 3);
  assert.doesNotMatch(xml, /<news:language>de<\/news:language>/);
  assert.doesNotMatch(xml, /<news:title>blog\.article\.one\.title<\/news:title>/);
});
