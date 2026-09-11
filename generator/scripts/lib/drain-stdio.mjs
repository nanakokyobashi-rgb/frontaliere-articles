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
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, boundedTimeout);

    const finishOne = () => {
      if (settled) return;
      pending -= 1;
      if (pending > 0) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    for (const stream of streams) {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        stream.off?.('error', finish);
        stream.off?.('close', finish);
        finishOne();
      };
      // EPIPE/close puo' arrivare asincrono: assorbirlo qui mantiene il
      // contratto "best-effort" senza installare un listener permanente.
      stream.once?.('error', finish);
      stream.once?.('close', finish);
      try {
        stream.write('', finish);
      } catch {
        finish();
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
