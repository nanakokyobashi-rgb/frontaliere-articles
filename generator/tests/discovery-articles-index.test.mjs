import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDiscoveryArticleShadow,
  buildDiscoveryArticlesIndex,
  isSafeId,
  normalizeDiscoveryProvider,
  parseDiscoverySidecar,
  resolveExistingDiscoverySidecarPath,
  resolveDiscoverySidecarPath,
} from '../../scripts/lib/discovery-articles-index.mjs';
import { SECTION_PATHS } from '../../scripts/lib/build-sitemap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const paths = SECTION_PATHS.frontaliere;

function localeRows(entries = {}) {
  return Object.fromEntries(Object.entries(entries).map(([locale, rows]) => [locale, new Map(rows)]));
}

function publishedSection(overrides = {}) {
  const registry = [
    { id: 'trend-article', date: '2026-11-01' },
    { id: 'reddit-article', date: '2026-10-31' },
    { id: 'reddit-only-article', date: '2026-10-31' },
    { id: 'reddit-and-trends-article', date: '2026-10-31' },
    { id: 'news-only-article', date: '2026-10-30' },
    { id: 'no-attribution', date: '2026-10-29' },
    { id: 'fallback-locale', date: '2026-10-28' },
    { id: 'missing-excerpt', date: '2026-10-27' },
  ];
  const slugs = Object.fromEntries(registry.map(({ id }) => [id, {
    it: `${id}-it`,
    en: `${id}-en`,
    de: `${id}-de`,
    fr: `${id}-fr`,
  }]));
  const italian = new Map(registry.map(({ id }) => [id, { title: `Titolo ${id}`, excerpt: `Sintesi ${id}` }]));
  const english = new Map(registry.map(({ id }) => [id, { title: `Title ${id}`, excerpt: `Summary ${id}` }]));
  const german = new Map(registry.map(({ id }) => [id, { title: `Titel ${id}`, excerpt: `Zusammenfassung ${id}` }]));
  const french = new Map(registry.map(({ id }) => [id, { title: `Titre ${id}`, excerpt: `Résumé ${id}` }]));
  french.set('fallback-locale', {
    title: 'Titre fallback-locale avec\ncaractère de contrôle',
    excerpt: 'Résumé fallback-locale',
  });
  french.set('missing-excerpt', { title: 'Titre sans résumé' });

  return {
    name: 'frontaliere',
    registry,
    paths,
    slugMap: slugs,
    fallbackReasons: {
      'fallback-locale': { de: 'provisional fallback' },
    },
    metaByLocale: { it: italian, en: english, de: german, fr: french },
    sidecars: new Map([
      ['trend-article', {
        id: 'trend-article',
        publishedAt: '2026-11-01T09:15:00.000Z',
        _discovery_attribution: {
          candidateId: 'trend-topic-1',
          signalProvider: 'google-trends',
          signalHeadline: 'private trend query',
          evidenceUrl: 'https://publisher.example/private-story',
        },
      }],
      ['reddit-article', {
        id: 'reddit-article',
        publishedAt: '2026-10-31T09:15:00.000Z',
        _topic_candidate_attribution: {
          candidateId: 'a1b2c3d4',
          providers: ['reddit', 'google-news-rss'],
          redditPermalink: 'https://www.reddit.com/r/example/comments/abc123/private-title/',
          score: 0.91,
        },
      }],
      ['reddit-only-article', {
        id: 'reddit-only-article',
        publishedAt: '2026-10-31T08:15:00.000Z',
        _topic_candidate_attribution: {
          candidateId: 'fedcba98',
          providers: ['reddit'],
          score: 0.92,
        },
      }],
      ['reddit-and-trends-article', {
        id: 'reddit-and-trends-article',
        publishedAt: '2026-10-31T07:15:00.000Z',
        _discovery_attribution: {
          candidateId: 'trend-topic-3',
          signalProvider: 'google-trends',
        },
        _topic_candidate_attribution: {
          candidateId: 'abcdef12',
          providers: ['reddit', 'google-news-rss'],
        },
      }],
      ['news-only-article', {
        id: 'news-only-article',
        publishedAt: '2026-10-30T09:15:00.000Z',
        _topic_candidate_attribution: {
          candidateId: 'abcd1234',
          providers: ['google-news-rss'],
        },
      }],
      ['fallback-locale', {
        id: 'fallback-locale',
        publishedAt: '2026-10-28T09:15:00.000Z',
        _discovery_attribution: { candidateId: 'trend-topic-2', signalProvider: 'google-trends' },
      }],
      ['missing-excerpt', {
        id: 'missing-excerpt',
        publishedAt: '2026-10-27T09:15:00.000Z',
        _discovery_attribution: { candidateId: 'trend-topic-3', signalProvider: 'google-trends' },
      }],
    ]),
    ...overrides,
  };
}

describe('discovery article index projection', () => {
  test('includes only published, attributed articles with genuinely localized fields', () => {
    const payload = buildDiscoveryArticlesIndex({
      commit: 'a'.repeat(40),
      generatedAt: '2026-11-05T10:00:00.000Z',
      sections: [publishedSection()],
    });

    assert.equal(payload.schema, 1);
    assert.equal(payload.commit, 'a'.repeat(40));
    assert.equal(payload.count, 7);
    assert.deepEqual(payload.articles.map(({ id }) => id), [
      'trend-article',
      'reddit-article',
      'reddit-only-article',
      'reddit-and-trends-article',
      'news-only-article',
      'fallback-locale',
      'missing-excerpt',
    ]);

    const trend = payload.articles[0];
    assert.equal(trend.provider, 'google_trends');
    assert.deepEqual(Object.keys(trend).sort(), ['excerpt', 'id', 'provider', 'publishedAt', 'title', 'url']);
    assert.deepEqual(Object.keys(trend.title), ['it', 'en', 'de', 'fr']);
    assert.deepEqual(Object.keys(trend.excerpt), ['it', 'en', 'de', 'fr']);
    assert.deepEqual(Object.keys(trend.url), ['it', 'en', 'de', 'fr']);
    assert.equal(trend.url.it, 'https://frontaliereticino.ch/articoli-frontaliere/trend-article-it/');
    assert.deepEqual(payload.articles.slice(1, 5).map(({ provider }) => provider), [
      'other',
      'other',
      'google_trends',
      'google_news',
    ]);
    assert.equal(payload.articles.every(({ provider }) => ['google_trends', 'google_news', 'other'].includes(provider)), true);
    for (const field of ['title', 'excerpt', 'url']) {
      assert.deepEqual(Object.keys(payload.articles[5][field]), ['it', 'en']);
    }
    const missingExcerpt = payload.articles[6];
    for (const field of ['title', 'excerpt', 'url']) {
      assert.deepEqual(Object.keys(missingExcerpt[field]), ['it', 'en', 'de']);
    }

    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /private trend query|publisher\.example|reddit\.com|private-title|0\.91|0\.92|a1b2c3d4|fedcba98|abcdef12/);
  });

  test('requires the sidecar to belong to an article in the published registry', () => {
    const section = publishedSection();
    section.sidecars.set('not-published', {
      id: 'not-published',
      publishedAt: '2026-11-04T09:15:00.000Z',
      _discovery_attribution: { candidateId: 'trend-topic-4', signalProvider: 'google-trends' },
    });
    const payload = buildDiscoveryArticlesIndex({
      commit: 'b'.repeat(40),
      generatedAt: '2026-11-05T10:00:00.000Z',
      sections: [section],
    });
    assert.equal(payload.articles.some(({ id }) => id === 'not-published'), false);
  });

  test('accepts every non-empty registry id, including Unicode ids', () => {
    const id = 'articolo-é🚲';
    const section = publishedSection();
    section.registry.push({ id, date: '2026-11-02' });
    section.slugMap[id] = {
      it: 'articolo-e-bici',
      en: 'article-e-bike',
      de: 'artikel-e-fahrrad',
      fr: 'article-e-velo',
    };
    for (const [locale, title, excerpt] of [
      ['it', 'Titolo Unicode', 'Sintesi Unicode'],
      ['en', 'Unicode title', 'Unicode summary'],
      ['de', 'Unicode-Titel', 'Unicode-Zusammenfassung'],
      ['fr', 'Titre Unicode', 'Résumé Unicode'],
    ]) {
      section.metaByLocale[locale].set(id, { title, excerpt });
    }
    section.sidecars.set(id, {
      id,
      publishedAt: '2026-11-02T09:15:00.000Z',
      _discovery_attribution: { candidateId: 'trend-unicode', signalProvider: 'google-trends' },
    });

    assert.equal(isSafeId(id), true);
    assert.equal(isSafeId(''), false);
    const payload = buildDiscoveryArticlesIndex({
      commit: 'u'.repeat(40),
      generatedAt: '2026-11-05T10:00:00.000Z',
      sections: [section],
    });
    assert.equal(payload.articles.some((article) => article.id === id), true);
  });

  test('keeps Unicode sidecar IDs and rejects traversal or unsafe path forms', () => {
    const sidecarRoot = path.resolve('/tmp/discovery-sidecars');
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, 'änderung-arbeitsmarkt'), path.join(sidecarRoot, 'änderung-arbeitsmarkt.json'));
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, 'nested/änderung'), path.join(sidecarRoot, 'nested', 'änderung.json'));
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, 'nested/..'), path.join(sidecarRoot, 'nested', '...json'));
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, '../outside'), null);
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, 'nested/../outside'), null);
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, '..\\outside'), null);
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, 'nul\u0000byte'), null);
  });

  test('rejects sidecar symlinks that escape the repository or sidecar directory', () => {
    const tempRoot = fs.mkdtempSync(path.join('/tmp', 'discovery-sidecar-path-'));
    const repository = path.join(tempRoot, 'repository');
    const sidecarRoot = path.join(repository, 'content', 'discovery-attribution');
    const outsideRoot = path.join(tempRoot, 'outside');
    fs.mkdirSync(sidecarRoot, { recursive: true });
    fs.mkdirSync(outsideRoot);
    fs.writeFileSync(path.join(outsideRoot, 'article.json'), JSON.stringify({ id: 'nested/article' }));
    fs.symlinkSync(outsideRoot, path.join(sidecarRoot, 'nested'), 'dir');
    fs.symlinkSync(outsideRoot, path.join(repository, 'content', 'linked-sidecars'), 'dir');

    try {
      assert.throws(
        () => resolveExistingDiscoverySidecarPath(sidecarRoot, 'nested/article', repository),
        /resolves outside its directory/,
      );
      assert.throws(
        () => resolveExistingDiscoverySidecarPath(path.join(repository, 'content', 'linked-sidecars'), 'missing', repository),
        /resolves outside the repository/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects nested symlink escapes even when the sidecar file is absent', () => {
    const tempRoot = fs.mkdtempSync(path.join('/tmp', 'discovery-sidecar-missing-'));
    const repository = path.join(tempRoot, 'repository');
    const sidecarRoot = path.join(repository, 'content', 'discovery-attribution');
    const outsideRoot = path.join(tempRoot, 'outside');
    fs.mkdirSync(sidecarRoot, { recursive: true });
    fs.mkdirSync(outsideRoot);
    fs.symlinkSync(outsideRoot, path.join(sidecarRoot, 'nested'), 'dir');

    try {
      assert.throws(
        () => resolveExistingDiscoverySidecarPath(sidecarRoot, 'nested/missing', repository),
        /resolves outside its directory/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('excludes canonical shadows, retired editions, registry withdrawals and ledger rows', () => {
    const shadowed = buildDiscoveryArticleShadow({
      canonicalSlugs: ['trend-article-it'],
      retiredDailySlugs: ['reddit-article-it'],
      retiredRegistrySlugs: ['reddit-only-article-it'],
      excludedSlugs: ['news-only-article-it'],
    });
    const payload = buildDiscoveryArticlesIndex({
      commit: 'd'.repeat(40),
      generatedAt: '2026-11-05T10:00:00.000Z',
      sections: [publishedSection({ shadowed })],
    });

    assert.deepEqual(payload.articles.map(({ id }) => id), [
      'reddit-and-trends-article',
      'fallback-locale',
      'missing-excerpt',
    ]);
  });

  test('rejects a present sidecar with invalid JSON or a mismatched article id', () => {
    assert.throws(() => parseDiscoverySidecar('{', 'trend-article'), /invalid JSON/);
    assert.throws(
      () => parseDiscoverySidecar('{"id":"other-article"}', 'trend-article'),
      /expected an object whose id is trend-article/,
    );
    assert.deepEqual(parseDiscoverySidecar('{"id":"trend-article"}', 'trend-article'), {
      id: 'trend-article',
    });
  });

  test('normalizes known attribution and rejects malformed or unknown providers', () => {
    assert.equal(normalizeDiscoveryProvider({
      _discovery_attribution: { candidateId: 'trend-1', signalProvider: 'google-trends' },
    }), 'google_trends');
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: ['reddit'] },
    }), 'other');
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: ['reddit', 'google-news-rss'] },
    }), 'other');
    assert.equal(normalizeDiscoveryProvider({
      _discovery_attribution: { candidateId: 'trend-1', signalProvider: 'google-trends' },
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: ['reddit', 'google-news-rss'] },
    }), 'google_trends');
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: ['google-news-rss'] },
    }), 'google_news');
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: 'bad-id', providers: ['reddit'] },
    }), null);
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: ['unknown'] },
    }), null);
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: [] },
    }), null);
    assert.equal(normalizeDiscoveryProvider(null), null);
  });

  test('emits a valid empty index when no sidecar is eligible', () => {
    const section = publishedSection({ sidecars: new Map() });
    const payload = buildDiscoveryArticlesIndex({
      commit: 'c'.repeat(40),
      generatedAt: '2026-11-05T10:00:00.000Z',
      sections: [section],
    });
    assert.deepEqual(payload, {
      schema: 1,
      commit: 'c'.repeat(40),
      generatedAt: '2026-11-05T10:00:00.000Z',
      count: 0,
      articles: [],
    });
  });

  test('publisher watches sidecars and the projection helper', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
    const builder = fs.readFileSync(path.join(ROOT, 'scripts/build-blog-index.mjs'), 'utf8');
    assert.match(workflow, /'scripts\/lib\/discovery-articles-index\.mjs'/);
    assert.match(workflow, /'data\/blog-articles\/\*\*'/);
    assert.match(workflow, /'data\/swiss-articles\/\*\*'/);
    assert.match(builder, /canonicalOverrides:\s*section\.canonicalOverrides/);
    assert.match(builder, /retiredDailyEditions:\s*section\.retiredDailyEditions/);
    assert.match(builder, /buildDiscoveryArticleShadow\(/);
    assert.match(builder, /resolveDiscoverySidecarPath\(sidecarDir, id\)/);
    assert.match(builder, /resolveExistingDiscoverySidecarPath\(sidecarDir, id\)/);
  });
});
