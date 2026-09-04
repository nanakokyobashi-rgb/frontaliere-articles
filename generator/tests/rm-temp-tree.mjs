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
 */

import { rmSync } from 'node:fs';

/** Codici che significano «qualcuno ci sta ancora scrivendo», non «non si puo' fare». */
const TRANSIENT = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']);

/** Attesa SINCRONA: il teardown dei test e' sincrono, e un `await` qui vorrebbe dire
 *  cambiare la firma di ogni `finally` che chiama questa funzione. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `rmSync(dir, { recursive, force })` ritentato dall'inizio finche' l'errore e'
 * transitorio. Backoff lineare: 50, 100, ... ms, ~1.8s in totale con gli 8
 * tentativi di default — due ordini di grandezza sopra i ~100ms in cui il gc
 * staccato di git finisce, e comunque limitato.
 *
 * L'ultimo tentativo rilancia: una directory che dopo 1.8s e' ancora occupata
 * non e' la race di git, ed e' giusto che il test lo dica invece di ingoiarlo.
 */
export function rmTempTree(dir, { attempts = 8, delayMs = 50 } = {}) {
  for (let i = 1; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= attempts || !TRANSIENT.has(err.code)) throw err;
      sleepSync(delayMs * i);
    }
  }
}
