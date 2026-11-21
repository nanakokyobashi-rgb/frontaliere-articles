import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  headState,
  parseRetryAfter,
  parseStrictRetryAfterValue,
  reconcile,
  remainingBudgetMs,
  RECONCILE_FETCH_MAX_RETRY_AFTER_MS,
  landingArticleCoverage,
  countRenderableCantonLandingRows,
  cdnUrlFor,
} from '../../scripts/reconcile-section-pages.mjs';
import {
  parseCantonLandingCardLimitExport,
  resolveCantonLandingCardLimit,
} from '../../scripts/lib/canton-landing-card-limit.mjs';

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

test('il parser del cap rifiuta dichiarazioni duplicate e l override condivide la guardia', () => {
  assert.equal(parseCantonLandingCardLimitExport('export const CANTON_LANDING_CARD_LIMIT = 24;\n'), 24);
  assert.throws(
    () => parseCantonLandingCardLimitExport(
      'export const CANTON_LANDING_CARD_LIMIT = 24;\nexport const CANTON_LANDING_CARD_LIMIT = 25;\n',
    ),
    /duplicato/u,
  );
  assert.equal(resolveCantonLandingCardLimit(12, 24), 12);
  assert.equal(resolveCantonLandingCardLimit(undefined, 24), 24);
  assert.throws(() => resolveCantonLandingCardLimit(0, 24), /limite landing non valido/u);
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
  candidateCommit = 'abc1234',
  servedCommit = candidateCommit,
  pageStatuses = {},
} = {}) {
  const docs = {
    'manifest.json': { commit: candidateCommit },
    'sections.json': { commit: candidateCommit, sections: [CATALOG] },
    'slugs.json': { commit: candidateCommit, cantons: { 'canton-ti': cantonSlugs } },
    'canton-articles.json': cantonArticles,
  };
  const edgeRegistry = { schema: 1, sections: { 'canton-ti': { status: 'live' } } };

  return async (url) => {
    const clean = url.replace(/\?.*$/, '');
    if (clean.endsWith('/edge/sections/registry.json')) {
      const commit = clean.startsWith(`${API_BASE}/`) ? candidateCommit : servedCommit;
      return { ok: true, status: 200, json: async () => ({ ...edgeRegistry, commit }) };
    }
    if (clean.endsWith(CATALOG.sitemap)) {
      if (sitemapXml !== undefined) {
        return { ok: true, status: 200, text: async () => sitemapXml };
      }
      if (sitemap instanceof Error) throw sitemap;
      return { ok: false, status: Number(sitemap), text: async () => '' };
    }
    const status = pageStatuses[clean];
    if (status !== undefined) return { ok: status === 200, status };
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

test('countRenderableCantonLandingRows: il fallback conta solo le righe renderizzabili', () => {
  assert.equal(countRenderableCantonLandingRows({
    rows: [{ id: 'missing-slug' }, { id: 'empty-slug' }, { id: 'valid' }, {}],
    slugs: {
      'missing-slug': { it: '' },
      'empty-slug': { it: null },
      valid: { it: 'valid' },
    },
    locale: 'it',
    limit: 24,
  }), 2);
});

test('landingArticleCoverage: un override esplicito allinea expected count e card extra', () => {
  const rows = [
    { id: 'newest', date: '2026-10-29T00:00:00Z' },
    { id: 'older', date: '2026-10-28T00:00:00Z' },
  ];
  const slugs = Object.fromEntries(rows.map((row) => [row.id, { it: row.id }]));
  const coverage = landingArticleCoverage({
    entry: CATALOG,
    rows,
    slugs,
    locale: 'it',
    limit: 1,
    html: '<script type="application/ld+json">{"numberOfItems":1}</script>'
      + '<a href="/articoli-ticino/newest/">nuovo</a>'
      + '<a href="/articoli-ticino/older/">vecchio</a>',
  });

  assert.equal(coverage.expectedCount, 1);
  assert.deepEqual(coverage.extraIds, ['older']);
  assert.deepEqual(coverage.problems, ['extra-articles:older']);
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

test('reconcile: diagnosi e backfill delle landing prima e dopo il flip', async (t) => {
  const rows = [{ id: 'article-one', section: 'canton-ti', date: '2026-10-28T10:00:00Z' }];
  const slugs = { 'article-one': { it: 'article-one', en: 'article-one-en', de: 'article-one-de', fr: 'article-one-fr' } };
  const sitemapXml = [
    '<urlset>',
    '  <url><loc>https://frontaliereticino.ch/articoli-ticino/</loc></url>',
    '  <url><loc>https://frontaliereticino.ch/articoli-ticino/article-one/</loc></url>',
    '</urlset>',
  ].join('');
  const fixture = {
    sitemapXml,
    cantonArticles: rows,
    cantonSlugs: slugs,
    landingHtml: '<script type="application/ld+json">{"numberOfItems":0}</script>',
  };
  const fetchImpl = fakeFetch(fixture);
  const probe = (options) => reconcile({ apiBase: API_BASE, retryDelayMs: 0, ...options });
  const servedCommit = 'def5678';
  const pendingFetch = fakeFetch({ ...fixture, servedCommit });
  for (const [name, pendingEdgeFlip, options] of [
    ['registri allineati con opt-in', false, { fetchImpl, deferExistingLandingsUntilFlip: true }],
    ['flip pendente senza opt-in', true, { fetchImpl: pendingFetch }],
  ]) {
    await t.test(name, async () => {
      const report = await probe(options);
      const section = report.sections[0];
      assert.equal(report.pendingEdgeFlip, pendingEdgeFlip);
      assert.equal(Object.hasOwn(report, 'landingContentDeferred'), false);
      assert.equal(section.dispatch, true);
      assert.deepEqual(section.selected, []);
      assert.deepEqual(section.sectionMissing, Object.values(CATALOG.paths));
      assert.deepEqual(section.missingPagePaths, section.sectionMissing);
      assert.equal(section.landingContent[0].state, 'invalid');
      assert.deepEqual(section.landingContent[0].missingIds, ['article-one']);
    });
  }

  const readiness = await probe({
    fetchImpl: pendingFetch, checkLandingContent: false, deferExistingLandingsUntilFlip: true,
  });
  assert.equal(Object.hasOwn(readiness, 'landingContentDeferred'), false);
  assert.deepEqual(readiness.sections[0].expectedMissingPagePaths, []);

  const missingLanding = CATALOG.paths.fr;
  const incomplete = await probe({
    checkLandingContent: false,
    fetchImpl: fakeFetch({ ...fixture, pageStatuses: { [cdnUrlFor(missingLanding)]: 404 } }),
  });
  assert.deepEqual(incomplete.sections[0].expectedMissingPagePaths, [missingLanding]);

  await t.test('flip pendente con opt-in e tutte le pagine presenti', async () => {
    const report = await probe({ fetchImpl: pendingFetch, deferExistingLandingsUntilFlip: true });
    assert.equal(report.pendingEdgeFlip, true);
    assert.equal(report.landingContentDeferred, true);
    assert.equal(report.sections[0].dispatch, false);
    assert.deepEqual(report.sections[0].landingContent, []);
    assert.deepEqual(report.sections[0].expectedMissingPagePaths, []);
  });

  await t.test('flip pendente con opt-in, 404 e verifiche inconcludenti', async () => {
    const missingArticle = '/articoli-ticino/article-one/';
    const unknownLanding = CATALOG.paths.de;
    const report = await probe({
      deferExistingLandingsUntilFlip: true,
      fetchImpl: fakeFetch({
        ...fixture,
        servedCommit,
        pageStatuses: {
          [cdnUrlFor(missingLanding)]: 404,
          [cdnUrlFor(missingArticle)]: 404,
          [cdnUrlFor(unknownLanding)]: 503,
        },
      }),
    });
    const section = report.sections[0];
    assert.equal(report.landingContentDeferred, true);
    assert.equal(section.dispatch, true);
    assert.deepEqual(section.sectionMissing, [missingLanding]);
    assert.deepEqual(section.selected, ['article-one']);
    assert.deepEqual(section.expectedMissingPagePaths.toSorted(), [missingArticle, missingLanding].toSorted());
    assert.deepEqual(section.unknown, [unknownLanding]);
    assert.equal(section.pageManifest, 'unknown');
  });
});

test('il workflow rinvia la verifica del contenuto in detection e nella prova post-backfill', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/reconcile-section-pages.yml', import.meta.url), 'utf8');
  const commands = workflow.replace(/\\\n\s*/g, ' ').match(/^\s*node scripts\/reconcile-section-pages\.mjs .*$/gm) ?? [];
  assert.equal(commands.length, 2);
  assert.match(commands[0], /--out "\$RUNNER_TEMP\/reconcile-sections\.json".* --defer-existing-landings-until-flip(?:\s|$)/);
  assert.match(commands[1], /--out "\$verified".* --defer-existing-landings-until-flip(?:\s|$)/);
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
