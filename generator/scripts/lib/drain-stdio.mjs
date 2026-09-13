/**
 * Drena stdout/stderr prima di un'uscita esplicita.
 *
 * Su POSIX Node scrive in modo asincrono quando questi stream sono pipe, come
 * nei job GitHub Actions. `process.exit()` tronca cio' che resta nel buffer;
 * una write vuota con callback e' la barriera portabile che aspetta anche le
 * write accodate prima di lei.
 *
 * Il drain e' best-effort: un consumer fermo, chiuso o in errore non deve mai
 * trasformare un'uscita gia' decisa in un processo appeso o in un'eccezione.
 * close/error non confermano la consegna: in quei casi resta valido solo il
 * timeout bounded, mentre la callback di write e' l'unica conferma positiva.
 */

const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

function writableStdio() {
  return [process.stdout, process.stderr].filter((stream) =>
    stream
    && typeof stream.write === 'function'
    && !stream.writableEnded
    && !stream.destroyed
    && (stream.writableLength > 0 || stream.writableNeedDrain),
  );
}

/**
 * Attende che i byte gia' accodati su stdout/stderr siano consegnati.
 *
 * @param {number} [timeoutMs] tetto complessivo di attesa
 * @returns {Promise<void>} non rigetta mai
 */
export function drainStdio(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
  const streams = writableStdio();
  if (streams.length === 0) return Promise.resolve();

  const rawTimeout = Number(timeoutMs);
  const boundedTimeout = Number.isFinite(rawTimeout) ? Math.max(0, rawTimeout) : DEFAULT_DRAIN_TIMEOUT_MS;

  return new Promise((resolve) => {
    let pending = streams.length;
    let settled = false;
    const cleanups = [];
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      resolve();
    };
    const timer = setTimeout(settle, boundedTimeout);

    const finishOne = () => {
      if (settled) return;
      pending -= 1;
      if (pending > 0) return;
      settle();
    };

    for (const stream of streams) {
      if (settled) break;
      let done = false;
      let consumerFailed = false;
      const observeFailure = () => {
        // A closed/errored consumer proves only that the barrier could not be
        // confirmed. Keep the listener until callback or timeout so the error
        // is absorbed without treating it as a successful flush.
        consumerFailed = true;
      };
      const cleanup = () => {
        stream.off?.('error', observeFailure);
        stream.off?.('close', observeFailure);
      };
      cleanups.push(cleanup);
      stream.on?.('error', observeFailure);
      stream.on?.('close', observeFailure);
      const finish = (error) => {
        if (done || error || consumerFailed) return;
        done = true;
        cleanup();
        finishOne();
      };
      const fail = () => {
        if (done) return;
        done = true;
        cleanup();
        // A synchronous throw means this write was never accepted by the
        // stream; unlike an async error/close, no callback can still confirm
        // delivery, so it is safe to release this stream's pending slot.
        finishOne();
      };
      try {
        stream.write('', finish);
      } catch {
        fail();
      }
    }
  });
}

/** Drena gli stream e poi termina con il codice richiesto. */
export async function exitAfterDrain(code, timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
  // Il timer del drain e' deliberatamente bounded; fissare subito il codice
  // evita che un'uscita naturale durante un timeout venga riportata come 0.
  process.exitCode = code;
  await drainStdio(timeoutMs);
  process.exit(code);
}
