/**
 * Shared guards for synthetic article sources.
 *
 * Synthetic URLs are selected like ordinary headlines, so malformed tokens
 * and incomplete snapshots must become per-candidate quality rejections. They
 * must never be turned into a publishable article or an unclassified run
 * failure.
 */

export function decodeSyntheticSourceToken(rawToken, scheme) {
  const label = String(scheme || 'synthetic');
  try {
    return decodeURIComponent(String(rawToken ?? ''));
  } catch (cause) {
    const error = new Error(`${label} source token has malformed percent-encoding.`);
    error.qualityReject = true;
    error.syntheticSourceReject = true;
    error.cause = cause;
    throw error;
  }
}

export function markSyntheticSourceValidation(error, scheme) {
  const label = String(scheme || 'synthetic');
  const rejection = new Error(`${label} source validation failed: ${error?.message || error}`);
  rejection.qualityReject = true;
  rejection.syntheticSourceReject = true;
  rejection.cause = error;
  return rejection;
}

export function isZeroSourceForGenerationBudget(pageContent, url) {
  const source = String(pageContent ?? '');
  const resolvedUrl = String(url ?? '');
  return source.length === 0
    && !resolvedUrl.startsWith('evergreen://')
    && !resolvedUrl.startsWith('stats-bfs://');
}
