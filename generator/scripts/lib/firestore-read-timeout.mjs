/**
 * Bound a Firestore Admin operation even though DocumentReference, Query, and
 * batch commits do not accept a common AbortSignal. The late promise remains
 * observed after the deadline, so a rejected RPC cannot become unhandled.
 */

export const DEFAULT_FIRESTORE_READ_TIMEOUT_MS = 15_000;

export class FirestoreReadTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'FirestoreReadTimeoutError';
    this.code = 'FIRESTORE_READ_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run one Firestore operation with a referenced timeout.
 *
 * The second argument may be a timeout in milliseconds or an options object:
 * `{ timeoutMs, label, onTimeout }`. `onTimeout` is deliberately best-effort
 * and is not awaited; callers can use it to terminate an otherwise dedicated
 * Firestore client without extending the deadline.
 *
 * @param {() => Promise<unknown>} read
 * @param {number|{timeoutMs?: number, label?: string, onTimeout?: Function}} [timeoutOrOptions]
 * @param {{label?: string, onTimeout?: Function}} [options]
 * @returns {Promise<unknown>}
 */
export function withFirestoreReadTimeout(
  read,
  timeoutOrOptions = DEFAULT_FIRESTORE_READ_TIMEOUT_MS,
  options = {},
) {
  if (typeof read !== 'function') {
    throw new TypeError('withFirestoreReadTimeout: read deve essere una funzione');
  }

  const objectOptions = timeoutOrOptions !== null
    && typeof timeoutOrOptions === 'object'
    ? timeoutOrOptions
    : options;
  const requestedTimeout = timeoutOrOptions !== null
    && typeof timeoutOrOptions === 'object'
    ? objectOptions.timeoutMs
    : timeoutOrOptions;
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(1, Math.floor(requestedTimeout))
    : DEFAULT_FIRESTORE_READ_TIMEOUT_MS;
  const label = typeof objectOptions.label === 'string' && objectOptions.label.trim()
    ? objectOptions.label.trim()
    : 'Firestore read';
  const onTimeout = typeof objectOptions.onTimeout === 'function'
    ? objectOptions.onTimeout
    : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const timeoutError = new FirestoreReadTimeoutError(label, timeoutMs);
      if (onTimeout) {
        try {
          Promise.resolve(onTimeout(timeoutError)).catch(() => {});
        } catch {
          // Cleanup must not replace the bounded read outcome.
        }
      }
      reject(timeoutError);
    }, timeoutMs);

    // Attach both handlers immediately. Firestore cannot be cancelled through
    // one shared AbortSignal, so the RPC may settle after this promise rejects.
    Promise.resolve()
      .then(read)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}
