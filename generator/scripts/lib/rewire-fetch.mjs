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
const REWIRE_RESPONSE_CANCEL_TIMEOUT_MS = 1_000;

function boundedTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_REWIRE_FETCH_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.floor(numeric)), MAX_REWIRE_FETCH_TIMEOUT_MS);
}

export const REWIRE_FETCH_TIMEOUT_MS = boundedTimeoutMs(
  process.env.REWIRE_FETCH_TIMEOUT_MS || DEFAULT_REWIRE_FETCH_TIMEOUT_MS,
);

/**
 * Keep response cleanup bounded and independent from the fetch verdict. An
 * abort signal is only a cancellation hint: a late response or a reader can
 * ignore it, and a broken upstream can even leave `cancel()` pending.
 */
async function awaitRewireResponseCleanup(cleanup) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(cleanup),
      new Promise((resolve) => {
        timer = setTimeout(resolve, REWIRE_RESPONSE_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Cleanup must never replace the fetch/retry verdict.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Cancel a response body or its active reader, safely and idempotently.
 *
 * The optional reader is the one owned by `readRewireResponseBody`; using it
 * matters while a body read is pending because `response.body.cancel()` is
 * rejected by a locked stream. Late responses have no reader yet, so their
 * unlocked body is cancelled directly. Both paths are best effort and
 * bounded: a broken upstream must not hold a retry forever.
 *
 * @param {Response|undefined} response
 * @param {{cancel?: () => Promise<unknown>|unknown, releaseLock?: () => void}|null} [activeReader]
 */
export async function cancelRewireResponseBody(response, activeReader = null) {
  let reader = activeReader;
  let cancel;
  try {
    const body = response?.body;
    if (typeof reader?.cancel === 'function') {
      cancel = () => reader.cancel();
    } else if (typeof body?.cancel === 'function') {
      cancel = () => body.cancel();
    } else if (body?.locked !== true && typeof body?.getReader === 'function') {
      try {
        reader = body.getReader();
        cancel = () => reader.cancel();
      } catch {
        // A minimal fetch double or an already-claimed stream may not expose
        // a cancellable reader. There is nothing further to release here.
      }
    }
    if (cancel) await awaitRewireResponseCleanup(cancel);
  } catch {
    // A response body is transport cleanup, never the authoritative error.
  } finally {
    try { reader?.releaseLock?.(); } catch { /* cleanup stays best effort */ }
  }
}

/**
 * Read a response body while retaining its reader for deadline cleanup.
 * Minimal fetch doubles may only implement `text()`, so keep that fallback.
 */
async function readRewireResponseBody(response, onReader) {
  const body = response?.body;
  if (typeof body?.getReader !== 'function') return response.text();

  const reader = body.getReader();
  onReader(reader);
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      if (value == null) continue;
      text += typeof value === 'string'
        ? value
        : decoder.decode(value, { stream: true });
    }
  } finally {
    onReader(null);
    try { reader.releaseLock(); } catch { /* cancellation owns the verdict */ }
  }
}

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
      let cancelResponse = false;
      let activeReader = null;
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
      const responsePromise = Promise.resolve().then(() => (
        fetchImpl(url, { redirect: 'follow', headers, signal: controller.signal })
      ));
      responsePromise.then((lateResponse) => {
        if (timedOut) void cancelRewireResponseBody(lateResponse);
      }, () => {});
      try {
        res = await Promise.race([
          responsePromise,
          deadline,
        ]);
        if (res.ok) {
          body = await Promise.race([
            readRewireResponseBody(res, (reader) => { activeReader = reader; }),
            deadline,
          ]);
        } else {
          cancelResponse = true;
        }
      } catch (error) {
        cancelResponse = true;
        if (timedOut) throw timeoutError();
        throw error;
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (cancelResponse || timedOut) {
          await cancelRewireResponseBody(res, activeReader);
        }
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
