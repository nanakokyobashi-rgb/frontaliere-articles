import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  headState,
  parseRetryAfter,
  parseStrictRetryAfterValue,
  reconcile,
  remainingBudgetMs,
  RECONCILE_FETCH_MAX_RETRY_AFTER_MS,
  landingArticleCoverage,
} from '../../scripts/reconcile-section-pages.mjs';

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

test('parseRetryAfter: accetta delta-secondes e data HTTP, con cap bounded', () => {
  const now = Date.parse('2026-10-25T08:00:00Z');
  const response = (value) => ({ headers: { get: () => value } });

  assert.equal(parseRetryAfter(response('7'), now), 7_000);
  assert.equal(parseRetryAfter(response('Sun, 25 Oct 2026 08:00:30 GMT'), now), 30_000);
  assert.equal(parseRetryAfter(response('Sun, 25 Oct 2026 07:59:59 GMT'), now), 0);
  assert.equal(parseRetryAfter(response('not-a-delay'), now), null);
  assert.equal(parseRetryAfter(response('86400'), now), RECONCILE_FETCH_MAX_RETRY_AFTER_MS);
  assert.equal(parseStrictRetryAfterValue('10/25/2026', now), null);
  assert.equal(parseStrictRetryAfterValue('Mon, 25 Oct 2026 08:00:30 GMT', now), null);
  assert.equal(parseStrictRetryAfterValue('9'.repeat(100), now), null);
});

test('remainingBudgetMs: il budget condiviso non diventa negativo', () => {
  assert.equal(remainingBudgetMs(1_000, () => 750), 250);
  assert.equal(remainingBudgetMs(1_000, () => 1_250), 0);
});

test('remainingBudgetMs: tronca in modo conservativo clock frazionari', () => {
  assert.equal(remainingBudgetMs(1_000.9, () => 750.4), 250);
  assert.equal(remainingBudgetMs(1_000.1, () => 1_000.2), 0);
});

test('reconcile: rifiuta un budget frazionario', async () => {
  await assert.rejects(
    () => reconcile({ budgetMs: 0.5 }),
    /budgetMs deve essere una durata positiva intera finita/u,
  );
});

test('headState: rispetta Retry-After anche nel retry delle probe HEAD', async () => {
  const sleeps = [];
  let attempts = 0;
  const state = await headState('https://cdn.test/page', async () => {
    attempts++;
    return {
      ok: false,
      status: 503,
      headers: { get: (name) => (name === 'retry-after' ? '7' : null) },
    };
  }, { retryDelayMs: 0, sleepImpl: async (ms) => sleeps.push(ms) });

  assert.equal(state, 'unknown');
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [7_000]);
});

test('headState: propaga Retry-After di HEAD 405 al GET di fallback', async () => {
  const sleeps = [];
  const methods = [];
  const state = await headState('https://cdn.test/page', async (_url, options) => {
    methods.push(options.method);
    if (options.method === 'HEAD') {
      return {
        ok: false,
        status: 405,
        headers: { get: (name) => (name === 'retry-after' ? '7' : null) },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
    };
  }, { retryDelayMs: 0, sleepImpl: async (ms) => sleeps.push(ms) });

  assert.equal(state, 'present');
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.deepEqual(sleeps, [7_000]);
});

test('headState: attende Retry-After di HEAD 405 anche nel secondo tentativo', async () => {
  const sleeps = [];
  const methods = [];
  let headAttempts = 0;
  const state = await headState('https://cdn.test/page', async (_url, options) => {
    methods.push(options.method);
    if (options.method === 'HEAD') {
      headAttempts++;
      if (headAttempts === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: () => '0' },
        };
      }
      return {
        ok: false,
        status: 405,
        headers: { get: (name) => (name === 'retry-after' ? '7' : null) },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
    };
  }, { retryDelayMs: 0, sleepImpl: async (ms) => sleeps.push(ms) });

  assert.equal(state, 'present');
  assert.deepEqual(methods, ['HEAD', 'HEAD', 'GET']);
  assert.deepEqual(sleeps, [7_000]);
});

function fakeFetch({
  sitemap = '503',
  sitemapXml,
  cantonArticles = [],
  cantonSlugs = {},
  landingHtml = '<script type="application/ld+json">{"numberOfItems":0}</script>',
} = {}) {
  const docs = {
    'manifest.json': { commit: 'abc1234' },
    'sections.json': { commit: 'abc1234', sections: [CATALOG] },
    'slugs.json': { commit: 'abc1234', cantons: { 'canton-ti': cantonSlugs } },
    'canton-articles.json': cantonArticles,
  };
  const edgeRegistry = { schema: 1, commit: 'abc1234', sections: { 'canton-ti': { status: 'live' } } };

  return async (url) => {
    const clean = url.replace(/\?.*$/, '');
    if (clean.endsWith('/edge/sections/registry.json')) {
      return { ok: true, status: 200, json: async () => edgeRegistry };
    }
    if (clean.endsWith(CATALOG.sitemap)) {
      if (sitemapXml !== undefined) {
        return { ok: true, status: 200, text: async () => sitemapXml };
      }
      if (sitemap instanceof Error) throw sitemap;
      return { ok: false, status: Number(sitemap), text: async () => '' };
    }
    if (Object.values(CATALOG.paths).some((sectionPath) => clean.endsWith(`/edge/sections${sectionPath}index.html`))) {
      return { ok: true, status: 200, text: async () => landingHtml };
    }
    const name = clean.split('/').pop();
    return { ok: true, status: 200, json: async () => docs[name] };
  };
}

test('landingArticleCoverage: riconosce gli articoli mancanti anche se il file HTML esiste', () => {
  const rows = [{ id: 'article-one' }, { id: 'article-two' }];
  const slugs = {
    'article-one': { it: 'article-one' },
    'article-two': { it: 'article-two' },
  };
  const coverage = landingArticleCoverage({
    entry: CATALOG,
    rows,
    slugs,
    locale: 'it',
    html: '<script type="application/ld+json">{"numberOfItems":1}</script>' +
      '<a href="https://frontaliereticino.ch/articoli-ticino/article-one/">uno</a>',
  });

  assert.deepEqual(coverage.missingIds, ['article-two']);
  assert.equal(coverage.expectedCount, 2);
  assert.equal(coverage.foundCount, 1);
  assert.equal(coverage.declaredCount, 1);
  assert.deepEqual(coverage.problems, ['missing-articles:article-two', 'numberOfItems:1/2']);
});

test('landingArticleCoverage: usa le 24 card piu recenti, non tutte le righe API', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `article-${index}`,
    date: `2026-10-${String(25 - index).padStart(2, '0')}T00:00:00Z`,
  }));
  const slugs = Object.fromEntries(rows.map((row) => [row.id, { it: row.id }]));
  const html = '<script type="application/ld+json">{"numberOfItems":24}</script>' +
    rows.slice(0, 24).map((row) => `<a href="/articoli-ticino/${row.id}/">articolo</a>`).join('');

  const coverage = landingArticleCoverage({
    entry: CATALOG,
    rows,
    slugs,
    locale: 'it',
    html,
  });

  assert.equal(coverage.expectedCount, 24);
  assert.equal(coverage.foundCount, 24);
  assert.equal(coverage.declaredCount, 24);
  assert.deepEqual(coverage.problems, []);
});

test('landingArticleCoverage: rifiuta una card nota oltre il limite della landing', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `article-${index}`,
    date: `2026-10-${String(25 - index).padStart(2, '0')}T00:00:00Z`,
  }));
  const slugs = Object.fromEntries(rows.map((row) => [row.id, { it: row.id }]));
  const links = rows.map((row) => `<a href="/articoli-ticino/${row.id}/">articolo</a>`).join('');

  const coverage = landingArticleCoverage({
    entry: CATALOG,
    rows,
    slugs,
    locale: 'it',
    html: `<script type="application/ld+json">{"numberOfItems":24}</script>${links}`,
  });

  assert.deepEqual(coverage.extraIds, ['article-24']);
  assert.deepEqual(coverage.problems, ['extra-articles:article-24']);
});

test('landingArticleCoverage: usa l id quando manca lo slug della locale', () => {
  const coverage = landingArticleCoverage({
    entry: CATALOG,
    rows: [{ id: 'article-one', date: '2026-10-28T00:00:00Z' }],
    slugs: {},
    locale: 'it',
    html: '<script type="application/ld+json">{"numberOfItems":1}</script>' +
      '<a href="/articoli-ticino/article-one/">articolo</a>',
  });

  assert.equal(coverage.foundCount, 1);
  assert.deepEqual(coverage.problems, []);
});

test('landingArticleCoverage: un numero dichiarato mancante rende la landing non verificata', () => {
  const coverage = landingArticleCoverage({
    entry: CATALOG,
    rows: [{ id: 'article-one', date: '2026-10-28T00:00:00Z' }],
    slugs: { 'article-one': { it: 'article-one' } },
    locale: 'it',
    html: '<a href="/articoli-ticino/article-one/">articolo</a>',
  });

  assert.equal(coverage.foundCount, 1);
  assert.deepEqual(coverage.problems, ['numberOfItems:missing/1']);
});

test('reconcile: una landing stale dispatcha il refresh della sezione anche con dettagli presenti', async () => {
  const rows = [{ id: 'article-one', section: 'canton-ti', date: '2026-10-28T10:00:00Z' }];
  const slugs = { 'article-one': { it: 'article-one', en: 'article-one-en', de: 'article-one-de', fr: 'article-one-fr' } };
  const sitemapXml = [
    '<urlset>',
    '  <url><loc>https://frontaliereticino.ch/articoli-ticino/</loc></url>',
    '  <url><loc>https://frontaliereticino.ch/articoli-ticino/article-one/</loc></url>',
    '</urlset>',
  ].join('');
  const report = await reconcile({
    fetchImpl: fakeFetch({
      sitemapXml,
      cantonArticles: rows,
      cantonSlugs: slugs,
      landingHtml: '<script type="application/ld+json">{"numberOfItems":0}</script>',
    }),
    retryDelayMs: 0,
    sleepImpl: async () => {},
  });

  const section = report.sections[0];
  assert.equal(section.dispatch, true);
  assert.deepEqual(section.selected, []);
  assert.deepEqual(section.sectionMissing, [
    '/articoli-ticino/',
    '/en/ticino-articles/',
    '/de/tessin-artikel/',
    '/fr/articles-tessin/',
  ]);
  assert.deepEqual(section.missingPagePaths, section.sectionMissing);
  assert.equal(section.landingContent[0].state, 'invalid');
  assert.deepEqual(section.landingContent[0].missingIds, ['article-one']);
});

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

test('reconcile: ritenta una fetch di superficie fallita e poi continua', async () => {
  const baseFetch = fakeFetch({ sitemap: '503' });
  let manifestAttempts = 0;
  const fetchImpl = async (url, options) => {
    if (url.replace(/\?.*$/, '').endsWith('/manifest.json')) {
      manifestAttempts++;
      if (manifestAttempts === 1) throw new Error('fetch failed: transient network error');
    }
    return baseFetch(url, options);
  };

  const report = await reconcile({ apiBase: API_BASE, fetchImpl, retryDelayMs: 0 });

  assert.equal(manifestAttempts, 2);
  assert.equal(report.skipped, null);
  assert.equal(report.sections[0].dispatch, false);
});

test('reconcile: ritenta una sitemap 5xx ma non cambia il piano prudente', async () => {
  const sitemapXml = '<urlset><url><loc>https://frontaliereticino.ch/articoli-ticino/</loc></url></urlset>';
  const baseFetch = fakeFetch({ sitemapXml });
  let sitemapAttempts = 0;
  const sleeps = [];
  const fetchImpl = async (url, options) => {
    if (url.replace(/\?.*$/, '').endsWith(CATALOG.sitemap)) {
      sitemapAttempts++;
      if (sitemapAttempts === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: (name) => (name === 'retry-after' ? '7' : null) },
          text: async () => '',
        };
      }
    }
    return baseFetch(url, options);
  };

  const report = await reconcile({ apiBase: API_BASE, fetchImpl, retryDelayMs: 0, sleepImpl: async (ms) => sleeps.push(ms) });

  assert.equal(sitemapAttempts, 2);
  assert.deepEqual(sleeps, [7_000]);
  assert.equal(report.sections[0].expected, 1);
  assert.equal(report.sections[0].dispatch, false);
});

test('reconcile: i retry delle fetch iniziali consumano un budget condiviso', async () => {
  let clock = 1_000;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.replace(/\?.*$/, ''));
    return {
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => '',
    };
  };

  await assert.rejects(
    () => reconcile({
      apiBase: API_BASE,
      fetchImpl,
      retryDelayMs: 100,
      budgetMs: 50,
      now: () => clock,
      sleepImpl: async (ms) => { clock += ms; },
    }),
    /budget wall-clock del reconcile esaurito/u,
  );
  assert.equal(calls.length, 5, 'il primo giro usa il budget comune, non 3 retry per ogni documento');
});

test('reconcile: sitemap e slugs incoerenti non fanno fallire il run e non dispatchano', async () => {
  const sitemapXml = [
    '<urlset>',
    '  <url><loc>https://frontaliereticino.ch/articoli-ticino/retired-not-in-slugs/</loc></url>',
    '</urlset>',
  ].join('');
  const report = await reconcile({
    apiBase: API_BASE,
    fetchImpl: fakeFetch({ sitemapXml }),
  });

  assert.equal(report.skipped, null);
  assert.equal(report.sections.length, 1);
  assert.equal(report.sections[0].dispatch, false);
  assert.equal(report.sections[0].expected, null);
  assert.match(report.sections[0].unknown[0], /URL articolo \/articoli-ticino\/retired-not-in-slugs\/ non compare in slugs\.json\.cantons/);
  assert.equal(report.sections[0].pageManifest, 'unknown');
});
