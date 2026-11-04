import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachTrendEvidenceToCandidates,
  MIN_TREND_EVIDENCE_SIMILARITY,
} from '../scripts/lib/discovery/trend-evidence-attribution.mjs';

test('links the current Trends and Google News producer shapes into one attributed candidate', () => {
  const trend = {
    headline: 'permesso g frontalieri',
    url: null,
    source: 'trends',
    meta: { score: 48, rawScore: 120, geo: 'CH' },
  };
  const news = {
    headline: 'Permesso G frontalieri, novità sul rientro',
    url: 'https://news.google.com/rss/articles/example',
    source: 'news',
    meta: {
      sourceUrl: 'https://news.google.com/rss/articles/example',
      sourceName: 'Tio',
      publisherHost: 'tio.ch',
      pubDate: '2026-11-03T10:00:00Z',
    },
  };
  const similarity = (signal, evidence) =>
    signal === trend.headline && evidence === news.headline ? 0.9 : 0;

  const [linkedTrend] = attachTrendEvidenceToCandidates([trend, news], similarity);

  assert.equal(linkedTrend.source, 'trends');
  assert.equal(linkedTrend.url, news.url);
  assert.equal(linkedTrend.meta.signalProvider, 'google-trends');
  assert.equal(linkedTrend.meta.signalHeadline, trend.headline);
  assert.equal(linkedTrend.meta.evidenceProvider, 'google-news-rss');
  assert.equal(linkedTrend.meta.evidenceUrl, news.meta.sourceUrl);
  assert.equal(linkedTrend.meta.evidenceHeadline, news.headline);
  assert.equal(linkedTrend.meta.evidencePublisher, news.meta.sourceName);
  assert.equal(linkedTrend.meta.evidencePublishedAt, news.meta.pubDate);
  assert.equal(linkedTrend.meta.publisherHost, news.meta.publisherHost);
  assert.equal(trend.url, null, 'the source candidate stays immutable');
});

test('does not attach Google News evidence below the similarity threshold', () => {
  const trend = { headline: 'trend query', url: null, source: 'trends', meta: {} };
  const news = {
    headline: 'unrelated news item',
    url: 'https://news.google.com/rss/articles/example',
    source: 'news',
    meta: { sourceUrl: 'https://news.google.com/rss/articles/example' },
  };
  const result = attachTrendEvidenceToCandidates(
    [trend, news],
    () => MIN_TREND_EVIDENCE_SIMILARITY - 0.01,
  );

  assert.strictEqual(result[0], trend);
  assert.equal(result[0].url, null);
});

test('does not attach matching evidence unless its URL is HTTPS', () => {
  const trend = { headline: 'trend query', url: null, source: 'trends', meta: {} };
  const news = {
    headline: 'trend query',
    url: 'http://news.google.com/rss/articles/example',
    source: 'news',
    meta: { sourceUrl: 'http://news.google.com/rss/articles/example' },
  };
  const result = attachTrendEvidenceToCandidates([trend, news], () => 1);

  assert.strictEqual(result[0], trend);
  assert.equal(result[0].url, null);
});

test('requires an explicit headline similarity function', () => {
  assert.throws(
    () => attachTrendEvidenceToCandidates([], null),
    /headlineSimilarity must be a function/u,
  );
});
