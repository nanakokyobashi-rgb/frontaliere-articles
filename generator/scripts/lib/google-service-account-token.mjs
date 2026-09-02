/**
 * Google service-account OAuth2: sign a JWT assertion, exchange it for an
 * access token. No external dependencies — `node:crypto` only.
 *
 * Extracted (#4837) because the same twenty lines existed in
 * scripts/lib/indexing-api.mjs and were then copy-pasted into
 * scripts/load-rc-env.mjs's dependency-free Remote Config path. Two literal
 * copies of a credential-signing routine is exactly the drift AGENTS.md
 * Non-Negotiable #6 forbids: a fix to one (clock skew, token lifetime, error
 * handling) would silently not reach the other.
 *
 * Callers differ only by OAuth scope.
 */
import { createSign } from 'node:crypto';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Build a signed JWT assertion for the given service account and scope.
 * @param {{client_email: string, private_key: string}} creds
 * @param {string} scope - OAuth2 scope URL
 * @returns {string} signed JWT
 */
export function createJwtAssertion(creds, scope) {
  if (!creds?.client_email || !creds?.private_key) {
    throw new Error('service account credentials missing client_email/private_key');
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({
      iss: creds.client_email,
      scope,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + TOKEN_LIFETIME_SECONDS,
    }),
  ].join('.');

  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  return `${unsigned}.${sign.sign(creds.private_key, 'base64url')}`;
}

/**
 * Google's OAuth2 token endpoint (`oauth2.googleapis.com/token`) uses the
 * flat RFC 6749 error shape (`{error, error_description}`), NOT the
 * googleapis.com REST envelope (`error.errors[].reason` / `error.status`)
 * that `extractGoogleErrorReason` in load-rc-env.mjs parses — the two
 * endpoints are different Google services with different error bodies, so
 * the same parser does not apply here (follow-up to #683, issue #693).
 * Returns null on anything that doesn't parse or doesn't carry an `error`
 * field — callers must treat null as "unknown", not "retryable".
 */
export function extractOAuthErrorReason(bodyText) {
  try {
    const { error } = JSON.parse(bodyText) ?? {};
    // RFC 6749 error codes are always a string; the googleapis.com REST
    // envelope this is NOT parsing puts an object here instead (see
    // extractGoogleErrorReason in load-rc-env.mjs) — reject that shape
    // rather than returning it as a truthy-but-wrong "reason".
    return typeof error === 'string' ? error : null;
  } catch {
    return null;
  }
}

/**
 * OAuth error codes documented for Google's authorization server that
 * signal a transient rate/quota rejection rather than a bad assertion —
 * distinct from RFC 6749's grant-level codes (`invalid_grant`,
 * `unauthorized_client`, …), which are never retriable. No production 403 in
 * this shape has been observed yet on this endpoint (see #693); this set
 * exists so that if/when one lands, it is classified the same way the
 * sibling Remote Config 403 already is (#247), instead of the classifier
 * seeing it for the first time.
 */
const QUOTA_TOKEN_EXCHANGE_REASONS = new Set([
  'rate_limit_exceeded',
  'quota_exceeded',
]);

/**
 * Whether an HTTP status (+ optional parsed OAuth `error` code) from the
 * token exchange is worth retrying. Same shape as isRetryableRcFetchStatus
 * in load-rc-env.mjs, adapted to the OAuth2 error vocabulary of this
 * endpoint rather than the googleapis.com REST one.
 */
export function isRetryableTokenExchangeStatus(status, reason) {
  if (status === 429 || status >= 500) return true;
  return status === 403 && QUOTA_TOKEN_EXCHANGE_REASONS.has(reason);
}

// Kept in lockstep with RC_FETCH_ATTEMPTS in load-rc-env.mjs (issue #263):
// same backoff formula, same credential chain, so a per-minute quota
// rejection on this hop needs the same ~63s retry budget to reach the next
// quota window instead of exhausting itself inside the one already spent.
// Exported so free-translate.mjs's own oauth2.googleapis.com/token exchange
// (#730) shares the attempt count instead of pinning its own copy.
export const TOKEN_EXCHANGE_ATTEMPTS = 7;

// Wall-clock cap per attempt (follow-up #199 to #173/#198): neither `fetch`
// call here nor its sibling in load-rc-env.mjs's `fetchTemplateViaRest` had
// ANY timeout — only a status-based retry. A slow-but-never-erroring Google
// endpoint (no 429/5xx, just no response) hung the awaited `fetch()` forever,
// so the retry loop's attempt cap never even got a chance to kick in. 30s
// matches the per-request timeout already used for other Google API calls on
// this same credential chain (FETCH_TIMEOUT_MS in refresh-daily-brief-data.mjs).
export const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

/**
 * Exchange a signed assertion for an access token.
 *
 * Retries 429/5xx, and a 403 whose body carries a recognized OAuth quota
 * error (see isRetryableTokenExchangeStatus): this call sits directly
 * upstream of the Remote Config fetch in load-rc-env.mjs's REST fallback,
 * and a single transient failure here produces the exact same symptom as
 * one in the RC fetch itself — see isRetryableRcFetchStatus in
 * load-rc-env.mjs, which retries the sibling call the same way.
 * @param {string} assertion
 * @returns {Promise<string>} access token
 */
export async function exchangeAssertionForToken(assertion) {
  let lastErr;
  for (let attempt = 1; attempt <= TOKEN_EXCHANGE_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      });
    } catch (err) {
      // AbortSignal.timeout() rejects the fetch instead of resolving a status,
      // and so does a raw network failure (DNS, TLS, connection reset — a bare
      // "fetch failed" TypeError with no status to check). Both are transient
      // and non-deterministic: issue #247 measured the network-failure case
      // landing 272ms after the request started on the sibling RC fetch in
      // load-rc-env.mjs, which retries every rejection for the same reason.
      // Re-throwing anything other than Abort/TimeoutError here (as this used
      // to) skipped the whole TOKEN_EXCHANGE_ATTEMPTS/~63s retry budget on
      // exactly the failure mode it was built to survive.
      lastErr = err?.name === 'AbortError' || err?.name === 'TimeoutError'
        ? new Error(`OAuth token exchange timed out after ${TOKEN_EXCHANGE_TIMEOUT_MS}ms`)
        : err;
      if (attempt < TOKEN_EXCHANGE_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      if (!data?.access_token) throw new Error('OAuth response missing access_token');
      return data.access_token;
    }
    const text = await res.text();
    // A 403 needs the body to tell a transient quota rejection apart from a
    // real grant-level rejection (invalid_grant, unauthorized_client, …) —
    // see isRetryableTokenExchangeStatus above (#693, follow-up to #247/#683).
    const reason = extractOAuthErrorReason(text);
    lastErr = new Error(`OAuth token exchange failed: ${res.status}${reason ? ` (${reason})` : ''} ${text}`);
    if (!isRetryableTokenExchangeStatus(res.status, reason)) throw lastErr;
    if (attempt < TOKEN_EXCHANGE_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

/**
 * Convenience: creds + scope -> access token.
 * @param {{client_email: string, private_key: string}} creds
 * @param {string} scope
 * @returns {Promise<string>}
 */
export async function getServiceAccountAccessToken(creds, scope) {
  return exchangeAssertionForToken(createJwtAssertion(creds, scope));
}
