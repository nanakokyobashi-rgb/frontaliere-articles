/**
 * loop-scripts-closure-pin.test.mjs — pinna su fixture l'estrattore di import
 * condiviso dai guard del ciclo.
 *
 * ## Perché esiste
 *
 * I guard girano sull'albero REALE, e sull'albero reale una regressione
 * dell'estrattore non fa fallire niente: se il parser tornasse cieco, gli
 * import dei file già presenti resterebbero risolti e il guard sarebbe verde.
 * Le fixture qui sotto codificano le forme che hanno già prodotto questo buco:
 * import braced su più righe, side-effect, dinamici, no-space e export-from.
 *
 * ## Perché legge il modulo condiviso
 *
 * Il modulo è la sorgente unica per cinque consumer: il test di chiusura del
 * generatore, quello degli script del ciclo, la chiusura dello sparse checkout,
 * il contratto REWIRE e il drift checker. Il pin controlla sia l'API regex sia
 * l'import effettivo dei consumer; una copia locale o una divergenza diventa
 * rossa nel test, prima di poter indebolire un gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dynamicImportRe,
  importSpecifiers,
  staticImportRe,
} from '../../scripts/ci/lib/import-specifiers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARDS = [
  path.join(HERE, 'loop-scripts-closure.test.mjs'),
  path.join(HERE, 'import-closure.test.mjs'),
  path.join(HERE, 'needs-human-prepass-sparse-closure.test.mjs'),
  path.join(HERE, 'rewire-json-contracts.test.mjs'),
  path.resolve(HERE, '../../scripts/ci/loop-drift-check.mjs'),
];
const specifiers = importSpecifiers;

test("il guard vede l'import braced su più righe (la cecità riparata)", () => {
  const src = [
    'import {',
    '  decideReopen,',
    '  parseReopenBudget,',
    "} from './lib/reopen-breaker.mjs';",
    '',
  ].join('\n');
  assert.deepEqual(specifiers(src), ['./lib/reopen-breaker.mjs']);
});

test('il guard non scavalca la fine di uno statement per agganciare il successivo', () => {
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

test("il guard vede l'import DINAMICO, che non è mai a inizio riga", () => {
  // #1030: `await import('./x.mjs')` sta a metà di un'espressione, quindi
  // l'ancora `^[ \t]*` lo rendeva invisibile. Tre offender vivi lo usavano sul
  // path caldo (`article-topic-selector.mjs` → `./ai-models.mjs`,
  // `load-rc-env.mjs` → `./lib/google-service-account-token.mjs`,
  // `mergePreviewCheck.mjs` → `./duplicateDeclarations.mjs`): rinominare uno di
  // quei moduli lasciava il guard verde e rompeva la generazione a runtime.
  const src = "const m = await import('./x.mjs');\n";
  assert.deepEqual(specifiers(src), ['./x.mjs']);
});

test("il guard vede tutti gli import dinamici nella stessa espressione", () => {
  const src = "await Promise.all([import('./a.mjs'), import('./b.mjs')]);\n";
  assert.deepEqual(specifiers(src), ['./a.mjs', './b.mjs']);
});

test("un commento inline non apre un prefisso di import dinamico", () => {
  const src = "const x = /* import('./not-a-module.mjs') */ true;\n";
  assert.deepEqual(specifiers(src), []);
});

test("un import dinamico su una continuazione con `*` resta codice, non JSDoc", () => {
  assert.deepEqual(specifiers("const x =\n  * (await import('./valid.mjs'));\n"), ['./valid.mjs']);
});

test('registry.import e un import dinamico in JSDoc non sono dipendenze', () => {
  assert.deepEqual(specifiers("registry.import('./registry.mjs');\n/**\n * await import('./jsdoc.mjs')\n */\n"), []);
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

test('le factory regex condivise riconoscono le due forme senza stato condiviso', () => {
  const staticMatch = staticImportRe().exec("import x from './static.mjs';");
  const dynamicMatch = dynamicImportRe().exec("await import('./dynamic.mjs');");
  assert.equal(staticMatch?.[2], './static.mjs');
  assert.equal(dynamicMatch?.[2], './dynamic.mjs');
  assert.equal(dynamicImportRe().test("registry.import('./not-a-module.mjs');"), false);
  assert.equal(dynamicImportRe().lastIndex, 0);
});

test("tutti i guard usano la sorgente unica dell'estrattore", () => {
  for (const file of GUARDS) {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /from ['"][^'"]*import-specifiers\.mjs['"]/);
  }
});
