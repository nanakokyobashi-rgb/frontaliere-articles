#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOPIC_CANDIDATES_FEED_URL = 'https://cdn.frontaliereticino.ch/data/experimental-candidate-feed.json';
export const TOPIC_CANDIDATES_FEED_MAX_BYTES = 1024 * 1024;
export const TOPIC_CANDIDATES_FEED_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const TOPIC_CANDIDATES_FEED_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const TOPIC_CANDIDATES_FEED_TIMEOUT_MS = 10_000;
export const TOPIC_CANDIDATES_FEED_MAX_CANDIDATES = 500;

export const EMPTY_TOPIC_CANDIDATES_FEED = Object.freeze({
  schemaVersion: 1,
  generatedAt: null,
  candidates: [],
});

export class TopicCandidatesFeedError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TopicCandidatesFeedError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const ALLOWED_SOURCE_LABELS = new Set(['reddit', 'google-news-rss']);

function isSafeSourceName(value) {
  return typeof value === 'string' && ALLOWED_SOURCE_LABELS.has(value);
}

function normalizeRedditPermalink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const rawAuthority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
    const url = new URL(value);
    if (url.protocol !== 'https:'
      || url.hostname !== 'www.reddit.com'
      || url.username
      || url.password
      || url.port
      || rawAuthority?.toLowerCase() !== 'www.reddit.com') return null;
    const match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,32})\/comments\/([A-Za-z0-9]+)(?:\/[^/]*)?\/?$/);
    if (!match) return null;
    // Keep the public post identity, while dropping the optional title slug,
    // query and fragment so no raw Reddit text is carried downstream.
    return `https://www.reddit.com/r/${match[1]}/comments/${match[2]}/`;
  } catch {
    return null;
  }
}

export { normalizeRedditPermalink };

function safeCandidate(candidate) {
  if (!isRecord(candidate)) throw new TopicCandidatesFeedError('candidate_not_object');
  const allowedFields = new Set(['id', 'keyword', 'angle', 'locale', 'sources', 'totalScore', 'redditPermalink']);
  if (Object.keys(candidate).some((key) => !allowedFields.has(key))) {
    throw new TopicCandidatesFeedError('candidate_fields_unsupported');
  }
  if (typeof candidate.id !== 'string' || !/^[a-f0-9]{8}$/.test(candidate.id)) {
    throw new TopicCandidatesFeedError('candidate_id_invalid');
  }
  if (typeof candidate.keyword !== 'string'
    || !candidate.keyword.trim()
    || candidate.keyword.trim() !== candidate.keyword
    || /[\u0000-\u001f\u007f]/.test(candidate.keyword)
    || candidate.keyword.length > 180) {
    throw new TopicCandidatesFeedError('candidate_keyword_invalid');
  }
  if (!Object.hasOwn(candidate, 'angle')) {
    throw new TopicCandidatesFeedError('candidate_angle_missing');
  }
  if (candidate.angle !== null
    && (typeof candidate.angle !== 'string'
      || candidate.angle.trim() !== candidate.angle
      || /[\u0000-\u001f\u007f]/.test(candidate.angle)
      || candidate.angle.length > 180)) {
    throw new TopicCandidatesFeedError('candidate_angle_invalid');
  }
  if (!['it', 'en', 'de', 'fr'].includes(candidate.locale)) {
    throw new TopicCandidatesFeedError('candidate_locale_invalid');
  }
  if (!Array.isArray(candidate.sources) || candidate.sources.length < 1 || candidate.sources.length > 5
    || candidate.sources.some((source) => !isSafeSourceName(source))) {
    throw new TopicCandidatesFeedError('candidate_sources_invalid');
  }
  if (!Number.isFinite(candidate.totalScore) || candidate.totalScore < 0 || candidate.totalScore > 1) {
    throw new TopicCandidatesFeedError('candidate_score_invalid');
  }
  const redditPermalink = candidate.redditPermalink == null
    ? null
    : normalizeRedditPermalink(candidate.redditPermalink);
  if (candidate.redditPermalink !== undefined && candidate.redditPermalink !== null && !redditPermalink) {
    throw new TopicCandidatesFeedError('candidate_reddit_permalink_invalid');
  }
  if (redditPermalink && !candidate.sources.includes('reddit')) {
    throw new TopicCandidatesFeedError('candidate_reddit_permalink_without_source');
  }

  // Copy only the v1 public-feed fields used by the ranker or attribution
  // helper. Never transport free-text rationale, post bodies, or usernames.
  return {
    id: candidate.id,
    keyword: candidate.keyword,
    angle: candidate.angle,
    locale: candidate.locale,
    sources: [...new Set(candidate.sources)],
    totalScore: candidate.totalScore,
    ...(redditPermalink
      ? { redditPermalink }
      : {}),
  };
}

/** Validate freshness/shape and return a bounded projection for the ranker. */
export function validateTopicCandidatesFeed(payload, {
  nowMs = Date.now(),
  maxAgeMs = TOPIC_CANDIDATES_FEED_MAX_AGE_MS,
  maxCandidates = TOPIC_CANDIDATES_FEED_MAX_CANDIDATES,
} = {}) {
  if (!isRecord(payload)) throw new TopicCandidatesFeedError('payload_not_object');
  if (Object.keys(payload).some((key) => !['schemaVersion', 'generatedAt', 'candidates'].includes(key))) {
    throw new TopicCandidatesFeedError('payload_fields_unsupported');
  }
  if (payload.schemaVersion !== 1) throw new TopicCandidatesFeedError('schema_version_unsupported');
  if (typeof payload.generatedAt !== 'string' || !payload.generatedAt.trim()) {
    throw new TopicCandidatesFeedError('generated_at_invalid');
  }
  const generatedAtMs = Date.parse(payload.generatedAt);
  if (!Number.isFinite(generatedAtMs)) throw new TopicCandidatesFeedError('generated_at_invalid');
  if (generatedAtMs > nowMs + TOPIC_CANDIDATES_FEED_MAX_FUTURE_SKEW_MS) {
    throw new TopicCandidatesFeedError('generated_at_in_future');
  }
  if (nowMs - generatedAtMs > maxAgeMs) throw new TopicCandidatesFeedError('feed_stale');
  if (!Array.isArray(payload.candidates) || payload.candidates.length > maxCandidates) {
    throw new TopicCandidatesFeedError('candidates_invalid');
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    candidates: payload.candidates.map(safeCandidate),
  };
}

async function readBodyBounded(response, maxBytes) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new TopicCandidatesFeedError('response_too_large');
    }
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new TopicCandidatesFeedError('response_too_large');
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TopicCandidatesFeedError('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export function buildTopicCandidatesFeedReport(result) {
  const feed = result?.feed && isRecord(result.feed) ? result.feed : EMPTY_TOPIC_CANDIDATES_FEED;
  const bySource = { reddit: 0, 'google-news-rss': 0 };
  const candidates = Array.isArray(feed.candidates) ? feed.candidates : [];
  for (const candidate of candidates) {
    for (const source of Array.isArray(candidate?.sources) ? candidate.sources : []) {
      if (Object.hasOwn(bySource, source)) bySource[source] += 1;
    }
  }
  return {
    status: result?.ok === true ? 'fresh' : 'empty-fallback',
    schemaVersion: Number.isInteger(feed.schemaVersion) ? feed.schemaVersion : 1,
    generatedAt: typeof feed.generatedAt === 'string' ? feed.generatedAt : null,
    candidateCount: candidates.length,
    candidateCountsBySource: bySource,
    errorClass: result?.ok === true ? null : (typeof result?.reason === 'string' ? result.reason : 'request_failed'),
  };
}

export async function fetchTopicCandidatesFeed({
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  maxBytes = TOPIC_CANDIDATES_FEED_MAX_BYTES,
  maxAgeMs = TOPIC_CANDIDATES_FEED_MAX_AGE_MS,
  timeoutMs = TOPIC_CANDIDATES_FEED_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');

  try {
    const response = await fetchImpl(TOPIC_CANDIDATES_FEED_URL, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) throw new TopicCandidatesFeedError(`http_${response?.status ?? 'unknown'}`);
    if (response.redirected) throw new TopicCandidatesFeedError('redirect_rejected');
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== new URL(TOPIC_CANDIDATES_FEED_URL).hostname) {
        throw new TopicCandidatesFeedError('unexpected_final_url');
      }
    }
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !/\bapplication\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType)) {
      throw new TopicCandidatesFeedError('content_type_invalid');
    }
    const body = await readBodyBounded(response, maxBytes);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new TopicCandidatesFeedError('json_invalid');
    }
    const feed = validateTopicCandidatesFeed(payload, { nowMs, maxAgeMs });
    return { ok: true, reason: null, feed };
  } catch (error) {
    const reason = error instanceof TopicCandidatesFeedError
      ? error.code
      : error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'request_timeout'
        : 'request_failed';
    return { ok: false, reason, feed: { ...EMPTY_TOPIC_CANDIDATES_FEED } };
  }
}

export async function writeTopicCandidatesFeed(outputPath, options = {}) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new TypeError('outputPath is required');
  const reportPath = typeof options.reportPath === 'string' && options.reportPath.trim()
    ? options.reportPath
    : null;
  const result = await fetchTopicCandidatesFeed(options);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result.feed, null, 2)}\n`, 'utf8');
  const report = buildTopicCandidatesFeedReport(result);
  if (reportPath) {
    const reportTarget = resolve(reportPath);
    mkdirSync(dirname(reportTarget), { recursive: true });
    writeFileSync(reportTarget, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return { ...result, outputPath: target, report, candidateCount: result.feed.candidates.length };
}

async function main() {
  const outputPath = process.argv[2];
  const reportPath = process.argv[3] || process.env.TOPIC_CANDIDATES_FEED_REPORT_PATH || null;
  if (!outputPath) {
    console.error('Usage: node topic-candidates-feed.mjs <output-path>');
    process.exitCode = 2;
    return;
  }
  const result = await writeTopicCandidatesFeed(outputPath, { reportPath });
  if (result.ok) {
    console.log(`[topic-feed] fresh=${result.candidateCount} generatedAt=${result.feed.generatedAt}`);
  } else {
    console.warn(`::warning::[topic-feed] using empty Reddit/News pool: ${result.reason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[topic-feed] failed to write local feed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
