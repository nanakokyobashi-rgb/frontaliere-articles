import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFamilySectionSitemap, SECTION_PATHS } from '../../scripts/lib/build-sitemap.mjs';
import { resolveStagedCantonSitemap, sitemapContainsUrls, sitemapUrls, waitForSitemapReadiness } from '../scripts/lib/canton-hubs/sitemap-readiness.mjs';

function publisherArtifact(section, status, sitemapFile, sitemapXml = null) {
  const edgeRegistryText = JSON.stringify({
    schema: 1,
    commit: '0123456789abcdef0123456789abcdef01234567',
    sections: { [section]: { status } },
  });
  const files = { 'edge/sections/registry.json': Buffer.byteLength(edgeRegistryText) };
  if (sitemapXml != null) files[sitemapFile] = Buffer.byteLength(sitemapXml);
  return {
    manifest: { schema: 1, commit: '0123456789abcdef0123456789abcdef01234567', files },
    edgeRegistryText,
  };
}

test('public sitemap readiness requires every affected canonical/alternate URL', () => {
  const sitemap = `<urlset>
    <url><loc>https://frontaliereticino.ch/articoli-frontaliere/esempio/</loc>
      <xhtml:link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/cross-border-articles/example/" />
    </url>
  </urlset>`;
  assert.deepEqual(sitemapContainsUrls(sitemap, [
    '/articoli-frontaliere/esempio/',
    '/en/cross-border-articles/example/',
  ]), { ready: true, missing: [] });
  assert.deepEqual(sitemapContainsUrls(sitemap, [
    '/articoli-frontaliere/esempio/',
    '/de/grenzgaenger-artikel/beispiel/',
  ]), {
    ready: false,
    missing: ['/de/grenzgaenger-artikel/beispiel/'],
  });
});

test('live expectations come from the publisher sitemap and honor withdrawn/fallback policy', () => {
  const section = 'canton-ti';
  const sitemapFile = `sitemap-articles-${section}.xml`;
  const slugMap = {
    published: { it: 'pub-it', en: 'pub-en', de: 'pub-de', fr: 'pub-fr' },
    withdrawn: { it: 'gone-it', en: 'gone-en', de: 'gone-de', fr: 'gone-fr' },
    fallback: { it: 'fallback-it', en: 'fallback-en', de: 'fallback-de', fr: 'fallback-fr' },
  };
  const built = buildFamilySectionSitemap({
    section,
    entries: Object.keys(slugMap).map((id) => ({ id })),
    slugMap,
    meta: {},
    pageSize: 20,
    shadowed: new Set(['gone-it']),
    fallbackReasons: { fallback: { de: 'provisional locale fallback' } },
  });
  const artifact = publisherArtifact(section, 'live', sitemapFile, built.xml);
  const staged = resolveStagedCantonSitemap({
    section,
    ...artifact,
    sitemapFile,
    sitemapXml: built.xml,
  });
  const expected = new Set(staged.urls);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.ok(expected.has(`${SECTION_PATHS[section][locale]}pub-${locale}/`));
    assert.ok(!expected.has(`${SECTION_PATHS[section][locale]}gone-${locale}/`));
  }
  for (const locale of ['it', 'en', 'fr']) {
    assert.ok(expected.has(`${SECTION_PATHS[section][locale]}fallback-${locale}/`));
  }
  assert.ok(!expected.has(`${SECTION_PATHS[section].de}fallback-de/`), 'fallback locale esclusa dalla sitemap canonica');
  assert.ok(sitemapContainsUrls(built.xml, staged.urls).ready);
  assert.ok(sitemapUrls(built.xml).length > 0);
});

test('draft sitemap is intentionally absent only when the publisher artifact says draft', () => {
  const section = 'canton-ti';
  const sitemapFile = `sitemap-articles-${section}.xml`;
  const artifact = publisherArtifact(section, 'draft', sitemapFile);
  const staged = resolveStagedCantonSitemap({
    section,
    ...artifact,
    sitemapFile,
    sitemapXml: null,
  });
  assert.deepEqual(staged, { section, status: 'draft', sitemapFile, urls: [] });

  assert.throws(() => resolveStagedCantonSitemap({
    section,
    ...publisherArtifact(section, 'draft', sitemapFile, '<urlset><url><loc>/draft/</loc></url></urlset>'),
    sitemapFile,
    sitemapXml: '<urlset><url><loc>/draft/</loc></url></urlset>',
  }), /draft ma l'artefatto include/);
});

test('a live publisher sitemap missing publicly stays fail-closed until timeout', async () => {
  const section = 'canton-ti';
  const sitemapFile = `sitemap-articles-${section}.xml`;
  const built = buildFamilySectionSitemap({
    section,
    entries: [{ id: 'new-public-article' }],
    slugMap: { 'new-public-article': { it: 'nuovo-it', en: 'new-en', de: 'neu-de', fr: 'nouveau-fr' } },
    meta: {},
    pageSize: 20,
  });
  const staged = resolveStagedCantonSitemap({
    section,
    ...publisherArtifact(section, 'live', sitemapFile, built.xml),
    sitemapFile,
    sitemapXml: built.xml,
  });
  let clock = 0;
  let probes = 0;
  await assert.rejects(
    waitForSitemapReadiness({
      timeoutMs: 2_500,
      intervalMs: 1_000,
      now: () => clock,
      sleep: async (duration) => { clock += duration; },
      probe: async () => {
        probes += 1;
        return sitemapContainsUrls('<urlset />', staged.urls);
      },
    }),
    /sitemap non pronta dopo 3 tentativi/,
  );
  assert.equal(probes, 3);
});

test('sitemap readiness waits for a positive public-link verification', async () => {
  let clock = 0;
  let probes = 0;
  const result = await waitForSitemapReadiness({
    timeoutMs: 5_000,
    intervalMs: 1_000,
    now: () => clock,
    sleep: async (duration) => { clock += duration; },
    probe: async () => {
      probes += 1;
      const snapshot = probes < 3 ? '<urlset />' : '<urlset><url><loc>https://frontaliereticino.ch/articoli-frontaliere/esempio/</loc></url></urlset>';
      return sitemapContainsUrls(snapshot, ['/articoli-frontaliere/esempio/']);
    },
  });

  assert.deepEqual(result, { attempts: 3, ready: true });
  assert.equal(probes, 3);
});

test('missing sitemap links fail closed when the bounded wait expires', async () => {
  let clock = 0;
  let probes = 0;
  await assert.rejects(
    waitForSitemapReadiness({
      timeoutMs: 2_500,
      intervalMs: 1_000,
      now: () => clock,
      sleep: async (duration) => { clock += duration; },
      probe: async () => {
        probes += 1;
        return { ready: false, reason: 'articolo nuovo assente dalla sitemap pubblica' };
      },
    }),
    /sitemap non pronta dopo 3 tentativi: articolo nuovo assente dalla sitemap pubblica/,
  );
  assert.equal(probes, 3);
  assert.equal(clock, 2_500);
});

test('network failures remain unready and are retried within the deadline', async () => {
  let clock = 0;
  let probes = 0;
  await assert.rejects(
    waitForSitemapReadiness({
      timeoutMs: 1_000,
      intervalMs: 500,
      now: () => clock,
      sleep: async (duration) => { clock += duration; },
      probe: async () => {
        probes += 1;
        throw new Error('HTTP 503');
      },
    }),
    /sitemap non pronta dopo 2 tentativi: HTTP 503/,
  );
  assert.equal(probes, 2);
});
