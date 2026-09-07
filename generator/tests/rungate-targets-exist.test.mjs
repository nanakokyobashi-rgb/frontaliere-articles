/**
 * rungate-targets-exist.test.mjs — un gate invocato per nome deve esistere ED
 * essere caricabile.
 *
 * ## Il buco che chiude
 *
 * `collect-followup-batch.mjs` non importa i suoi gate: li lancia come
 * sottoprocessi con `runGate(nome, ...)`, che risolve `path.join(HERE, nome)` e
 * cattura QUALUNQUE eccezione ricadendo su `null` = «inconclusive» =
 * proceed-safe. Quella cattura e' deliberata e giusta per l'incertezza (un body
 * illeggibile non deve far perdere una follow-up di una PR organica), ma
 * inghiotte allo stesso modo l'`ENOENT` di un file che non c'e' e il
 * `SyntaxError` di un import che non risolve. Tre condizioni opposte, una sola
 * uscita silenziosa.
 *
 * Costo misurato il 2026-09-07, prima di questa fix: `is-followup-fix-pr.mjs` e
 * `followup-has-candidates.mjs` non esistevano in questo repo. Il gate
 * grandchild non era RARAMENTE inconclusive, lo era SEMPRE — 46 PR su 46 in tre
 * run di `post-merge-followup.yml`, zero soppressioni in assoluto, contro 58 su
 * 96 sul sito. Effetto: 90 follow-up su 285 (31,6%) erano nipoti, cioe' coniate
 * dalla PR che stava fixando un'altra follow-up, con catene fino a sei
 * generazioni.
 *
 * ## Perche' ci sono DUE asserzioni e non una
 *
 * La prima versione di questo test controllava solo l'esistenza dei file, ed
 * era verde su un gate rotto: copiati i due `.mjs`, `followup-has-candidates`
 * moriva comunque con
 * `SyntaxError: The requested module './lib/constants.mjs' does not provide an
 * export named 'isReviewerBot'` — il file c'era, il simbolo no, perche'
 * `constants.mjs` e' voce `adapted` nel manifest e il gemello del corpus non
 * aveva quell'helper. Un test che vede solo il primo dei due modi di fallire
 * lascia in piedi esattamente il silenzio che deve rompere.
 *
 * ## Perche' statico e non `import()`
 *
 * Questi gate hanno codice top-level che parte all'import (leggono
 * `process.env`, e in generale in questo repo un entrypoint importato per
 * sbaglio ha gia' scritto dati veri). Il test quindi non li esegue e non li
 * importa: legge gli `import { … } from './rel'` e verifica che ogni nome
 * importato compaia come export nel file bersaglio. Copre il caso reale a costo
 * zero e senza effetti collaterali.
 *
 * Il test NON decide cosa debba fare `runGate` a runtime quando il gate manca
 * (urlare, fallire, procedere in silenzio): quella e' una decisione aperta. Qui
 * l'invariante e' piu' debole e piu' economico — in CI il gate c'e' e si carica.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CI_DIR = path.join(ROOT, 'scripts/ci');
const CALLER = path.join(CI_DIR, 'collect-followup-batch.mjs');

// `runGate('nome.mjs', ...)` — solo il primo argomento, che e' il nome del file.
const RUN_GATE_CALL = /\brunGate\(\s*(['"])([^'"]+)\1/g;
// `import { a, b as c } from './rel.mjs'` — solo gli import NOMINATI e RELATIVI.
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])(\.[^'"]+)\2/g;

/** I nomi esportati da un modulo, letti staticamente. Nessuna esecuzione. */
function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // `export { a, b as c }` — conta il nome ESPORTATO, cioe' l'alias quando c'e'.
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim();
      if (!spec) continue;
      const as = spec.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(as ? as[1] : spec);
    }
  }
  return names;
}

function gateNames() {
  const source = fs.readFileSync(CALLER, 'utf8');
  return [...source.matchAll(RUN_GATE_CALL)].map((m) => m[2]);
}

test('ogni gate invocato da runGate() esiste in scripts/ci/', () => {
  const names = gateNames();

  // Guardia sul test stesso: se un refactor rinomina `runGate` o passa il nome
  // da una variabile, il regex smette di trovare niente e il test diventerebbe
  // verde a vuoto — che e' il falso verde che questo file esiste per impedire.
  assert.ok(
    names.length >= 2,
    `Attese almeno 2 chiamate runGate() in ${path.relative(ROOT, CALLER)}, trovate ${names.length}. ` +
    'Se le chiamate sono cambiate forma, aggiorna RUN_GATE_CALL: un test che non trova nulla non protegge nulla.',
  );

  const missing = names.filter((n) => !fs.existsSync(path.join(CI_DIR, n)));
  assert.deepEqual(
    missing,
    [],
    `Gate invocati per nome ma assenti da scripts/ci/: ${missing.join(', ')}. ` +
    "runGate() ne inghiotte l'ENOENT e ricade su proceed-safe, quindi il gate risulterebbe " +
    'inconclusive a ogni PR senza che nulla lo segnali.',
  );
});

test('ogni import nominato di un gate risolve a un export che esiste', () => {
  const broken = [];

  for (const gate of gateNames()) {
    const gatePath = path.join(CI_DIR, gate);
    if (!fs.existsSync(gatePath)) continue; // gia' coperto dal test sopra

    const source = fs.readFileSync(gatePath, 'utf8');
    for (const imp of source.matchAll(NAMED_IMPORT)) {
      const target = path.resolve(path.dirname(gatePath), imp[3]);
      if (!fs.existsSync(target)) {
        broken.push(`${gate}: il modulo ${imp[3]} non esiste`);
        continue;
      }
      const available = exportedNames(fs.readFileSync(target, 'utf8'));
      for (const part of imp[1].split(',')) {
        const wanted = part.trim().split(/\s+as\s+/)[0].trim();
        if (wanted && !available.has(wanted)) {
          broken.push(`${gate}: ${imp[3]} non esporta \`${wanted}\``);
        }
      }
    }
  }

  assert.deepEqual(
    broken,
    [],
    'Import nominati che non risolvono:\n  ' + broken.join('\n  ') +
    "\nA runtime e' un SyntaxError all'import, che runGate() inghiotte come " +
    'inconclusive: il gate non gira e nessuno se ne accorge. Nota che i gemelli ' +
    "`adapted` del manifest possono divergere: l'export va aggiunto QUI, non copiato dal sito.",
  );
});
