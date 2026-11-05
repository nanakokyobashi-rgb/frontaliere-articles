import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildDiscoveryPool } from '../scripts/lib/discovery/discoveryPool.mjs';
import {
  attachTrendEvidenceToCandidates,
  isSecureHttpsUrl,
} from '../scripts/lib/discovery/trend-evidence-attribution.mjs';

const CREATE_ARTICLE = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
const BASE_URL = CREATE_ARTICLE.match(/^const BASE_URL = '([^']+)';$/m)?.[1];
assert.ok(BASE_URL, 'canonical BASE_URL missing from create-article.mjs');

function cutFunction(name) {
  const anchor = `function ${name}(`;
  const start = CREATE_ARTICLE.indexOf(anchor);
  assert.notEqual(start, -1, `${anchor} missing from create-article.mjs`);
  const end = CREATE_ARTICLE.indexOf('\n}\n', start);
  assert.ok(end > start, `closing brace for ${name} not found`);
  return CREATE_ARTICLE.slice(start, end + 2);
}

const normalizeDiscoveryPublisherUrl = new Function(
  'BASE_URL',
  `${cutFunction('normalizeDiscoveryPublisherUrl')}\nreturn normalizeDiscoveryPublisherUrl;`,
)(BASE_URL);

function makeDiscoveryHeadlineConverter(resolveHeadline = (headline) => headline) {
  const start = CREATE_ARTICLE.indexOf('const _discoveryCandidatesToHeadlines = (candidates) => {');
  assert.notEqual(start, -1, 'discovery headline converter missing from create-article.mjs');
  const endMarker = '\n    };';
  const end = CREATE_ARTICLE.indexOf(endMarker, start);
  assert.ok(end > start, 'discovery headline converter closure not found');
  const source = CREATE_ARTICLE.slice(start, end + endMarker.length);
  return new Function(
    'attachTrendEvidenceToCandidates',
    'headlineSimilarity',
    'resolveGoogleNewsHeadline',
    'isSecureHttpsUrl',
    'normalizeDiscoveryPublisherUrl',
    'safeSignalSourceUrlForLog',
    'console',
    `let _discoveryCandidatesById = new Map();\n`
      + 'let _provenHeadlinesForDiscovery = [];\n'
      + `${source}\nreturn _discoveryCandidatesToHeadlines;`,
  )(
    attachTrendEvidenceToCandidates,
    (left, right) => (left === right ? 1 : 0),
    resolveHeadline,
    isSecureHttpsUrl,
    normalizeDiscoveryPublisherUrl,
    (url) => url,
    { error() {} },
  );
}

function makeSecureDiscoveryPublisherUrlCheck() {
  return new Function(
    'isSecureHttpsUrl',
    'normalizeDiscoveryPublisherUrl',
    `${cutFunction('hasSecureDiscoveryPublisherUrl')}\nreturn hasSecureDiscoveryPublisherUrl;`,
  )(isSecureHttpsUrl, normalizeDiscoveryPublisherUrl);
}

test('Google Trends discovery can build a sourced candidate without evidence-index context', async () => {
  const nowMs = Date.parse('2026-11-05T10:00:00.000Z');
  const signalHeadline = 'Permessi frontalieri in Ticino';
  const pool = await buildDiscoveryPool(null, {
    nowMs,
    orphanFn: (evidence) => {
      assert.equal(evidence, null);
      return [];
    },
    suggestFn: async (evidence) => {
      assert.equal(evidence, null);
      return [];
    },
    trendsFn: async (evidence) => {
      assert.equal(evidence, null);
      return [{
        headline: signalHeadline,
        source: 'trends',
        meta: { score: 42, seed: signalHeadline },
      }];
    },
    newsFn: async (evidence, options = {}) => {
      assert.equal(evidence, null);
      if (!Array.isArray(options.seeds)) return [];
      return [{
        headline: 'Nuove regole per i permessi dei frontalieri in Ticino',
        url: 'https://news.example.test/frontaliere-permessi',
        meta: {
          seed: signalHeadline,
          pubDate: '2026-11-05T09:00:00.000Z',
          publisherHost: 'news.example.test',
        },
      }];
    },
  });

  assert.equal(pool.perSource.trendSignals, 1);
  assert.equal(pool.candidates.length, 1);
  assert.equal(pool.candidates[0].source, 'trends');
  assert.equal(pool.candidates[0].meta.signalProvider, 'google-trends');
  assert.equal(pool.candidates[0].meta.evidenceProvider, 'google-news-rss');
  assert.equal(pool.candidates[0].meta.signalHeadline, signalHeadline);
});

test('article discovery drops topic-only candidates and keeps secure Trends evidence', () => {
  const convert = makeDiscoveryHeadlineConverter();
  const sourceUrl = 'https://news.example.test/frontaliere-permessi';
  const converted = convert([
    {
      headline: 'Permessi frontalieri in Ticino',
      source: 'trends',
      url: null,
      meta: { evidenceUrl: sourceUrl, signalProvider: 'google-trends' },
    },
    { headline: 'Permessi frontalieri (landing GSC)', source: 'orphan', url: '/guide/permessi-frontaliere', meta: {} },
    { headline: 'Suggest topic with no publisher', source: 'suggest', url: null, meta: {} },
    { headline: 'Insecure source', source: 'news', url: 'http://news.example.test/story', meta: {} },
  ]);

  assert.equal(converted.length, 2);
  const trendHeadline = converted.find((candidate) => candidate.source === 'trends');
  const orphanHeadline = converted.find((candidate) => candidate.source === 'orphan');
  assert.equal(trendHeadline?.url, sourceUrl);
  assert.equal(orphanHeadline?.url, `${BASE_URL}/guide/permessi-frontaliere`);
  assert.ok(converted.every((candidate) => isSecureHttpsUrl(candidate.url)));
  assert.deepEqual(
    convert([{ headline: 'Unsourced signal', source: 'suggest', url: null, meta: {} }]),
    [],
    'an unsourced candidate returns an empty discovery pool so the caller can fall back to proven headlines',
  );
});

test('article discovery drops a resolver result with an insecure publisher URL', () => {
  const convert = makeDiscoveryHeadlineConverter((headline) => ({
    ...headline,
    url: 'http://publisher.example.test/frontaliere-permessi',
  }));

  assert.deepEqual(
    convert([{
      headline: 'Permessi frontalieri in Ticino',
      source: 'news',
      url: 'https://news.google.com/rss/articles/example',
      meta: {},
    }]),
    [],
    'the resolved publisher URL must remain HTTPS before generation',
  );
});

test('a decoded HTTP publisher URL blocks discovery generation but preserves proven behavior', () => {
  const hasSecurePublisherUrl = makeSecureDiscoveryPublisherUrlCheck();
  const chosenDiscovery = {
    _discoveryCandidate: { source: 'news', url: 'https://news.google.com/rss/articles/example' },
  };

  assert.equal(
    hasSecurePublisherUrl(chosenDiscovery, 'https://publisher.example.test/article'),
    true,
  );
  assert.equal(
    hasSecurePublisherUrl(chosenDiscovery, 'http://publisher.example.test/article'),
    false,
    'the URL returned by lazy Google News decoding must be HTTPS',
  );
  assert.equal(
    hasSecurePublisherUrl({
      _discoveryCandidate: { source: 'orphan', url: '/guide/permessi-frontaliere' },
    }, '/guide/permessi-frontaliere'),
    true,
    'the final gate must apply the same BASE_URL normalization to GSC orphan paths',
  );
  assert.equal(
    hasSecurePublisherUrl({ source: 'news' }, 'http://legacy.example.test/article'),
    true,
    'the discovery-only guard must not change proven-source behavior',
  );

  const decodePosition = CREATE_ARTICLE.indexOf('url = realUrl;');
  const guardPosition = CREATE_ARTICLE.indexOf('if (!hasSecureDiscoveryPublisherUrl(chosen, url))');
  const generationPosition = CREATE_ARTICLE.indexOf('await generateAndValidateArticle(url, chosen);');
  assert.ok(decodePosition >= 0 && decodePosition < guardPosition);
  assert.ok(guardPosition < generationPosition, 'the decoded URL guard must run before article generation');
});
