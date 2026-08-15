/**
 * loop-scripts-closure.test.mjs — ogni import relativo degli script del ciclo
 * deve risolvere a un file che esiste.
 *
 * ## Perché esiste
 *
 * Gli script del ciclo autonomo arrivano qui copiati dal sito. `node --check`
 * su ognuno passa — la sintassi è valida — ma non segue gli import: un file
 * dimenticato nella copia resta invisibile finché qualcosa non prova a
 * caricarlo, in CI, sul percorso che conta.
 *
 * È successo davvero durante il porting: `auto-merge-eval.mjs` importava
 * `lib/mergePreviewCheck.mjs`, che non era stato copiato. Tutti i controlli di
 * sintassi erano verdi e l'auto-merge sarebbe fallito su OGNI PR con un
 * `ERR_MODULE_NOT_FOUND` prima ancora di valutare un gate — cioè il ciclo
 * sarebbe nato morto, esattamente come nel caso del check-run mancante.
 * Servivano tre giri per chiudere l'albero (mergePreviewCheck →
 * duplicateDeclarations, e secrets-scope-detect da un altro ramo).
 *
 * ## Perché risolve staticamente invece di importare
 *
 * Importare davvero i moduli li ESEGUE: quasi tutti hanno una modalità CLI, e
 * alcuni parlano con l'API di GitHub. Un test che chiama `gh` non è un test.
 * Qui si legge il testo e si risolvono i path, senza eseguire niente.
 *
 * Gli import di PACCHETTI (non relativi) non sono coperti: `typescript` è
 * risolto a runtime da `mergePreviewCheck.mjs`, che si dichiara saltato se
 * manca — quel caso è gestito lì, con la sua ragione.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIRS = ['scripts/ci', 'scripts/ci/lib', 'scripts/lib'];

// Solo import a inizio riga: così una riga di PROSA dentro un commento che
// cita un import (`// #2057: import {FX} from './comparatorHref'`) non viene
// scambiata per una dipendenza reale — un falso positivo che il porting ha
// prodotto davvero. `^[ \t]` e non `^\s`: `\s` mangia i newline e farebbe
// ripartire l'ancora a metà di un commento.
//
// La clausola fra `import` e `from` è `[^'";]*?`, non `.*?`, per DUE ragioni
// che vanno insieme:
//   - niente `\n` nella classe negata ⇒ un import BRACED SU PIÙ RIGHE viene
//     visto. Con `.*?` (che non attraversa i newline) non lo era, e questa
//     riga è stata cieca su 6 specificatori reali in 5 file — fra cui
//     `./lib/reopen-breaker.mjs` e `./lib/vitestCheck.mjs` di pr-autorebase,
//     cioè esattamente la classe che questo test esiste per chiudere: uno
//     script copiato dal sito senza una sua dipendenza. Il guard era verde
//     mentre il buco era aperto.
//   - vietare `'`, `"` e `;` impedisce al match non greedy di attraversare la
//     fine dello statement e agganciare la stringa di un import successivo:
//     una clausola di import contiene solo identificatori, virgole, graffe,
//     `as` e spazi, mai un apice o un punto e virgola.
// Il `from` è opzionale, così anche un side-effect import (`import './x.mjs'`)
// resta coperto.
const IMPORT_RE = /^[ \t]*import\s+(?:[^'";]*?\sfrom\s+)?(['"])([^'"]+)\1/gm;

/** Tutti gli specificatori importati da `src`, nell'ordine in cui compaiono. */
function importSpecifiers(src) {
  return [...src.matchAll(IMPORT_RE)].map((m) => m[2]);
}

function entryPoints() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.mjs')) out.push(path.join(d, f));
    }
  }
  return out;
}

test('ogni import relativo degli script del ciclo risolve a un file esistente', () => {
  const seen = new Set();
  const broken = [];

  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = fs.readFileSync(abs, 'utf8');
    for (const spec of importSpecifiers(src)) {
      if (!spec.startsWith('.')) continue;
      let target = path.normalize(path.join(path.dirname(rel), spec));
      if (!path.extname(target)) target += '.mjs';
      if (!fs.existsSync(path.join(ROOT, target))) {
        broken.push(`${rel} → ${spec} (atteso: ${target})`);
        continue;
      }
      walk(target);
    }
  };

  const roots = entryPoints();
  assert.ok(roots.length > 0, 'nessuno script trovato: i path di DIRS sono sbagliati?');
  for (const r of roots) walk(r);

  assert.deepEqual(
    broken,
    [],
    `Import non risolti — questi script fallirebbero a runtime con ERR_MODULE_NOT_FOUND, ` +
      `dopo essere passati indenni da node --check:\n  ${broken.join('\n  ')}`,
  );
});

test('gli script del ciclo non introducono dipendenze npm non dichiarate', () => {
  // Il ciclo gira SENZA `npm ci` — è la proprietà che lo rende economico su
  // questo repo, dove `npm ci` tirerebbe dentro playwright, sharp e
  // transformers a ogni merge. Un import di pacchetto nuovo la romperebbe in
  // silenzio, e se ne accorgerebbe solo la CI sul percorso caldo.
  const declared = new Set([
    ...Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {}),
    // Risolto a runtime e con skip dichiarato se assente (mergePreviewCheck).
    'typescript',
  ]);
  const offenders = [];

  for (const rel of entryPoints()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Stesso estrattore del test sopra: la cecità sugli import braced su più
    // righe valeva anche qui, e su questo lato un pacchetto non dichiarato
    // sfuggito rompe il ciclo in CI, dove non c'è `npm ci` a rimediare.
    for (const pkg of importSpecifiers(src)) {
      if (pkg.startsWith('.') || pkg.startsWith('node:')) continue;
      const base = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
      if (!declared.has(base)) offenders.push(`${rel} → ${pkg}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Import di pacchetti non dichiarati in package.json. Il ciclo gira senza npm ci: ` +
      `o il pacchetto va dichiarato e installato, o l'import va reso opzionale con uno skip ` +
      `esplicito (vedi mergePreviewCheck.mjs).\n  ${offenders.join('\n  ')}`,
  );
});
