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

test("la regex del guard vede l'import DINAMICO, che non è mai a inizio riga", () => {
  // #1030: `await import('./x.mjs')` sta a metà di un'espressione, quindi
  // l'ancora `^[ \t]*` lo rendeva invisibile. Tre offender vivi lo usavano sul
  // path caldo (`article-topic-selector.mjs` → `./ai-models.mjs`,
  // `load-rc-env.mjs` → `./lib/google-service-account-token.mjs`,
  // `mergePreviewCheck.mjs` → `./duplicateDeclarations.mjs`): rinominare uno di
  // quei moduli lasciava il guard verde e rompeva la generazione a runtime.
  const src = "const m = await import('./x.mjs');\n";
  assert.deepEqual(specifiers(src), ['./x.mjs']);
});

test("l'import dinamico DENTRO una stringa non è una dipendenza", () => {
  // La riga letterale di `scripts/ci/scan-generation-health.mjs:1094`: il
  // `import("…")` vive dentro la stringa di un comando shell, e il path è
  // relativo alla RADICE del repo, non allo script. Un ramo ingenuo lo
  // risolverebbe come `scripts/ci/scripts/ci/…` e renderebbe il guard rosso su
  // codice corretto — un falso rosso su un guard di chiusura si "ripara"
  // spegnendolo, ed è così che si perde la copertura vera.
  const src =
    "    + 'node -e \\'const{findDuplicateTopicPairs,collectCorpus}=await import(\"./scripts/ci/scan-generation-health.mjs\");'\n";
  assert.deepEqual(specifiers(src), []);
});

test('la prosa che CITA un import dinamico non è una dipendenza', () => {
  // `generator/tests/lib/reachable-source.mjs` nomina la forma per spiegarla,
  // con un path che non esiste (`./lib/…`). Il prefisso consentito prima di
  // `import(` esclude sia la riga di commento sia il backtick che la cita.
  const src = "// Un `await import('./lib/…')` era invisibile — e la forma esiste già.\n";
  assert.deepEqual(specifiers(src), []);
});

test("la forma senza spazi (`import x from'./y.mjs'`) resta coperta", () => {
  // #1031: il delta di #894 aveva stretto la clausola a `import\s+` e
  // `\sfrom\s+`, e queste tre forme — JS valido — erano uscite dalla copertura
  // di TUTTE le copie del guard. Occorrenze vive nell'albero: zero, perché
  // prettier le riscrive; ma il primo file che entra senza passare da prettier
  // (una copia dal sito, un paste minificato) perdeva la copertura in silenzio.
  assert.deepEqual(specifiers("import x from'./y.mjs';\n"), ['./y.mjs']);
  assert.deepEqual(specifiers("import{a}from'./y.mjs';\n"), ['./y.mjs']);
  assert.deepEqual(specifiers("import*as n from'./y.mjs';\n"), ['./y.mjs']);
  assert.deepEqual(specifiers("import'./y.mjs';\n"), ['./y.mjs']);
  assert.deepEqual(specifiers("export{a}from'./y.mjs';\n"), ['./y.mjs']);
  assert.deepEqual(specifiers("export*from'./y.mjs';\n"), ['./y.mjs']);
});

test('`export default` di una stringa non è uno specificatore', () => {
  // Il falso positivo che il `\s+` di #894 stava proteggendo: riammettere la
  // forma senza spazi non deve riaprirlo. `from` resta obbligatorio quando la
  // clausola non è vuota, e dev'essere preceduto da spazio, `}` o `*` — così
  // `default './x'` non ha niente da agganciare, e nemmeno un identificatore
  // che finisce per `from`.
  assert.deepEqual(specifiers("export default './x';\n"), []);
  assert.deepEqual(specifiers('export default { a: 1 };\n'), []);
  assert.deepEqual(specifiers("import xfrom'./y.mjs';\n"), []);
});

test('le due copie della clausola non divergono', () => {
  // #894 ha stretto alcune copie e non altre, ed è così che questa classe di
  // bug è nata. Finché l'estrattore condiviso di #1029 non atterra, il legame
  // fra le copie è coperto da questo test (AGENTS.md #6).
  const twin = fs.readFileSync(path.join(HERE, 'import-closure.test.mjs'), 'utf8');
  const m = twin.match(/^const SPECIFIER =\n\s*(\/.*\/[a-z]*);$/m);
  assert.ok(m, 'SPECIFIER non trovata in import-closure.test.mjs: se è stata rinominata, aggiorna questo pin');
  assert.equal(m[1], guardImportRe().toString());
});
