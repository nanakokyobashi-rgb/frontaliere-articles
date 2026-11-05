import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDiscoveryArticleShadow,
  buildDiscoveryArticlesIndex,
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
    assert.equal(payload.count, 4);
    assert.deepEqual(payload.articles.map(({ id }) => id), [
      'trend-article',
      'news-only-article',
      'fallback-locale',
      'missing-excerpt',
    ]);
    assert.equal(payload.articles.some(({ id }) => [
      'reddit-article',
      'reddit-only-article',
      'reddit-and-trends-article',
    ].includes(id)), false);

    const trend = payload.articles[0];
    assert.equal(trend.provider, 'google_trends');
    assert.deepEqual(Object.keys(trend).sort(), ['excerpt', 'id', 'provider', 'publishedAt', 'title', 'url']);
    assert.deepEqual(Object.keys(trend.title), ['it', 'en', 'de', 'fr']);
    assert.deepEqual(Object.keys(trend.excerpt), ['it', 'en', 'de', 'fr']);
    assert.deepEqual(Object.keys(trend.url), ['it', 'en', 'de', 'fr']);
    assert.equal(trend.url.it, 'https://frontaliereticino.ch/articoli-frontaliere/trend-article-it/');
    assert.equal(payload.articles[1].provider, 'other');
    for (const field of ['title', 'excerpt', 'url']) {
      assert.deepEqual(Object.keys(payload.articles[2][field]), ['it', 'en']);
    }
    const missingExcerpt = payload.articles[3];
    for (const field of ['title', 'excerpt', 'url']) {
      assert.deepEqual(Object.keys(missingExcerpt[field]), ['it', 'en', 'de']);
    }

    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /private trend query|publisher\.example|reddit\.com|private-title|0\.91/);
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

  test('keeps non-ASCII registry IDs when their sidecar basename is safe', () => {
    const id = 'änderung-arbeitsmarkt';
    const section = publishedSection();
    section.registry.push({ id, date: '2026-11-02' });
    section.slugMap[id] = { it: `${id}-it`, en: `${id}-en`, de: `${id}-de`, fr: `${id}-fr` };
    for (const locale of ['it', 'en', 'de', 'fr']) {
      section.metaByLocale[locale].set(id, { title: `Titolo ${locale}`, excerpt: `Sintesi ${locale}` });
    }
    section.sidecars.set(id, {
      id,
      publishedAt: '2026-11-02T09:15:00.000Z',
      _discovery_attribution: { candidateId: 'trend-topic-5', signalProvider: 'google-trends' },
    });

    const payload = buildDiscoveryArticlesIndex({
      commit: 'e'.repeat(40),
      generatedAt: '2026-11-05T10:00:00.000Z',
      sections: [section],
    });

    assert.equal(payload.articles.some((article) => article.id === id), true);
    const sidecarRoot = path.resolve('/tmp/discovery-sidecars');
    assert.equal(
      resolveDiscoverySidecarPath(sidecarRoot, id),
      path.join(sidecarRoot, `${id}.json`),
    );
    assert.equal(
      resolveDiscoverySidecarPath(sidecarRoot, 'nested/änderung'),
      path.join(sidecarRoot, 'nested', 'änderung.json'),
    );
    assert.equal(
      resolveDiscoverySidecarPath(sidecarRoot, 'nested/..'),
      path.join(sidecarRoot, 'nested', '...json'),
    );
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, '../outside'), null);
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, 'nested/../outside'), null);
    assert.equal(resolveDiscoverySidecarPath(sidecarRoot, '..\\outside'), null);
  });

  test('rejects nested sidecar symlinks that resolve outside the sidecar directory', () => {
    const tempRoot = fs.mkdtempSync(path.join('/tmp', 'discovery-sidecar-'));
    const sidecarRoot = path.join(tempRoot, 'sidecars');
    const outsideRoot = path.join(tempRoot, 'outside');
    fs.mkdirSync(sidecarRoot);
    fs.mkdirSync(outsideRoot);
    fs.writeFileSync(path.join(outsideRoot, 'article.json'), JSON.stringify({ id: 'nested/article' }));
    fs.symlinkSync(outsideRoot, path.join(sidecarRoot, 'nested'), 'dir');

    try {
      assert.throws(
        () => resolveExistingDiscoverySidecarPath(sidecarRoot, 'nested/article', tempRoot),
        /resolves outside its directory/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects a sidecar root symlink that resolves outside the repository', () => {
    const tempRoot = fs.mkdtempSync(path.join('/tmp', 'discovery-sidecar-root-'));
    const trustedRoot = path.join(tempRoot, 'repository');
    const outsideRoot = path.join(tempRoot, 'outside');
    const sidecarRoot = path.join(trustedRoot, 'content', 'discovery-attribution');
    fs.mkdirSync(sidecarRoot, { recursive: true });
    fs.mkdirSync(outsideRoot);
    fs.rmSync(sidecarRoot, { recursive: true });
    fs.symlinkSync(outsideRoot, sidecarRoot, 'dir');

    try {
      assert.throws(
        () => resolveExistingDiscoverySidecarPath(sidecarRoot, 'missing', trustedRoot),
        /sidecar directory resolves outside the repository/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects a nested symlink escape even when the sidecar file is absent', () => {
    const tempRoot = fs.mkdtempSync(path.join('/tmp', 'discovery-sidecar-missing-'));
    const sidecarRoot = path.join(tempRoot, 'repository', 'content', 'discovery-attribution');
    const outsideRoot = path.join(tempRoot, 'outside');
    fs.mkdirSync(sidecarRoot, { recursive: true });
    fs.mkdirSync(outsideRoot);
    fs.symlinkSync(outsideRoot, path.join(sidecarRoot, 'nested'), 'dir');

    try {
      assert.throws(
        () => resolveExistingDiscoverySidecarPath(sidecarRoot, 'nested/missing', path.join(tempRoot, 'repository')),
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

    assert.deepEqual(payload.articles.map(({ id }) => id), ['fallback-locale', 'missing-excerpt']);
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
    }), null);
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: ['reddit', 'google-news-rss'] },
    }), null);
    assert.equal(normalizeDiscoveryProvider({
      _discovery_attribution: { candidateId: 'trend-1', signalProvider: 'google-trends' },
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: ['reddit', 'google-news-rss'] },
    }), null);
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: ['google-news-rss'] },
    }), 'other');
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: 'bad-id', providers: ['reddit'] },
    }), null);
    assert.equal(normalizeDiscoveryProvider({
      _topic_candidate_attribution: { candidateId: '1234abcd', providers: ['unknown'] },
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
    assert.match(builder, /resolveDiscoverySidecarPath\(sidecarDir, id\)/);
    assert.match(builder, /resolveExistingDiscoverySidecarPath\(sidecarDir, id\)/);
    assert.match(builder, /buildDiscoveryArticleShadow\(/);
  });
});
