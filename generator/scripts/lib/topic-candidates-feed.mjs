#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOPIC_CANDIDATES_FEED_URL = 'https://cdn.frontaliereticino.ch/data/experimental-candidate-feed.json';
export const TOPIC_CANDIDATES_FEED_CACHE_BUCKET_MS = 5 * 60 * 1000;
export const TOPIC_CANDIDATES_FEED_MAX_BYTES = 1024 * 1024;
export const TOPIC_CANDIDATES_FEED_WARN_AGE_MS = 6 * 24 * 60 * 60 * 1000;
export const TOPIC_CANDIDATES_FEED_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const TOPIC_CANDIDATES_FEED_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const TOPIC_CANDIDATES_FEED_TIMEOUT_MS = 10_000;
export const TOPIC_CANDIDATES_FEED_MAX_CANDIDATES = 500;

export const EMPTY_TOPIC_CANDIDATES_FEED = Object.freeze({
  schemaVersion: 1,
  generatedAt: null,
  candidates: [],
});

function topicCandidatesFeedRequestUrl(nowMs) {
  const url = new URL(TOPIC_CANDIDATES_FEED_URL);
  url.searchParams.set('v', String(Math.floor(nowMs / TOPIC_CANDIDATES_FEED_CACHE_BUCKET_MS)));
  return url.toString();
}

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
    || Array.from(candidate.keyword).length > 180) {
    throw new TopicCandidatesFeedError('candidate_keyword_invalid');
  }
  if (!Object.hasOwn(candidate, 'angle')) {
    throw new TopicCandidatesFeedError('candidate_angle_missing');
  }
  if (candidate.angle !== null
    && (typeof candidate.angle !== 'string'
      || candidate.angle.trim() !== candidate.angle
      || /[\u0000-\u001f\u007f]/.test(candidate.angle)
      || Array.from(candidate.angle).length > 180)) {
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

/** Validate freshness/shape and return a bounded projection plus aggregate counts. */
export function validateTopicCandidatesFeedWithDiagnostics(payload, {
  nowMs = Date.now(),
  maxAgeMs = TOPIC_CANDIDATES_FEED_MAX_AGE_MS,
  maxCandidates = TOPIC_CANDIDATES_FEED_MAX_CANDIDATES,
  redditDataApiApproved = false,
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

  const candidates = [];
  const inputCandidateCountsBySource = { reddit: 0, 'google-news-rss': 0 };
  const filteredCandidateCountsByReason = {};
  let validatedCandidateCount = 0;

  for (const rawCandidate of payload.candidates) {
    const rawSources = Array.isArray(rawCandidate?.sources) ? new Set(rawCandidate.sources) : new Set();
    for (const source of rawSources) {
      if (Object.hasOwn(inputCandidateCountsBySource, source)) inputCandidateCountsBySource[source] += 1;
    }

    let candidate;
    try {
      candidate = safeCandidate(rawCandidate);
      validatedCandidateCount += 1;
    } catch (error) {
      const reason = error instanceof TopicCandidatesFeedError
        ? error.code
        : 'candidate_invalid';
      filteredCandidateCountsByReason[reason] = (filteredCandidateCountsByReason[reason] || 0) + 1;
      continue;
    }

    // This collector is approved only through an explicit Remote Config gate.
    // A mixed row has no source-specific evidence in schema v1, so News cannot
    // independently justify it after Reddit is removed; drop the whole row.
    if (redditDataApiApproved !== true && candidate.sources.includes('reddit')) {
      const reason = candidate.sources.includes('google-news-rss')
        ? 'mixed_reddit_unapproved'
        : 'reddit_unapproved';
      filteredCandidateCountsByReason[reason] = (filteredCandidateCountsByReason[reason] || 0) + 1;
      continue;
    }

    candidates.push(candidate);
  }

  const feed = {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    candidates,
  };
  return {
    feed,
    generatedAt: feed.generatedAt,
    feedAgeMs: Math.max(0, nowMs - generatedAtMs),
    diagnostics: {
      inputCandidateCount: payload.candidates.length,
      validatedCandidateCount,
      eligibleCandidateCount: candidates.length,
      filteredCandidateCount: payload.candidates.length - candidates.length,
      inputCandidateCountsBySource,
      filteredCandidateCountsByReason,
    },
  };
}

/** Validate freshness/shape and return a bounded projection for the ranker. */
export function validateTopicCandidatesFeed(payload, options = {}) {
  return validateTopicCandidatesFeedWithDiagnostics(payload, options).feed;
}

function responseUsesIdentityEncoding(response) {
  const contentEncoding = response.headers?.get?.('content-encoding');
  if (contentEncoding === null || contentEncoding === undefined) return true;
  const codings = String(contentEncoding)
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter(Boolean);
  return codings.length === 0 || codings.every((coding) => coding === 'identity');
}

function declaredResponseBytes(response, maxBytes) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength === null || contentLength === undefined || !String(contentLength).trim()) return null;
  const parsed = Number(contentLength);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TopicCandidatesFeedError('content_length_invalid');
  }
  if (parsed > maxBytes) throw new TopicCandidatesFeedError('response_too_large');
  // Fetch exposes the decoded body, while Content-Length describes the wire
  // representation whenever a non-identity Content-Encoding is present.
  return responseUsesIdentityEncoding(response) ? parsed : null;
}

/** Reject a body whose declared byte count does not match what was received. */
export function rejectTruncatedTopicFeed({ declaredBytes = null, receivedBytes, maxBytes = TOPIC_CANDIDATES_FEED_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0) {
    throw new TypeError('receivedBytes must be a non-negative integer');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive integer');
  }
  if (receivedBytes > maxBytes) throw new TopicCandidatesFeedError('response_too_large');
  if (declaredBytes !== null && declaredBytes !== undefined && receivedBytes !== declaredBytes) {
    throw new TopicCandidatesFeedError('response_truncated');
  }
  return receivedBytes;
}

async function readBodyBounded(response, maxBytes) {
  const declaredBytes = declaredResponseBytes(response, maxBytes);

  if (!response.body?.getReader) {
    const text = await response.text();
    rejectTruncatedTopicFeed({
      declaredBytes,
      receivedBytes: Buffer.byteLength(text, 'utf8'),
      maxBytes,
    });
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  async function cancelReader() {
    try {
      await reader.cancel?.();
    } catch {
      // Cancellation is cleanup; preserve the fail-closed response verdict.
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunkBytes = value?.byteLength;
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 0) {
        await cancelReader();
        throw new TopicCandidatesFeedError('response_body_invalid');
      }
      if (totalBytes > maxBytes - chunkBytes) {
        await cancelReader();
        throw new TopicCandidatesFeedError('response_too_large');
      }

      let chunk;
      try {
        const bytes = value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, chunkBytes)
            : null;
        if (!bytes) throw new TypeError('response body chunk is not binary');
        chunk = Buffer.from(bytes);
      } catch {
        await cancelReader();
        throw new TopicCandidatesFeedError('response_body_invalid');
      }
      if (chunk.byteLength !== chunkBytes) {
        await cancelReader();
        throw new TopicCandidatesFeedError('response_body_invalid');
      }
      chunks.push(chunk);
      totalBytes += chunkBytes;
    }
  } finally {
    reader.releaseLock?.();
  }
  rejectTruncatedTopicFeed({ declaredBytes, receivedBytes: totalBytes, maxBytes });
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
  const diagnostics = result?.diagnostics && isRecord(result.diagnostics) ? result.diagnostics : {};
  const ageMs = Number.isFinite(result?.feedAgeMs) ? Math.max(0, result.feedAgeMs) : null;
  const isStale = result?.reason === 'feed_stale'
    || (ageMs !== null && ageMs > TOPIC_CANDIDATES_FEED_MAX_AGE_MS);
  const freshness = isStale
    ? 'stale'
    : ageMs !== null && ageMs > TOPIC_CANDIDATES_FEED_WARN_AGE_MS
      ? 'aging'
      : result?.ok === true
        ? 'fresh'
        : 'unavailable';
  const inputCounts = diagnostics.inputCandidateCountsBySource
    && isRecord(diagnostics.inputCandidateCountsBySource)
    ? {
      reddit: Number.isInteger(diagnostics.inputCandidateCountsBySource.reddit)
        ? diagnostics.inputCandidateCountsBySource.reddit
        : 0,
      'google-news-rss': Number.isInteger(diagnostics.inputCandidateCountsBySource['google-news-rss'])
        ? diagnostics.inputCandidateCountsBySource['google-news-rss']
        : 0,
    }
    : { ...bySource };
  const filteredCounts = diagnostics.filteredCandidateCountsByReason
    && isRecord(diagnostics.filteredCandidateCountsByReason)
    ? diagnostics.filteredCandidateCountsByReason
    : {};
  return {
    status: result?.ok === true ? freshness : (isStale ? 'stale' : 'empty-fallback'),
    freshness,
    schemaVersion: Number.isInteger(feed.schemaVersion) ? feed.schemaVersion : 1,
    generatedAt: typeof result?.generatedAt === 'string'
      ? result.generatedAt
      : typeof feed.generatedAt === 'string'
        ? feed.generatedAt
        : null,
    feedAgeHours: ageMs === null ? null : Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10,
    inputCandidateCount: Number.isInteger(diagnostics.inputCandidateCount)
      ? diagnostics.inputCandidateCount
      : Number.isInteger(result?.inputCandidateCount)
        ? result.inputCandidateCount
        : candidates.length,
    validatedCandidateCount: Number.isInteger(diagnostics.validatedCandidateCount)
      ? diagnostics.validatedCandidateCount
      : candidates.length,
    candidateCount: candidates.length,
    eligibleCandidateCount: Number.isInteger(diagnostics.eligibleCandidateCount)
      ? diagnostics.eligibleCandidateCount
      : candidates.length,
    filteredCandidateCount: Number.isInteger(diagnostics.filteredCandidateCount)
      ? diagnostics.filteredCandidateCount
      : 0,
    inputCandidateCountsBySource: inputCounts,
    candidateCountsBySource: bySource,
    filteredCandidateCountsByReason: filteredCounts,
    errorClass: result?.ok === true ? null : (typeof result?.reason === 'string' ? result.reason : 'request_failed'),
  };
}

export async function fetchTopicCandidatesFeed({
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  maxBytes = TOPIC_CANDIDATES_FEED_MAX_BYTES,
  maxAgeMs = TOPIC_CANDIDATES_FEED_MAX_AGE_MS,
  timeoutMs = TOPIC_CANDIDATES_FEED_TIMEOUT_MS,
  redditDataApiApproved = process.env.REDDIT_DATA_API_APPROVED === 'true',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');

  let generatedAt = null;
  let feedAgeMs = null;
  let inputCandidateCount = null;
  try {
    const response = await fetchImpl(topicCandidatesFeedRequestUrl(nowMs), {
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
    inputCandidateCount = Array.isArray(payload?.candidates) ? payload.candidates.length : null;
    if (typeof payload?.generatedAt === 'string') {
      generatedAt = payload.generatedAt;
      const parsedGeneratedAtMs = Date.parse(generatedAt);
      if (Number.isFinite(parsedGeneratedAtMs)) feedAgeMs = Math.max(0, nowMs - parsedGeneratedAtMs);
    }
    const validated = validateTopicCandidatesFeedWithDiagnostics(payload, {
      nowMs,
      maxAgeMs,
      redditDataApiApproved,
    });
    return {
      ok: true,
      reason: null,
      feed: validated.feed,
      generatedAt: validated.generatedAt,
      feedAgeMs: validated.feedAgeMs,
      diagnostics: validated.diagnostics,
    };
  } catch (error) {
    const reason = error instanceof TopicCandidatesFeedError
      ? error.code
      : error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'request_timeout'
        : 'request_failed';
    return {
      ok: false,
      reason,
      feed: { ...EMPTY_TOPIC_CANDIDATES_FEED },
      generatedAt,
      feedAgeMs,
      inputCandidateCount,
      diagnostics: {
        inputCandidateCount: Number.isInteger(inputCandidateCount) ? inputCandidateCount : 0,
        validatedCandidateCount: 0,
        eligibleCandidateCount: 0,
        filteredCandidateCount: 0,
        inputCandidateCountsBySource: { reddit: 0, 'google-news-rss': 0 },
        filteredCandidateCountsByReason: {},
      },
    };
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
  if (report.freshness === 'aging') {
    console.warn(`::warning::[topic-feed] feed is aging (${report.feedAgeHours}h; warning threshold ${TOPIC_CANDIDATES_FEED_WARN_AGE_MS / (60 * 60 * 1000)}h)`);
  }
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
    console.log(`[topic-feed] status=${result.report.status} input=${result.report.inputCandidateCount} validated=${result.report.validatedCandidateCount} eligible=${result.report.eligibleCandidateCount} filtered=${result.report.filteredCandidateCount} generatedAt=${result.feed.generatedAt}`);
    if (result.report.filteredCandidateCount > 0) {
      console.log(`[topic-feed] filtered-by-reason=${JSON.stringify(result.report.filteredCandidateCountsByReason)}`);
    }
  } else {
    console.warn(`::warning::[topic-feed] using empty Reddit/News pool: ${result.reason} status=${result.report.status} ageHours=${result.report.feedAgeHours ?? 'unknown'}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[topic-feed] failed to write local feed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
