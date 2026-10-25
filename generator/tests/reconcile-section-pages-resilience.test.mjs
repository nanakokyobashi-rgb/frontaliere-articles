import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  headState,
  parseRetryAfter,
  reconcile,
  remainingBudgetMs,
  RECONCILE_FETCH_MAX_RETRY_AFTER_MS,
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
});

test('remainingBudgetMs: il budget condiviso non diventa negativo', () => {
  assert.equal(remainingBudgetMs(1_000, () => 750), 250);
  assert.equal(remainingBudgetMs(1_000, () => 1_250), 0);
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

function fakeFetch({ sitemap = '503', sitemapXml } = {}) {
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
      if (sitemapXml !== undefined) {
        return { ok: true, status: 200, text: async () => sitemapXml };
      }
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
