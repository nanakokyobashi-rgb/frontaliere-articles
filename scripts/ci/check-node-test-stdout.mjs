#!/usr/bin/env node
/**
 * Gate: nessun file di test scrive su stdout fuori dal protocollo node:test.
 *
 * ## Perche' e' un gate e non una preferenza di stile
 *
 * Con l'isolamento a processo (il default di `node --test`) il figlio di ogni
 * file serializza gli eventi in frame V8 SU STDOUT, e il padre li riassembla
 * dalle letture della pipe. Un `console.log` del codice sotto test finisce sulla
 * stessa pipe. Su Node 22 (la versione di `tests.yml`) `FileTest.parseMessage`
 * tiene da parte il primo byte di un header spezzato fra due letture come un
 * buffer a se': se davanti c'e' testo non serializzato, `#processRawBuffer` lo
 * scarta insieme al testo, il frame successivo viene letto disallineato e il
 * file fallisce con «Unable to deserialize cloned data due to invalid or
 * unsupported version» con tutti i subtest verdi. Node 26 tiene il byte in un
 * flag (`#pendingPartialV8Header`) e non ha piu' il difetto.
 *
 * Il flake e' raro (dipende da dove il kernel spezza la pipe), il suo
 * prerequisito no: e' deterministico, e il reporter strutturato lo vede come
 * evento `test:stdout`. Questo script rende rosso il prerequisito, cosi' un
 * file che inizia a scrivere su stdout viene corretto alla PR che lo introduce
 * e non alla decima run rossa su `main` (issue 1819 del corpus: 26 ricorrenze
 * dal 2026-09-24, le ultime su `score-ledger-persistence.test.mjs`).
 *
 * ## Come si corregge un file segnalato
 *
 * Il log resta, cambia canale: il test cattura `console.log` dove esercita il
 * percorso che logga (come gia' fa con `console.error`), oppure il log
 * informativo va su stderr (`console.error`/`console.warn`), che non condivide
 * la pipe col protocollo. Un sottoprocesso con `stdio: 'inherit'` scrive sullo
 * stesso descrittore: va reso `pipe` o `ignore`.
 *
 * Uso: node scripts/ci/check-node-test-stdout.mjs <report.json>
 * Exit 0 = nessuno scrittore; 1 = almeno un file scrive su stdout; 2 = report
 * illeggibile (un report rotto non e' una prova di pulizia).
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function findStdoutWriters(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.stdoutWriters)) {
    throw new Error('report senza `stdoutWriters`: il reporter strutturato non e\' quello del repo o e\' troppo vecchio');
  }
  return report.stdoutWriters.filter((w) => w && Number(w.bytes) > 0);
}

export function formatAnnotations(writers) {
  return writers.map((w) => {
    const sample = String(w.sample || '').replace(/\r?\n/g, ' ⏎ ').slice(0, 200);
    return `::error file=${w.file},title=node:test stdout fuori protocollo::${w.file} ha scritto ${w.bytes} byte su stdout (${w.events} eventi test:stdout), sulla pipe dei frame del runner: su Node 22 basta per «Unable to deserialize cloned data». Primo frammento: ${sample}`;
  });
}

function main(argv) {
  const reportFile = argv[0];
  if (!reportFile) {
    console.error('uso: check-node-test-stdout.mjs <report.json>');
    return 2;
  }
  let writers;
  try {
    writers = findStdoutWriters(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
  } catch (err) {
    console.error(`::error::check-node-test-stdout: report ${reportFile} illeggibile: ${err?.message || err}`);
    return 2;
  }
  if (writers.length === 0) {
    console.error('check-node-test-stdout: nessun file di test scrive su stdout fuori dal protocollo node:test.');
    return 0;
  }
  for (const line of formatAnnotations(writers)) console.error(line);
  console.error(`check-node-test-stdout: ${writers.length} file scrivono su stdout fuori dal protocollo node:test (vedi l'intestazione di scripts/ci/check-node-test-stdout.mjs per la correzione).`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
