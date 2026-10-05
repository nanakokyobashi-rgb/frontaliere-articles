import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isArticleNewsEligible, NEWS_SITEMAP_WINDOW_HOURS } from '../data/news-sitemap-whitelist.mjs';
import { xmlEsc, SITE } from '../../scripts/lib/build-sitemap.mjs';
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

function render(entries, clock) {
  const outputs = new Map();
  const slugMap = Object.fromEntries(entries.map(a => [a.id, Object.fromEntries(locales.map(l => [l, `fisco-${a.id}`]))]));
  class Clock extends Date { static now() { return Date.parse(clock); } }
  const context = {
    Date: Clock, RSS_SECTIONS: [], ROOT: '/', OUT: '/out', path,
    fs: { writeFileSync: (p, body) => outputs.set(p, body) },
    // Le sezioni vengono dal core (C1): il blocco itera API_SECTIONS e legge
    // registro, mappa slug, meta IT e ombre per id di sezione.
    API_SECTIONS: [{ section: 'frontaliere' }, { section: 'svizzera' }],
    SECTION_REGISTRIES: { frontaliere: entries, svizzera: [] },
    slugMapOf: (section) => (section === 'frontaliere' ? slugMap : {}),
    SECTION_META_IT: { frontaliere: {}, svizzera: {} },
    SECTION_SITEMAP_SHADOW: { frontaliere: new Set(), svizzera: new Set() },
    SECTION_PATHS: { frontaliere: Object.fromEntries(locales.map(l => [l, `/${l}/news/`])), svizzera: {} },
    SITE, LOCALES: locales, NEWS_CANDIDATES: 'news.xml', isArticleNewsEligible,
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
  assert.equal((first.match(/<url>/g) || []).length, 2);
  assert.equal((first.match(new RegExp(`<lastmod>${published}</lastmod>`, 'g')) || []).length, 2);
});

test('editorial update changes only its article and preserves publication date', () => {
  const before = render(fixtures, '2026-10-03T18:00:00Z');
  const updated = '2026-10-03T09:00:00.000Z';
  const after = render([{ ...fixtures[0], updatedAt: updated }, fixtures[1]], '2026-10-03T18:00:00Z');
  assert.equal(after, before.replace(`<lastmod>${published}</lastmod>`, `<lastmod>${updated}</lastmod>`));
  assert.equal((after.match(/<news:publication_date>/g) || []).length, 2);
  assert.ok(after.includes(`<news:publication_date>${published}</news:publication_date>`));
});

test('unknown publication cannot acquire a synthetic news date from the build clock', () => {
  const xml = render([{ id: 'unknown', date: '', updatedAt: published }], '2026-10-03T18:00:00Z');
  assert.equal((xml.match(/<url>/g) || []).length, 0);
  assert.doesNotMatch(xml, /<lastmod>|<news:publication_date>/);
});
