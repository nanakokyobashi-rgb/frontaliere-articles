import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from '../../scripts/reconcile-section-pages.mjs';

const API_BASE = 'https://api.test';
const CATALOG = {
  id: 'canton-ti',
  paths: {
    it: '/articoli-ticino/',
    en: '/en/ticino-articles/',
    de: '/de/tessin-artikel/',
    fr: '/fr/articles-tessin/',
  },
  sitemap: '/sitemap-articles-canton-ti.xml',
};

function fakeFetch({ sitemap = '503' } = {}) {
  const docs = {
    'manifest.json': { commit: 'abc1234' },
    'sections.json': { commit: 'abc1234', sections: [CATALOG] },
    'slugs.json': { commit: 'abc1234', cantons: { 'canton-ti': {} } },
    'canton-articles.json': [],
  };
  const edgeRegistry = { schema: 1, commit: 'abc1234', sections: { 'canton-ti': { status: 'live' } } };

  return async (url) => {
    const clean = url.replace(/\?.*$/, '');
    if (clean.endsWith('/edge/sections/registry.json')) {
      return { ok: true, status: 200, json: async () => edgeRegistry };
    }
    if (clean.endsWith(CATALOG.sitemap)) {
      if (sitemap instanceof Error) throw sitemap;
      return { ok: false, status: Number(sitemap), text: async () => '' };
    }
    const name = clean.split('/').pop();
    return { ok: true, status: 200, json: async () => docs[name] };
  };
}

test('reconcile: una sitemap HTTP non verificabile non fallisce il run e non dispatcha', async () => {
  const report = await reconcile({ apiBase: API_BASE, fetchImpl: fakeFetch({ sitemap: '503' }) });

  assert.equal(report.skipped, null);
  assert.deepEqual(report.sections, [{
    section: 'canton-ti',
    expected: null,
    unknown: [`${API_BASE}${CATALOG.sitemap}: HTTP 503`],
    sectionMissing: [],
    orphaned: [],
    orphanedIds: [],
    orphanedUnknown: [],
    pageManifest: 'unknown',
    pageManifestReason: `${API_BASE}${CATALOG.sitemap}: HTTP 503`,
    missingIds: [],
    selected: [],
    leftover: [],
    dispatch: false,
  }]);
});

test('reconcile: timeout della sitemap e non verificabile allo stesso modo', async () => {
  const report = await reconcile({
    apiBase: API_BASE,
    fetchImpl: fakeFetch({ sitemap: new Error('fetch failed: timeout') }),
  });

  assert.equal(report.sections[0].dispatch, false);
  assert.deepEqual(report.sections[0].missingIds, []);
  assert.deepEqual(report.sections[0].unknown, [`${API_BASE}${CATALOG.sitemap}: fetch failed: timeout`]);
});
