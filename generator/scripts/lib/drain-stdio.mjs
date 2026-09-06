/**
 * Svuota stdout/stderr prima di un `process.exit()`.
 *
 * Il difetto che chiude (issue #983, follow-up di #945). Su POSIX Node scrive
 * su stdout/stderr in modo ASINCRONO quando sono pipe — ed e' esattamente il
 * caso di un job GitHub Actions, dove il log e' una pipe verso il runner.
 * `process.exit()` non aspetta quelle write: quello che e' ancora nel buffer
 * del flusso viene buttato via. Misurato qui con una pipe reale: 200.013 byte
 * stampati, 65.536 arrivati, e la riga finale sparita.
 *
 * Chi ne muore per primo e' la telemetria di fine run, perche' e' l'ultima
 * cosa che viene stampata prima dell'uscita: la riga `resolver flaps:` del
 * riepilogo AI e' il denominatore di #848 item 3, e le run che escono
 * `deferred`/`error` — le uniche in cui `silent` e' diverso da zero, cioe' meta'
 * del campione — sono anche le uniche che escono da `process.exit()` invece che
 * per esaurimento dell'event loop. Una riga persa li' non si distingue da una
 * riga mai stampata: torna lo «zero indistinguibile da nessuna misura».
 *
 * `write('', cb)` e' il modo portabile di chiedere «richiamami quando tutto il
 * gia' accodato e' uscito»: la callback di una write viene invocata in ordine,
 * dopo che i chunk precedenti sono stati consegnati. I byte ancora in volo
 * restano contati in `writableLength` finche' la write non completa, quindi il
 * corto circuito su `writableLength === 0` non puo' saltare una write pendente.
 *
 * Bounded per costruzione, e non lancia: come il flush del ledger dei punteggi,
 * un buffer di log non deve mai poter appendere o far fallire un'uscita. Se il
 * consumatore della pipe e' sparito (EPIPE) o e' fermo, si esce lo stesso dopo
 * `timeoutMs`.
 *
 * @param {number} [timeoutMs] tetto di attesa complessivo.
 * @returns {Promise<void>}
 */
export function drainStdio(timeoutMs = 2000) {
  const streams = [process.stdout, process.stderr].filter(
    (s) => s && typeof s.write === 'function' && !s.writableEnded && s.writableLength > 0,
  );
  if (streams.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let pending = streams.length;
    let settled = false;
    const done = () => {
      if (settled) return;
      pending -= 1;
      if (pending > 0) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, timeoutMs);
    // Il timer non deve tenere vivo l'event loop: se il drain rientra prima,
    // il processo esce per conto suo senza aspettare il tetto.
    if (typeof timer.unref === 'function') timer.unref();

    for (const s of streams) {
      try {
        s.write('', done);
      } catch {
        done();
      }
    }
  });
}

/**
 * `drainStdio()` + `process.exit(code)`, per i percorsi che non hanno altro da
 * fare prima di uscire. Chi ha anche un flush da attendere (il ledger dei
 * punteggi in `create-article.mjs`) chiama i due pezzi nell'ordine che gli
 * serve: il drain va comunque per ULTIMO, perche' anche il flush puo' stampare.
 *
 * @param {number} code
 * @param {number} [timeoutMs]
 */
export async function exitAfterDrain(code, timeoutMs = 2000) {
  // `exitCode` PRIMA del drain: il tetto e' un timer `unref()`ato, quindi se il
  // flusso restasse fermo senza altro lavoro in coda il processo uscirebbe da
  // solo — e uscirebbe 0, cioe' un fallimento riportato come successo.
  process.exitCode = code;
  await drainStdio(timeoutMs);
  process.exit(code);
}
