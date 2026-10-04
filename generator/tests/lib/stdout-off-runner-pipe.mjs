/**
 * Import con effetto collaterale: dentro il figlio di `node --test`, i log
 * informativi (`console.log`, `console.info`, `console.debug`) escono su
 * STDERR invece che su stdout.
 *
 * ## Perche'
 *
 * Con l'isolamento a processo il figlio di ogni file di test serializza gli
 * eventi del runner in frame V8 su STDOUT, e il padre li riassembla dalle
 * letture della pipe. Su Node 22 (la versione dei workflow) il primo byte di un
 * header spezzato fra due letture finisce in un buffer a se': se davanti c'e'
 * testo non serializzato, il parser lo scarta col testo, legge il frame
 * successivo disallineato e il file intero fallisce con «Unable to deserialize
 * cloned data due to invalid or unsupported version» a subtest verdi (issue
 * 1819 del corpus). Il codice sotto test logga con `console.log` per buone
 * ragioni — i workflow leggono quelle righe, `::warning::` compresi — quindi
 * il log resta, cambia canale.
 *
 * ## Come si usa
 *
 * Come PRIMO import del file di test, prima dei moduli che loggano anche a
 * livello di modulo:
 *
 *     import './lib/stdout-off-runner-pipe.mjs';
 *
 * Un caso che asserisce su un log puo' ancora sostituire `console.log` con una
 * spia e ripristinarlo: il redirect e' solo il valore di partenza. Il redirect
 * usa il `console.error` ORIGINALE, quindi una spia su `console.error` non
 * riceve all'improvviso anche le righe di `console.log`.
 *
 * Fuori dal figlio del runner (file eseguito con `node file.test.mjs`, o con
 * `--test-isolation=none`) non fa niente: li' stdout non porta frame.
 *
 * Il gate che lo rende necessario e' `scripts/ci/check-node-test-stdout.mjs`.
 */

export const RUNNER_CHILD_CONTEXT = 'child-v8';

export function routeInfoLogsToStderr(target = console, env = process.env) {
  if (env.NODE_TEST_CONTEXT !== RUNNER_CHILD_CONTEXT) return false;
  const error = target.error;
  const toStderr = (...args) => error.apply(target, args);
  target.log = toStderr;
  target.info = toStderr;
  target.debug = toStderr;
  return true;
}

routeInfoLogsToStderr();
