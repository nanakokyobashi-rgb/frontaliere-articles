import { normalizeRedditPermalink } from './topic-candidates-feed.mjs';

const ALLOWED_SOURCES = new Set(['reddit', 'google-news-rss']);

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Build the internal, privacy-limited attribution for a selected experimental
 * topic. It intentionally excludes the keyword/title, post body, rationale,
 * subreddit user names, and all unrecognized source metadata.
 */
export function projectTopicCandidateAttribution(candidate, generatedAt) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  if (typeof candidate.id !== 'string' || !/^[a-f0-9]{8}$/.test(candidate.id)) return null;
  if (!Number.isFinite(candidate.totalScore) || candidate.totalScore < 0 || candidate.totalScore > 1) return null;

  const providers = Array.isArray(candidate.sources)
    ? [...new Set(candidate.sources.filter((source) => ALLOWED_SOURCES.has(source)))].sort()
    : [];
  if (providers.length === 0) return null;

  const redditPermalink = !providers.includes('reddit') || candidate.redditPermalink == null
    ? null
    : normalizeRedditPermalink(candidate.redditPermalink);

  return {
    candidateId: candidate.id,
    providers,
    detectedAt: normalizeTimestamp(generatedAt),
    score: candidate.totalScore,
    redditPermalink: redditPermalink || null,
  };
}
