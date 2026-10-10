/**
 * Fetch with a referenced timeout that covers both response headers and body
 * consumption.
 *
 * `AbortSignal.timeout()` uses an unref'd timer, and clearing a regular timer
 * as soon as `fetch()` returns only protects the headers.  A provider can still
 * leave `response.json()`/`response.text()` pending forever after returning a
 * successful response.  Keep the timer and merged abort signal alive until a
 * body-reading method settles.
 */

const BODY_METHODS = new Set(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

function withBodyDeadline(response, cleanup) {
  return new Proxy(response, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (BODY_METHODS.has(property)) {
        // Defer invocation so a synchronous brand/type error still reaches
        // finally(cleanup), rather than leaking the referenced timer.
        return (...args) => Promise.resolve().then(() => value.apply(target, args)).finally(cleanup);
      }
      // Response methods such as clone() are brand-checked too. Bind them to
      // the real Response while leaving body readers under the deadline above.
      return value.bind(target);
    },
  });
}

/**
 * @param {string|URL} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Response>}
 */
export async function fetchWithRefTimeout(
  url,
  options = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
) {
  const { signal: upstreamSignal, ...requestOptions } = options;
  const controller = new AbortController();
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.floor(timeoutMs))
    : DEFAULT_FETCH_TIMEOUT_MS;
  let cleaned = false;
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
  }, effectiveTimeoutMs);
  const forwardAbort = () => controller.abort(upstreamSignal.reason);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', forwardAbort);
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      forwardAbort();
    } else {
      upstreamSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  try {
    const response = await fetchImpl(url, { ...requestOptions, signal: controller.signal });
    // HEAD/204-style responses have no body to protect; ordinary responses
    // release the timer only after json/text/etc. has finished below.
    if (response.body === null) cleanup();
    return withBodyDeadline(response, cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
}
