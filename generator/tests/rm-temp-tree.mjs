/**
 * rm-temp-tree.mjs — rimozione di un albero temporaneo che un ALTRO processo
 * puo' ancora star scrivendo.
 *
 * ## Il difetto
 *
 * I test che esercitano gli helper del ciclo costruiscono repo git VERI sotto
 * `os.tmpdir()` e li tolgono in `finally` con
 * `rmSync(dir, { recursive: true, force: true })`. Git pero' non ha finito
 * quando il comando in primo piano esce: `gc --auto` si stacca (`gc.autoDetach`
 * e' true di default) e continua a scrivere dentro `.git/`. In quella finestra
 * la rimozione vede la cartella ripopolarsi e alza **ENOTEMPTY**, che `force`
 * NON copre — `force` sopprime solo ENOENT.
 *
 * E' il rosso di `Generator CI` sul push di c17fe385d:
 * `ENOTEMPTY: directory not empty, rmdir '/tmp/rebase-onto-remote-NTP1O0/work/.git'`
 * da `rebase-onto-remote.test.mjs:163`, mentre la run `pull_request` sullo
 * STESSO sha era verde. Un flake, quindi: 1 test su 2740, in teardown, con
 * l'asserzione gia' passata.
 *
 * ## Perche' non `maxRetries`/`retryDelay` di `rmSync`
 *
 * E' la fix ovvia ed e' quella sbagliata, misurata su Node 22.23.2 con un
 * processo separato che ricrea i figli mentre la rimozione scende:
 *
 *     rmSync{force, maxRetries:10, retryDelay:50} → ENOTEMPTY dopo 2833ms
 *     retry sull'INTERO rimraf                    → ok dopo 121ms
 *
 * Il motivo sta in `node:internal/fs/rimraf`: sul ramo ENOTEMPTY legge i figli
 * UNA volta, li rimuove, e poi ritenta il solo `rmdirSync` del padre. I file
 * ricomparsi dopo quella `readdirSync` non vengono mai riletti, quindi ogni
 * tentativo successivo trova la stessa cartella non vuota e i retry bruciano
 * solo tempo. Ripartire dall'alto e' cio' che rilegge l'albero.
 *
 * Non e' un'asserzione indebolita: nessun test cambia cosa verifica: cambia
 * solo che il teardown aspetta che git abbia finito invece di correre con lui.
 *
 * ## Il secondo difetto: l'errore di teardown che SOSTITUISCE l'asserzione (#817)
 *
 * Ogni chiamante e' `try { ...asserzioni... } finally { rmTempTree(dir) }`. Una
 * eccezione lanciata dal `finally` SCARTA quella in volo: se il corpo era gia'
 * fallito con un'asserzione, il report mostra `ENOTEMPTY` al posto della
 * diagnosi vera. E' la stessa perdita di diagnosi che il retry sopra esiste per
 * evitare — con in piu' ~1.8s di finestra in cui capitarci.
 *
 * Un `finally` non puo' sapere se un'eccezione sta gia' propagando, e mettere
 * il `catch` che lo scoprirebbe in ~20 call site e' una modifica meccanica che
 * si dimentica al 21esimo. Quindi `rmTempTree` **non rilancia piu'**: registra
 * il fallimento e lo fa valere a fine processo (`process.on('exit')`), dove
 * stampa la diagnosi e mette `exitCode = 1`. Il file di test resta ROSSO —
 * `node --test` legge l'uscita non-zero del figlio come fallimento — ma
 * l'asserzione del corpo arriva intatta al report, cioe' entrambe le diagnosi
 * sopravvivono invece di eliminarsi a vicenda.
 *
 * Non e' un gate abbassato: prima un teardown fallito rendeva rosso il test
 * sbagliato, adesso rende rosso il file con la sua riga. Un'eccezione ingoiata
 * lo era; una che sposta il verdetto a fine processo no.
 */

import { rmSync } from 'node:fs';

/** Codici che significano «qualcuno ci sta ancora scrivendo», non «non si puo' fare». */
const TRANSIENT = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']);

/** Attesa SINCRONA: il teardown dei test e' sincrono, e un `await` qui vorrebbe dire
 *  cambiare la firma di ogni `finally` che chiama questa funzione. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Teardown falliti, riportati a fine processo invece che dal `finally`. */
const leaks = [];
let exitHookInstalled = false;

function reportAtExit(dir, err) {
  leaks.push({ dir, err });
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    if (!leaks.length) return;
    for (const { dir: d, err: e } of leaks) {
      console.error(
        `[rm-temp-tree] teardown NON riuscito su ${d}: ${e.code || 'errore'} ${e.message}\n` +
          '  (non rilanciato dal finally per non sostituire l\'asserzione del test; ' +
          'il file resta rosso via exit code)',
      );
    }
    // Dentro un handler 'exit' l'assegnazione e' ancora letta da Node per
    // determinare il codice finale: e' cio' che rende rosso il file di test.
    process.exitCode = 1;
  });
}

/** I teardown falliti finora, per i test di questo modulo. Non svuota. */
export function tempTreeLeaks() {
  return leaks.map(({ dir, err }) => ({ dir, code: err.code || null, message: err.message }));
}

/**
 * `rmSync(dir, { recursive, force })` ritentato dall'inizio finche' l'errore e'
 * transitorio. Backoff lineare: 50, 100, ... ms, ~1.8s in totale con gli 8
 * tentativi di default — due ordini di grandezza sopra i ~100ms in cui il gc
 * staccato di git finisce, e comunque limitato.
 *
 * Esaurita la pazienza (o su un errore non transitorio) **non rilancia**: la
 * chiamata avviene in un `finally`, dove lanciare scarterebbe l'eccezione in
 * volo. Il fallimento viene registrato e riportato a fine processo, con
 * `exitCode = 1` — il verdetto non si perde, l'asserzione nemmeno.
 *
 * @param {string} dir
 * @param {{attempts?: number, delayMs?: number, rmImpl?: (dir: string, opts: object) => void}} [opts]
 */
export function rmTempTree(dir, { attempts = 8, delayMs = 50, rmImpl = rmSync } = {}) {
  for (let i = 1; ; i++) {
    try {
      rmImpl(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= attempts || !TRANSIENT.has(err.code)) {
        reportAtExit(dir, err);
        return;
      }
      sleepSync(delayMs * i);
    }
  }
}
