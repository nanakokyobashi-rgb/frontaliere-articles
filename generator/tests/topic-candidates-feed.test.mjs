import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EMPTY_TOPIC_CANDIDATES_FEED,
  TOPIC_CANDIDATES_FEED_CACHE_BUCKET_MS,
  TOPIC_CANDIDATES_FEED_URL,
  TopicCandidatesFeedError,
  buildTopicCandidatesFeedReport,
  fetchTopicCandidatesFeed,
  validateTopicCandidatesFeed,
  validateTopicCandidatesFeedWithDiagnostics,
  writeTopicCandidatesFeed,
} from '../scripts/lib/topic-candidates-feed.mjs';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';
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
  const feed = validateTopicCandidatesFeed(makeFeed(), {
    nowMs: NOW_MS,
    redditDataApiApproved: true,
  });
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

test('rejects an unsupported feed schema', () => {
  assert.throws(
    () => validateTopicCandidatesFeed(makeFeed({ schemaVersion: 2 }), { nowMs: NOW_MS }),
    (error) => error instanceof TopicCandidatesFeedError && error.code === 'schema_version_unsupported',
  );
});

test('filters invalid records individually and keeps other valid sources', () => {
  const result = validateTopicCandidatesFeedWithDiagnostics(makeFeed({ candidates: [
    { ...makeFeed().candidates[0], sources: ['reddit', 'unknown'] },
    { ...makeFeed().candidates[0], id: '1234abcd', rationale: 'raw post text' },
    { id: '87654321', keyword: 'Tema News', angle: null, locale: 'it', sources: ['google-news-rss'], totalScore: 0.5 },
  ] }), { nowMs: NOW_MS });

  assert.deepEqual(result.feed.candidates.map(({ id }) => id), ['87654321']);
  assert.equal(result.diagnostics.inputCandidateCount, 3);
  assert.equal(result.diagnostics.validatedCandidateCount, 1);
  assert.equal(result.diagnostics.filteredCandidateCount, 2);
  assert.deepEqual(result.diagnostics.filteredCandidateCountsByReason, {
    candidate_sources_invalid: 1,
    candidate_fields_unsupported: 1,
  });
});

test('measures v1 keyword and angle limits in Unicode code points like the producer', () => {
  const keyword = '💼'.repeat(180);
  const angle = '⚙️'.repeat(90);
  const feed = validateTopicCandidatesFeed(makeFeed({
    candidates: [{ ...makeFeed().candidates[0], keyword, angle }],
  }), { nowMs: NOW_MS, redditDataApiApproved: true });
  assert.equal(Array.from(feed.candidates[0].keyword).length, 180);
  assert.equal(Array.from(feed.candidates[0].angle).length, 180);
});

test('keeps Reddit gated off by default while preserving News-only rows', () => {
  const result = validateTopicCandidatesFeedWithDiagnostics(makeFeed({ candidates: [
    makeFeed().candidates[0],
    { ...makeFeed().candidates[0], id: '87654321', sources: ['reddit', 'google-news-rss'] },
    { id: '1234abcd', keyword: 'Tema News', angle: null, locale: 'it', sources: ['google-news-rss'], totalScore: 0.5 },
  ] }), { nowMs: NOW_MS });

  assert.deepEqual(result.feed.candidates.map(({ id }) => id), ['1234abcd']);
  assert.equal(result.diagnostics.inputCandidateCount, 3);
  assert.equal(result.diagnostics.eligibleCandidateCount, 1);
  assert.equal(result.diagnostics.filteredCandidateCount, 2);
  assert.deepEqual(result.diagnostics.filteredCandidateCountsByReason, {
    reddit_unapproved: 1,
    mixed_reddit_unapproved: 1,
  });
  assert.deepEqual(result.diagnostics.inputCandidateCountsBySource, { reddit: 2, 'google-news-rss': 2 });

  const approved = validateTopicCandidatesFeedWithDiagnostics(makeFeed(), {
    nowMs: NOW_MS,
    redditDataApiApproved: true,
  });
  assert.equal(approved.feed.candidates.length, 1);
  assert.equal(approved.feed.candidates[0].sources[0], 'reddit');

  for (const untrustedFlag of ['true', 'false', 1]) {
    const failClosed = validateTopicCandidatesFeedWithDiagnostics(makeFeed(), {
      nowMs: NOW_MS,
      redditDataApiApproved: untrustedFlag,
    });
    assert.equal(failClosed.feed.candidates.length, 0);
    assert.deepEqual(failClosed.diagnostics.filteredCandidateCountsByReason, { reddit_unapproved: 1 });
  }
});

test('maps the explicit Reddit approval flag from Remote Config', () => {
  assert.deepEqual(RC_TO_ENV.REDDIT_DATA_API_APPROVED, ['REDDIT_DATA_API_APPROVED']);
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
  const unsafeResult = validateTopicCandidatesFeedWithDiagnostics(unsafeUrl, { nowMs: NOW_MS });
  assert.equal(unsafeResult.feed.candidates.length, 0);
  assert.deepEqual(unsafeResult.diagnostics.filteredCandidateCountsByReason, {
    candidate_reddit_permalink_invalid: 1,
  });
  const urlWithoutSource = makeFeed({ candidates: [{
    ...makeFeed().candidates[0],
    sources: ['google-news-rss'],
  }] });
  const sourceMismatch = validateTopicCandidatesFeedWithDiagnostics(urlWithoutSource, { nowMs: NOW_MS });
  assert.equal(sourceMismatch.feed.candidates.length, 0);
  assert.deepEqual(sourceMismatch.diagnostics.filteredCandidateCountsByReason, {
    candidate_reddit_permalink_without_source: 1,
  });
  for (const permalink of [
    'https://user@www.reddit.com/r/Ticino/comments/abc123/',
    'https://www.reddit.com:444/r/Ticino/comments/abc123/',
    'https://www.reddit.com:443/r/Ticino/comments/abc123/',
  ]) {
    const result = validateTopicCandidatesFeedWithDiagnostics(
      makeFeed({ candidates: [{ ...makeFeed().candidates[0], redditPermalink: permalink }] }),
      { nowMs: NOW_MS },
    );
    assert.equal(result.feed.candidates.length, 0);
    assert.deepEqual(result.diagnostics.filteredCandidateCountsByReason, {
      candidate_reddit_permalink_invalid: 1,
    });
  }
});

test('fetch uses a five-minute versioned HTTPS CDN endpoint and bounds a successful response', async () => {
  let requestedUrl = null;
  let options = null;
  const result = await fetchTopicCandidatesFeed({
    nowMs: NOW_MS,
    redditDataApiApproved: true,
    fetchImpl: async (url, opts) => {
      requestedUrl = url;
      options = opts;
      return responseFor(makeFeed());
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.feed.candidates.length, 1);
  assert.equal(new URL(requestedUrl).origin + new URL(requestedUrl).pathname, TOPIC_CANDIDATES_FEED_URL);
  assert.equal(
    new URL(requestedUrl).searchParams.get('v'),
    String(Math.floor(NOW_MS / TOPIC_CANDIDATES_FEED_CACHE_BUCKET_MS)),
  );
  assert.equal(new URL(requestedUrl).protocol, 'https:');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.accept, 'application/json');
  assert.ok(options.signal instanceof AbortSignal);

  let nextBucketUrl = null;
  await fetchTopicCandidatesFeed({
    nowMs: NOW_MS + TOPIC_CANDIDATES_FEED_CACHE_BUCKET_MS,
    fetchImpl: async (url) => {
      nextBucketUrl = url;
      return responseFor(makeFeed());
    },
  });
  assert.notEqual(nextBucketUrl, requestedUrl);
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

  const stale = await fetchTopicCandidatesFeed({
    fetchImpl: async () => responseFor(makeFeed({ generatedAt: new Date(NOW_MS - 9 * 24 * 60 * 60 * 1000).toISOString() })),
    nowMs: NOW_MS,
  });
  assert.equal(buildTopicCandidatesFeedReport(stale).status, 'stale');
  assert.equal(buildTopicCandidatesFeedReport(stale).freshness, 'stale');
  assert.equal(buildTopicCandidatesFeedReport(stale).feedAgeHours, 216);

  const aging = await fetchTopicCandidatesFeed({
    fetchImpl: async () => responseFor(makeFeed({ generatedAt: new Date(NOW_MS - 7 * 24 * 60 * 60 * 1000).toISOString() })),
    nowMs: NOW_MS,
  });
  assert.equal(aging.ok, true);
  assert.equal(buildTopicCandidatesFeedReport(aging).status, 'aging');
  assert.equal(buildTopicCandidatesFeedReport(aging).feedAgeHours, 168);
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
      freshness: 'unavailable',
      schemaVersion: 1,
      generatedAt: null,
      feedAgeHours: null,
      inputCandidateCount: 0,
      validatedCandidateCount: 0,
      candidateCount: 0,
      eligibleCandidateCount: 0,
      filteredCandidateCount: 0,
      inputCandidateCountsBySource: { reddit: 0, 'google-news-rss': 0 },
      candidateCountsBySource: { reddit: 0, 'google-news-rss': 0 },
      filteredCandidateCountsByReason: {},
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
  }), { nowMs: NOW_MS, redditDataApiApproved: true }) });
  assert.equal(report.candidateCount, 2);
  assert.deepEqual(report.candidateCountsBySource, { reddit: 1, 'google-news-rss': 2 });
  assert.equal(report.inputCandidateCount, 2);
  assert.equal(report.eligibleCandidateCount, 2);
  assert.deepEqual(report.inputCandidateCountsBySource, { reddit: 1, 'google-news-rss': 2 });
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
