import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EMPTY_TOPIC_CANDIDATES_FEED,
  TOPIC_CANDIDATES_FEED_URL,
  TopicCandidatesFeedError,
  buildTopicCandidatesFeedReport,
  fetchTopicCandidatesFeed,
  validateTopicCandidatesFeed,
  writeTopicCandidatesFeed,
} from '../scripts/lib/topic-candidates-feed.mjs';
import { projectTopicCandidateAttribution } from '../scripts/lib/topic-candidate-attribution.mjs';
import { resolveExperimentalCandidatesPath } from '../scripts/lib/topic-candidates-path.mjs';

const NOW_MS = Date.parse('2026-11-04T12:00:00.000Z');

function makeFeed(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
    candidates: [{
      id: '7a8f3c1d',
      keyword: 'Tema Reddit',
      angle: null,
      locale: 'it',
      sources: ['reddit'],
      totalScore: 0.72,
      redditPermalink: 'https://www.reddit.com/r/Ticino/comments/abc123/tema-reddit/?utm_source=feed#comment',
    }],
    ...overrides,
  };
}

function responseFor(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('validates and projects only the schema v1 topic-feed fields', () => {
  const feed = validateTopicCandidatesFeed(makeFeed(), { nowMs: NOW_MS });
  assert.equal(feed.schemaVersion, 1);
  assert.equal(feed.generatedAt, '2026-11-04T11:00:00.000Z');
  assert.deepEqual(feed.candidates[0], {
    id: '7a8f3c1d',
    keyword: 'Tema Reddit',
    angle: null,
    locale: 'it',
    sources: ['reddit'],
    totalScore: 0.72,
    redditPermalink: 'https://www.reddit.com/r/Ticino/comments/abc123/',
  });
  assert.equal('rationale' in feed.candidates[0], false);
  assert.equal('demandSignals' in feed.candidates[0], false);
});

test('rejects unsupported schema, unsafe provider labels, and raw extra fields', () => {
  assert.throws(
    () => validateTopicCandidatesFeed(makeFeed({ schemaVersion: 2 }), { nowMs: NOW_MS }),
    (error) => error instanceof TopicCandidatesFeedError && error.code === 'schema_version_unsupported',
  );
  assert.throws(
    () => validateTopicCandidatesFeed(makeFeed({ candidates: [{ ...makeFeed().candidates[0], sources: ['reddit', 'unknown'] }] }), { nowMs: NOW_MS }),
    (error) => error instanceof TopicCandidatesFeedError && error.code === 'candidate_sources_invalid',
  );
  assert.throws(
    () => validateTopicCandidatesFeed(makeFeed({ candidates: [{ ...makeFeed().candidates[0], rationale: 'raw post text' }] }), { nowMs: NOW_MS }),
    (error) => error instanceof TopicCandidatesFeedError && error.code === 'candidate_fields_unsupported',
  );
  const missingAngle = makeFeed({ candidates: [{
    id: '1234abcd',
    keyword: 'Tema senza angolo',
    locale: 'it',
    sources: ['reddit'],
    totalScore: 0.5,
  }] });
  assert.throws(
    () => validateTopicCandidatesFeed(missingAngle, { nowMs: NOW_MS }),
    (error) => error instanceof TopicCandidatesFeedError && error.code === 'candidate_angle_missing',
  );
});

test('measures v1 keyword and angle limits in Unicode code points like the producer', () => {
  const keyword = '💼'.repeat(180);
  const angle = '⚙️'.repeat(90);
  const feed = validateTopicCandidatesFeed(makeFeed({
    candidates: [{ ...makeFeed().candidates[0], keyword, angle }],
  }), { nowMs: NOW_MS });
  assert.equal(Array.from(feed.candidates[0].keyword).length, 180);
  assert.equal(Array.from(feed.candidates[0].angle).length, 180);
});

test('rejects stale, future, and invalid Reddit permalink data', () => {
  const stale = makeFeed({ generatedAt: new Date(NOW_MS - 9 * 24 * 60 * 60 * 1000).toISOString() });
  assert.throws(
    () => validateTopicCandidatesFeed(stale, { nowMs: NOW_MS }),
    (error) => error instanceof TopicCandidatesFeedError && error.code === 'feed_stale',
  );
  const future = makeFeed({ generatedAt: new Date(NOW_MS + 6 * 60 * 1000).toISOString() });
  assert.throws(
    () => validateTopicCandidatesFeed(future, { nowMs: NOW_MS }),
    (error) => error instanceof TopicCandidatesFeedError && error.code === 'generated_at_in_future',
  );
  const unsafeUrl = makeFeed({ candidates: [{ ...makeFeed().candidates[0], redditPermalink: 'https://evil.example/r/x/comments/y/' }] });
  assert.throws(
    () => validateTopicCandidatesFeed(unsafeUrl, { nowMs: NOW_MS }),
    (error) => error instanceof TopicCandidatesFeedError && error.code === 'candidate_reddit_permalink_invalid',
  );
  const urlWithoutSource = makeFeed({ candidates: [{
    ...makeFeed().candidates[0],
    sources: ['google-news-rss'],
  }] });
  assert.throws(
    () => validateTopicCandidatesFeed(urlWithoutSource, { nowMs: NOW_MS }),
    (error) => error instanceof TopicCandidatesFeedError && error.code === 'candidate_reddit_permalink_without_source',
  );
  for (const permalink of [
    'https://user@www.reddit.com/r/Ticino/comments/abc123/',
    'https://www.reddit.com:444/r/Ticino/comments/abc123/',
    'https://www.reddit.com:443/r/Ticino/comments/abc123/',
  ]) {
    assert.throws(
      () => validateTopicCandidatesFeed(makeFeed({ candidates: [{ ...makeFeed().candidates[0], redditPermalink: permalink }] }), { nowMs: NOW_MS }),
      (error) => error instanceof TopicCandidatesFeedError && error.code === 'candidate_reddit_permalink_invalid',
    );
  }
});

test('fetch uses the fixed HTTPS CDN endpoint and bounds a successful response', async () => {
  let requestedUrl = null;
  let options = null;
  const result = await fetchTopicCandidatesFeed({
    nowMs: NOW_MS,
    fetchImpl: async (url, opts) => {
      requestedUrl = url;
      options = opts;
      return responseFor(makeFeed());
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.feed.candidates.length, 1);
  assert.equal(requestedUrl, TOPIC_CANDIDATES_FEED_URL);
  assert.equal(new URL(requestedUrl).protocol, 'https:');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.accept, 'application/json');
  assert.ok(options.signal instanceof AbortSignal);
});

test('404, malformed JSON, stale payload, and oversized bodies degrade to an empty pool', async () => {
  const cases = [
    [async () => new Response('missing', { status: 404 }), 'http_404'],
    [async () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }), 'json_invalid'],
    [async () => responseFor(makeFeed({ generatedAt: new Date(NOW_MS - 9 * 24 * 60 * 60 * 1000).toISOString() })), 'feed_stale'],
    [async () => responseFor(makeFeed()), 'response_too_large', { maxBytes: 8 }],
  ];

  for (const [fetchImpl, expectedReason, options = {}] of cases) {
    const result = await fetchTopicCandidatesFeed({ fetchImpl, nowMs: NOW_MS, ...options });
    assert.equal(result.ok, false);
    assert.equal(result.reason, expectedReason);
    assert.deepEqual(result.feed, { ...EMPTY_TOPIC_CANDIDATES_FEED });
  }
});

test('writes an empty feed and a privacy-safe report when the CDN is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'topic-feed-'));
  try {
    const outputPath = join(root, 'feed.json');
    const reportPath = join(root, 'report.json');
    const result = await writeTopicCandidatesFeed(outputPath, {
      reportPath,
      nowMs: NOW_MS,
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), { ...EMPTY_TOPIC_CANDIDATES_FEED });
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.deepEqual(report, {
      status: 'empty-fallback',
      schemaVersion: 1,
      generatedAt: null,
      candidateCount: 0,
      candidateCountsBySource: { reddit: 0, 'google-news-rss': 0 },
      errorClass: 'http_404',
    });
    assert.equal('keyword' in report, false);
    assert.equal('redditPermalink' in report, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feed report counts candidates by source without including candidate content', () => {
  const report = buildTopicCandidatesFeedReport({ ok: true, feed: validateTopicCandidatesFeed(makeFeed({
    candidates: [
      { ...makeFeed().candidates[0], sources: ['reddit', 'google-news-rss'] },
      { id: '87654321', keyword: 'Tema News', angle: null, locale: 'it', sources: ['google-news-rss'], totalScore: 0.5 },
    ],
  }), { nowMs: NOW_MS }) });
  assert.equal(report.candidateCount, 2);
  assert.deepEqual(report.candidateCountsBySource, { reddit: 1, 'google-news-rss': 2 });
  assert.equal(report.generatedAt, '2026-11-04T11:00:00.000Z');
  assert.equal('keyword' in report, false);
  assert.equal('redditPermalink' in report, false);
});

test('selected-candidate attribution contains only stable IDs, providers, time, score, and safe permalink', () => {
  const attribution = projectTopicCandidateAttribution(makeFeed().candidates[0], makeFeed().generatedAt);
  assert.deepEqual(attribution, {
    candidateId: '7a8f3c1d',
    providers: ['reddit'],
    detectedAt: '2026-11-04T11:00:00.000Z',
    score: 0.72,
    redditPermalink: 'https://www.reddit.com/r/Ticino/comments/abc123/',
  });
  assert.equal('keyword' in attribution, false);
  assert.equal('rationale' in attribution, false);
  assert.equal('username' in attribution, false);
  assert.equal(projectTopicCandidateAttribution({ ...makeFeed().candidates[0], id: 'raw-user-name' }, makeFeed().generatedAt), null);
  assert.equal(projectTopicCandidateAttribution({ ...makeFeed().candidates[0], totalScore: 1.1 }, makeFeed().generatedAt), null);
});

test('temporary workflow path takes precedence over the local file default', () => {
  assert.equal(
    resolveExperimentalCandidatesPath('/runner/temp/feed.json', 'data/experimental-candidates.json'),
    '/runner/temp/feed.json',
  );
  assert.equal(
    resolveExperimentalCandidatesPath(' ', 'data/experimental-candidates.json'),
    'data/experimental-candidates.json',
  );
});
