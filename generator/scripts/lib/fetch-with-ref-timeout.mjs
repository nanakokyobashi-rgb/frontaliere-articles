/**
 * Fetch with a referenced timeout that covers both response headers and body
 * consumption.
 *
 * `AbortSignal.timeout()` uses an unref'd timer, and an abort signal is only a
 * cancellation hint: a provider can leave either `fetch()` or
 * `response.json()`/`response.text()` pending forever after the deadline.
 * Keep a referenced timer and race both phases against an explicit rejection;
 * the abort remains the best-effort transport cancellation.
 */

const BODY_METHODS = new Set(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);
const ACTIVE_DEADLINES = new WeakMap();
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Cleanup must not depend on a non-standard AbortSignal being cooperative. */
export function removeAbortListenerSafely(signal, listener) {
  try {
    signal?.removeEventListener?.('abort', listener);
  } catch {
    // A throwing adapter must not keep the referenced deadline alive.
  }
}

function bodyChunkToBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return Uint8Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError('unsupported response body chunk');
}

async function readBodyBytesWithReader(response, onReader) {
  const body = response?.body;
  if (typeof body?.getReader !== 'function') return null;

  const reader = body.getReader();
  onReader(reader);
  const chunks = [];
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value == null) continue;
      const chunk = bodyChunkToBytes(value);
      chunks.push(chunk);
      totalLength += chunk.byteLength;
    }
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    onReader(null);
    try { reader.releaseLock?.(); } catch { /* cleanup stays best effort */ }
  }
}

async function readBodyMethod(response, property, args, onReader) {
  const body = response?.body;
  if (typeof body?.getReader !== 'function') {
    const value = Reflect.get(response, property, response);
    return value.apply(response, args);
  }
  const bytes = await readBodyBytesWithReader(response, onReader);
  switch (property) {
    case 'arrayBuffer':
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    case 'blob':
      return new Blob([bytes], { type: response.headers?.get?.('content-type') || '' });
    case 'bytes':
      return bytes;
    case 'formData': {
      const init = response.headers ? { headers: response.headers } : undefined;
      return new Response(bytes, init).formData();
    }
    case 'json':
      return JSON.parse(new TextDecoder().decode(bytes));
    case 'text':
      return new TextDecoder().decode(bytes);
    default: {
      const value = Reflect.get(response, property, response);
      return value.apply(response, args);
    }
  }
}

function withBodyDeadline(response, cleanup, timeoutPromise) {
  let wrappedResponse;
  let activeReader = null;
  const trackedCleanup = () => {
    cleanup();
    ACTIVE_DEADLINES.delete(response);
    if (wrappedResponse) ACTIVE_DEADLINES.delete(wrappedResponse);
  };
  const deadline = {
    response,
    cleanup: trackedCleanup,
    cancel: () => {
      const reader = activeReader;
      if (typeof reader?.cancel === 'function') return reader.cancel();
      return response?.body?.cancel?.();
    },
  };
  wrappedResponse = new Proxy(response, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (BODY_METHODS.has(property)) {
        // Defer invocation so a synchronous brand/type error still reaches
        // finally(cleanup), rather than leaking the referenced timer.
        return (...args) => Promise.race([
          Promise.resolve().then(() => readBodyMethod(
            target,
            property,
            args,
            (reader) => { activeReader = reader; },
          )),
          timeoutPromise,
        ]).finally(trackedCleanup);
      }
      // Response methods such as clone() are brand-checked too. Bind them to
      // the real Response while leaving body readers under the deadline above.
      return value.bind(target);
    },
  });
  ACTIVE_DEADLINES.set(response, deadline);
  ACTIVE_DEADLINES.set(wrappedResponse, deadline);
  return wrappedResponse;
}

function cancelBodyBestEffort(response) {
  const deadline = ACTIVE_DEADLINES.get(response);
  if (deadline) {
    try { Promise.resolve(deadline.cancel()).catch(() => {}); } catch { /* best effort */ }
    return;
  }
  try {
    const body = response?.body;
    if (typeof body?.cancel === 'function') {
      Promise.resolve(body.cancel()).catch(() => {});
    }
  } catch {
    // A body may be a minimal fetch double or expose a throwing cancel().
  }
}

/**
 * Release a response whose caller deliberately does not consume its body.
 *
 * Status-only branches must use this instead of returning/throwing with the
 * proxy still live: otherwise the referenced deadline and upstream listener
 * stay installed until the timeout. Body cancellation is best-effort because
 * cleanup must still happen for test doubles and unusual Response bodies.
 *
 * @param {Response} response
 */
export function releaseFetchWithRefTimeout(response) {
  const deadline = ACTIVE_DEADLINES.get(response);
  if (!deadline) return;
  try {
    cancelBodyBestEffort(deadline.response);
  } finally {
    deadline.cleanup();
  }
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
  let timeoutReject;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutReject = reject;
  });
  // The deadline may fire before a caller starts reading the body. Keep the
  // deferred rejection handled in that case; body readers race this same
  // promise when they are invoked.
  timeoutPromise.catch(() => {});
  let responseForCancellation;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const reason = new DOMException('The operation timed out', 'TimeoutError');
    controller.abort(reason);
    timeoutReject(reason);
    cancelBodyBestEffort(responseForCancellation);
  }, effectiveTimeoutMs);
  const forwardAbort = () => controller.abort(upstreamSignal.reason);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    removeAbortListenerSafely(upstreamSignal, forwardAbort);
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      forwardAbort();
    } else {
      upstreamSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  try {
    const fetchPromise = Promise.resolve().then(
      () => fetchImpl(url, { ...requestOptions, signal: controller.signal }),
    );
    // Abort is only a hint. If a fetch implementation ignores it and returns
    // a Response after the caller has already timed out, release that late
    // response body as well instead of leaking its transport resources.
    fetchPromise.then((response) => {
      if (timedOut) cancelBodyBestEffort(response);
    }, () => {});
    const response = await Promise.race([
      fetchPromise,
      timeoutPromise,
    ]);
    responseForCancellation = response;
    // HEAD/204-style responses have no body to protect; ordinary responses
    // release the timer only after json/text/etc. has finished below.
    if (response.body === null) {
      cleanup();
      return response;
    }
    return withBodyDeadline(response, cleanup, timeoutPromise);
  } catch (error) {
    cleanup();
    throw error;
  }
}
