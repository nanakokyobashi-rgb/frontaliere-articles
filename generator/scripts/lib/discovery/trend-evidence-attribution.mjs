const TREND_SOURCE = 'trends';
const NEWS_SOURCE = 'news';

export const MIN_TREND_EVIDENCE_SIMILARITY = 0.72;

export function isSecureHttpsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:'
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

function firstSecureUrl(...values) {
  return values.find(isSecureHttpsUrl) || null;
}

function trendSignal(candidate) {
  return candidate?.source === TREND_SOURCE || candidate?.meta?.signalProvider === 'google-trends';
}

function normalizeTrendEvidence(candidate, evidence, evidenceUrl) {
  const meta = candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {};
  const evidenceMeta = evidence?.meta && typeof evidence.meta === 'object' ? evidence.meta : {};
  const normalizedEvidenceUrl = firstSecureUrl(meta.evidenceUrl, meta.sourceUrl, candidate.url, evidenceUrl);

  return {
    ...candidate,
    url: firstSecureUrl(candidate.url, normalizedEvidenceUrl),
    meta: {
      ...meta,
      signalProvider: firstString(meta.signalProvider, 'google-trends'),
      signalHeadline: firstString(meta.signalHeadline, candidate.headline),
      evidenceProvider: firstString(meta.evidenceProvider, 'google-news-rss'),
      evidenceUrl: normalizedEvidenceUrl,
      evidenceHeadline: firstString(meta.evidenceHeadline, evidence?.headline),
      evidencePublisher: firstString(
        meta.evidencePublisher,
        evidenceMeta.sourceName,
        evidenceMeta.publisherHost,
      ),
      evidencePublishedAt: firstString(meta.evidencePublishedAt, evidenceMeta.pubDate),
      publisherHost: firstString(meta.publisherHost, evidenceMeta.publisherHost),
    },
  };
}

/**
 * Connect a Trends signal to a sufficiently similar Google News result before
 * the article selector sees it. Current producers keep signal and evidence
 * metadata in separate candidates, and Google News names its fields
 * `sourceUrl`/`sourceName`; this adapter creates the consumer contract without
 * treating an unlinked `discovery://` token as a fetchable article URL.
 */
export function attachTrendEvidenceToCandidates(candidates, headlineSimilarity) {
  if (!Array.isArray(candidates)) return [];
  if (typeof headlineSimilarity !== 'function') {
    throw new TypeError('headlineSimilarity must be a function');
  }

  const newsEvidence = candidates
    .filter((candidate) => candidate?.source === NEWS_SOURCE && typeof candidate?.headline === 'string')
    .map((candidate) => {
      const meta = candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {};
      return {
        candidate,
        url: firstSecureUrl(meta.evidenceUrl, meta.sourceUrl, candidate.url),
      };
    })
    .filter((entry) => entry.url);

  return candidates.map((candidate) => {
    if (!trendSignal(candidate)) return candidate;

    const meta = candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {};
    const ownEvidenceUrl = firstSecureUrl(meta.evidenceUrl, meta.sourceUrl, candidate.url);
    if (ownEvidenceUrl) return normalizeTrendEvidence(candidate, null, ownEvidenceUrl);

    let best = null;
    let bestScore = 0;
    for (const evidence of newsEvidence) {
      let score = 0;
      try {
        score = Number(headlineSimilarity(candidate.headline, evidence.candidate.headline));
      } catch {
        continue;
      }
      if (Number.isFinite(score) && score > bestScore) {
        best = evidence;
        bestScore = score;
      }
    }

    if (!best || bestScore < MIN_TREND_EVIDENCE_SIMILARITY) return candidate;
    return normalizeTrendEvidence(candidate, best.candidate, best.url);
  });
}
