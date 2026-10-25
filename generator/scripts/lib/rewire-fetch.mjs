/**
 * Fetch helper for the REWIRE consumers (border-wait window, averages,
 * events, canton-tax, pension-parameters). Cloudflare returns HTTP 403 to GitHub Actions'
 * default Node/undici User-Agent (measured 2026-08-25 on
 * generator-ci.yml: both CDN and same-origin). A named UA is the
 * first retry; callers then decide the policy via explicit env:
 *   REWIRE_SKIP_WAF_403=1   --check may exit 0 (PR CI only)
 *   REWIRE_FIXTURE_ON_403=1 write may copy the offline fixture (dry self-test)
 * rewire-contract-watch.yml sets neither: a 403 there stays a hard fail.
 */
export const REWIRE_FETCH_HEADERS = {
  'user-agent':
    'frontaliere-articles-rewire/1 (+https://github.com/nanakokyobashi-rgb/frontaliere-articles)',
  accept: 'application/json',
};
const DEFAULT_REWIRE_FETCH_TIMEOUT_MS = 30_000;
const MAX_REWIRE_FETCH_TIMEOUT_MS = 120_000;

function boundedTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_REWIRE_FETCH_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.floor(numeric)), MAX_REWIRE_FETCH_TIMEOUT_MS);
}

export const REWIRE_FETCH_TIMEOUT_MS = boundedTimeoutMs(
  process.env.REWIRE_FETCH_TIMEOUT_MS || DEFAULT_REWIRE_FETCH_TIMEOUT_MS,
);

/** True when every source failed with HTTP 403 on GitHub Actions. Policy is separate. */
export function isCiWafBlock(errors, env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return false;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((e) => /HTTP 403/.test(String(e)));
}

/** Retries 5xx/429/network. 4xx other than 429 fail immediately. */
export async function getRewireUrl(
  url,
  {
    retries = 4,
    headers = REWIRE_FETCH_HEADERS,
    fetchImpl = globalThis.fetch,
    timeoutMs = REWIRE_FETCH_TIMEOUT_MS,
  } = {},
) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const effectiveTimeoutMs = boundedTimeoutMs(timeoutMs);
      const controller = new AbortController();
      let timedOut = false;
      let timer;
      const timeoutError = () => {
        const error = new Error(`GET ${url} timed out after ${effectiveTimeoutMs}ms`);
        error.name = 'TimeoutError';
        error.code = 'REWIRE_FETCH_TIMEOUT';
        return error;
      };
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(timeoutError());
        }, effectiveTimeoutMs);
      });
      let res;
      let body;
      try {
        res = await Promise.race([
          fetchImpl(url, { redirect: 'follow', headers, signal: controller.signal }),
          deadline,
        ]);
        if (res.ok) body = await Promise.race([res.text(), deadline]);
      } catch (error) {
        if (timedOut) throw timeoutError();
        throw error;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      if (res.ok) {
        // An empty 2xx response is still a response. Let the JSON/schema
        // validator reject it so callers fail closed instead of treating two
        // empty publications as an unreachable publisher and keeping stale data.
        return body;
      } else {
        const err = new Error(`HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429) throw err;
        lastErr = err;
      }
    } catch (err) {
      if (/HTTP 4\d\d/.test(err.message) && !/HTTP 429/.test(err.message)) throw err;
      lastErr = err;
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
  }
  throw lastErr;
}

/**
 * Select the first source whose response is valid JSON and passes `validate`.
 * With no validator, if every HTTP-success body is non-JSON, return the first
 * such body as `ok` so the existing consumer parser still fails hard instead
 * of misclassifying a malformed publication as an unreachable source.
 * `validate(payload)` may return null/undefined/true for acceptance, false or a
 * diagnostic string for rejection. A supplied validator that rejects every
 * response returns `ok: false` with `sawResponse: true` for hard-fail handling.
 */
export async function fetchFirstOk(urls, opts = {}) {
  const { validate, getBody = getRewireUrl, ...fetchOpts } = opts;
  const errors = [];
  let firstInvalidJson;
  let sawResponse = false;
  for (const url of urls) {
    let body;
    try {
      body = await getBody(url, fetchOpts);
      sawResponse = true;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      errors.push(`${url} is not valid JSON: ${err.message}`);
      firstInvalidJson ??= { url, body };
      continue;
    }

    if (typeof validate === 'function') {
      let verdict;
      try {
        verdict = validate(payload);
      } catch (err) {
        verdict = `validator threw: ${err?.message || err}`;
      }
      if (verdict === false || (typeof verdict === 'string' && verdict.length > 0)) {
        errors.push(`${url}: ${typeof verdict === 'string' ? verdict : 'payload validation failed'}`);
        continue;
      }
    }

    if (errors.length) {
      console.warn(`[rewire-fetch] selected ${url} after rejecting earlier source(s):\n  ${errors.join('\n  ')}`);
    }
    return { ok: true, url, body, payload, errors, sawResponse };
  }

  if (typeof validate === 'function') {
    return { ok: false, url: undefined, body: undefined, payload: undefined, errors, sawResponse };
  }
  if (firstInvalidJson) {
    return { ok: true, ...firstInvalidJson, payload: undefined, errors, sawResponse };
  }
  return { ok: false, url: undefined, body: undefined, payload: undefined, errors, sawResponse };
}
