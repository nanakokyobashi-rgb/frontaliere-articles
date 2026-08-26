/**
 * loop-scripts-closure-pin.test.mjs — pinna su fixture l'estrattore di import
 * di `loop-scripts-closure.test.mjs`.
 *
 * ## Perché esiste
 *
 * I due test del guard girano sull'albero REALE, e sull'albero reale una
 * regressione dell'estrattore non fa fallire niente: se la regex tornasse
 * per-riga (`.*?`, che non attraversa i newline), gli import braced su più
 * righe tornerebbero invisibili — ma i loro target ESISTONO, quindi il guard
 * resterebbe 2/2 verde. Vacuo, esattamente com'era prima dell'indurimento, e
 * senza che nessun test lo dica: la mutazione che ha motivato la fix
 * (`reopen-breaker.mjs` rimosso dall'albero → guard verde) era stata provata
 * a mano e sarebbe rimasta non codificata. Questi casi la codificano:
 * falliscono se l'estrattore torna cieco, qualunque sia lo stato dell'albero.
 *
 * ## Perché un file separato, e perché legge il sorgente
 *
 * Il guard è `corpus-only` nel manifest del ciclo, con una baseline sui suoi
 * byte: ogni ritocco al suo file muove la baseline, e un pin interno la
 * muoverebbe di nuovo — dentro una catena di PR già aperta, questo produce
 * esattamente il conflitto a tre vie sul manifest che lo squash-merge non sa
 * risolvere. Da qui si pinna la regex REALE — estratta dal sorgente del
 * guard, non una copia che può scollarsi in silenzio — senza toccare i byte
 * sorvegliati. Se la definizione viene rinominata o spostata, l'estrazione
 * fallisce e il pin diventa rosso: l'attenzione è richiesta, mai elusa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, 'loop-scripts-closure.test.mjs');

/** La regex vera del guard, estratta dal suo sorgente. */
function guardImportRe() {
  const src = fs.readFileSync(GUARD, 'utf8');
  const m = src.match(/^const IMPORT_RE = (\/.*\/[a-z]*);$/m);
  assert.ok(
    m,
    'IMPORT_RE non trovata nel sorgente del guard: se è stata rinominata o spostata, aggiorna questo pin',
  );
  const lit = m[1];
  const lastSlash = lit.lastIndexOf('/');
  return new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1));
}

/** Stessa estrazione di `importSpecifiers` nel guard: gruppo 2 = specificatore. */
const specifiers = (src) => [...src.matchAll(guardImportRe())].map((mm) => mm[2]);

test("la regex del guard vede l'import braced su più righe (la cecità riparata)", () => {
  const src = [
    'import {',
    '  decideReopen,',
    '  parseReopenBudget,',
    "} from './lib/reopen-breaker.mjs';",
    '',
  ].join('\n');
  assert.deepEqual(specifiers(src), ['./lib/reopen-breaker.mjs']);
});

test('la regex del guard non scavalca la fine di uno statement per agganciare il successivo', () => {
  // Il divieto di apici e `;` nella classe negata serve a questo: senza, il
  // match non greedy potrebbe attraversare `from './a.mjs';` e agganciare la
  // stringa dell'import dopo, contando UN import dove ce ne sono due.
  const src = "import { a } from './a.mjs';\nimport { b } from './b.mjs';\n";
  assert.deepEqual(specifiers(src), ['./a.mjs', './b.mjs']);
});

test('la prosa in un commento che cita un import non diventa una dipendenza', () => {
  // Il falso positivo che il porting ha prodotto davvero (#2057): l'ancora
  // deve restare `^[ \t]`, non `^\s`, o il newline del commento la fa
  // ripartire a metà riga.
  const src = "// #2057: import {FX} from './comparatorHref'\nimport fs from 'node:fs';\n";
  assert.deepEqual(specifiers(src), ['node:fs']);
});

test('il side-effect import senza from resta coperto', () => {
  const src = "import './setup.mjs';\n";
  assert.deepEqual(specifiers(src), ['./setup.mjs']);
});
