const HTTP_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse one Retry-After value without allowing Date.parse to accept unrelated
 * locale/date syntaxes or an unsafe numeric value.
 *
 * @param {unknown} raw
 * @param {number} [nowMs]
 * @param {number} [maxDelayMs]
 * @returns {number|null}
 */
export function parseStrictRetryAfterValue(
  raw,
  nowMs = Date.now(),
  maxDelayMs = Number.POSITIVE_INFINITY,
) {
  if (typeof raw !== 'string' || !Number.isFinite(nowMs)) return null;
  const value = raw.trim();
  if (!value) return null;

  const cap = Number.isFinite(maxDelayMs) && maxDelayMs >= 0
    ? maxDelayMs
    : Number.POSITIVE_INFINITY;
  let delayMs;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return null;
    if (seconds > cap / 1000) return cap;
    delayMs = seconds * 1000;
  } else {
    if (!HTTP_DATE_RE.test(value)) return null;
    const retryAtMs = Date.parse(value);
    // Require the canonical IMF-fixdate spelling so Date.parse cannot turn a
    // locale date or an invalid weekday into a valid retry delay.
    if (!Number.isFinite(retryAtMs) || new Date(retryAtMs).toUTCString() !== value) return null;
    delayMs = retryAtMs - nowMs;
  }
  if (!Number.isFinite(delayMs)) return null;
  return Math.min(cap, Math.max(0, Math.ceil(delayMs)));
}

/**
 * Read and parse one Retry-After header.
 *
 * @param {Response|{headers?: {get?: Function}}|null} response
 * @param {number} [nowMs]
 * @param {number} [maxDelayMs]
 * @returns {number|null}
 */
export function parseRetryAfterHeader(
  response,
  nowMs = Date.now(),
  maxDelayMs = Number.POSITIVE_INFINITY,
) {
  let raw;
  try {
    raw = response?.headers?.get?.('retry-after');
  } catch {
    return null;
  }
  return parseStrictRetryAfterValue(raw, nowMs, maxDelayMs);
}
