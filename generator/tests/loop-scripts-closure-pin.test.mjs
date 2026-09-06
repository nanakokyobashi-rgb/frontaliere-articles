/**
 * loop-scripts-closure-pin.test.mjs — pinna su fixture l'estrattore di import
 * dei guard di chiusura.
 *
 * ## Perché esiste
 *
 * I guard girano sull'albero REALE, e sull'albero reale una regressione
 * dell'estrattore non fa fallire niente: se la regex tornasse per-riga
 * (`.*?`, che non attraversa i newline), gli import braced su più righe
 * tornerebbero invisibili — ma i loro target ESISTONO, quindi il guard
 * resterebbe verde. Vacuo, esattamente com'era prima dell'indurimento, e senza
 * che nessun test lo dica: la mutazione che ha motivato la fix
 * (`reopen-breaker.mjs` rimosso dall'albero → guard verde) era stata provata a
 * mano e sarebbe rimasta non codificata. Questi casi la codificano: falliscono
 * se l'estrattore torna cieco, qualunque sia lo stato dell'albero.
 *
 * ## Perché ora pinna un MODULO invece di un literal estratto dal sorgente
 *
 * Finché la clausola viveva in cinque copie, il pin doveva leggere il sorgente
 * del guard per non pinnare una sesta copia che poteva scollarsi in silenzio —
 * e non poteva vivere DENTRO il guard, perché quel file è `corpus-only` con una
 * baseline sui suoi byte. Con `scripts/ci/lib/import-specifiers.mjs` (issue
 * #929 item 5) la sorgente è una sola e importabile: si pinna la funzione vera,
 * non un'estrazione testuale che può fallire per un rinominamento.
 *
 * Resta l'ultimo test del file, che è il legame: se un guard smettesse di usare
 * il modulo condiviso e si riportasse la regex in casa, questi casi
 * continuerebbero a passare pinnando codice che nessuno chiama più.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  importSpecifiers,
  relativeImportSpecifiers,
  inertSpans,
  resolveSpecifier,
} from '../../scripts/ci/lib/import-specifiers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test("l'estrattore vede l'import braced su più righe (la cecità riparata)", () => {
  const src = [
    'import {',
    '  decideReopen,',
    '  parseReopenBudget,',
    "} from './lib/reopen-breaker.mjs';",
    '',
  ].join('\n');
  assert.deepEqual(importSpecifiers(src), ['./lib/reopen-breaker.mjs']);
});

test('non scavalca la fine di uno statement per agganciare il successivo', () => {
  // Il divieto di apici e `;` nella classe negata serve a questo: senza, il
  // match non greedy potrebbe attraversare `from './a.mjs';` e agganciare la
  // stringa dell'import dopo, contando UN import dove ce ne sono due.
  const src = "import { a } from './a.mjs';\nimport { b } from './b.mjs';\n";
  assert.deepEqual(importSpecifiers(src), ['./a.mjs', './b.mjs']);
});

test('la prosa in un commento che cita un import non diventa una dipendenza', () => {
  // Il falso positivo che il porting ha prodotto davvero (#2057): l'ancora
  // deve restare `^[ \t]`, non `^\s`, o il newline del commento la fa
  // ripartire a metà riga.
  const src = "// #2057: import {FX} from './comparatorHref'\nimport fs from 'node:fs';\n";
  assert.deepEqual(importSpecifiers(src), ['node:fs']);
});

test('il side-effect import senza from resta coperto', () => {
  assert.deepEqual(importSpecifiers("import './setup.mjs';\n"), ['./setup.mjs']);
});

test("`export ... from` è una dipendenza, `export default '...'` no", () => {
  const src = "export { a } from './e.mjs';\nexport default './non-e-un-import';\n";
  assert.deepEqual(importSpecifiers(src), ['./e.mjs']);
});

// ── #929 item 1: l'`import()` dinamico ──────────────────────────────────────

test("l'`import()` dinamico è una dipendenza quanto quello statico", () => {
  const src = "async function f() {\n  const mod = await import('./ai-models.mjs');\n  return mod;\n}\n";
  assert.deepEqual(importSpecifiers(src), ['./ai-models.mjs']);
});

test("l'`import()` dinamico commentato non è una dipendenza", () => {
  // Il ramo dinamico NON è ancorato a inizio riga — non può esserlo, un
  // `import()` sta in mezzo a un'espressione — quindi qui l'ancora non
  // protegge più: protegge il filtro sui commenti.
  const src = "// prima si faceva await import('./vecchio.mjs')\nconst x = 1;\n";
  assert.deepEqual(importSpecifiers(src), []);
});

// ── #929 item 2: la forma senza spazi ───────────────────────────────────────

test('la forma senza spazi (`from\x27./y\x27`, `import{a}from`) resta coperta', () => {
  assert.deepEqual(importSpecifiers("import x from'./y.mjs';\n"), ['./y.mjs']);
  assert.deepEqual(importSpecifiers("import{a}from'./z.mjs';\n"), ['./z.mjs']);
  assert.deepEqual(importSpecifiers("export{a}from'./w.mjs';\n"), ['./w.mjs']);
});

test('una parola che CONTIENE `import`/`from` non apre uno specificatore', () => {
  const src = "const important = 'x';\nconst fromage = './no.mjs';\nexports.a = './neanche.mjs';\n";
  assert.deepEqual(importSpecifiers(src), []);
});

// ── #929 item 4: il codice dentro una stringa non è una dipendenza ──────────

test("l'`import()` dentro la stringa di un comando shell non è una dipendenza", () => {
  // Il caso vivo: scan-generation-health.mjs documenta un `node -e` che
  // contiene `await import("./scripts/ci/scan-generation-health.mjs")`. Contato
  // come proprio, si risolve in `scripts/ci/scripts/ci/…` — guard ROSSO su
  // codice corretto.
  const src = "const cmd = 'node -e \\'const{f}=await import(\"./scripts/ci/x.mjs\");\\'';\n";
  assert.deepEqual(importSpecifiers(src), []);
});

test('il codice EMESSO da un template literal non è una dipendenza di chi lo emette', () => {
  const src = ['const body = `', "import { x } from './emesso.mjs';", '`;', "import y from './vero.mjs';", ''].join('\n');
  assert.deepEqual(importSpecifiers(src), ['./vero.mjs']);
});

test("una regex con apici non desincronizza lo scanner (il fail-safe non scatta)", () => {
  // `/['"]/` è la forma più comune proprio nei file che estraggono import: se
  // l'euristica la leggesse come una divisione, l'apice aprirebbe una stringa
  // fantasma e il filtro salterebbe da lì in poi.
  const src = "const re = /['\"]/;\n// English\nconst b = /you\\s+won['’]?t/i;\nimport a from './dopo.mjs';\n";
  assert.notEqual(inertSpans(src), null);
  assert.deepEqual(importSpecifiers(src), ['./dopo.mjs']);
});

test('lo scanner desincronizzato torna a contare TUTTO invece di fidarsi', () => {
  // Fail-open sul rumore, mai sulla cecità: un sorgente che lo scanner non sa
  // leggere (qui un blocco `/*` mai chiuso) non deve far sparire gli import.
  const src = "import a from './prima.mjs';\n/* mai chiuso\n";
  assert.equal(inertSpans(src), null);
  assert.deepEqual(importSpecifiers(src), ['./prima.mjs']);
});

// ── #929 item 3: il fallback di estensione ──────────────────────────────────

test("la risoluzione prova `.mjs`, `.js`, `.ts` e `index.*`, mai una directory", () => {
  const known = new Set(['a/b.mjs', 'c/d.ts', 'e/index.js']);
  const accept = (p) => known.has(p);
  assert.equal(resolveSpecifier('a/b', accept), 'a/b.mjs');
  assert.equal(resolveSpecifier('c/d', accept), 'c/d.ts');
  assert.equal(resolveSpecifier('e', accept), 'e/index.js');
  assert.equal(resolveSpecifier('z', accept), null);
});

test('solo gli specificatori relativi entrano nella chiusura', () => {
  const src = "import fs from 'node:fs';\nimport z from 'zod';\nimport q from './q.mjs';\n";
  assert.deepEqual(relativeImportSpecifiers(src), ['./q.mjs']);
});

// ── Il legame: i guard usano DAVVERO il modulo condiviso ────────────────────

test('nessun guard di chiusura si è riportato in casa una copia della regex', () => {
  const consumers = [
    'scripts/ci/loop-drift-check.mjs',
    'generator/tests/import-closure.test.mjs',
    'generator/tests/loop-scripts-closure.test.mjs',
    'generator/tests/needs-human-prepass-sparse-closure.test.mjs',
    'generator/tests/rewire-json-contracts.test.mjs',
  ];
  const detached = [];
  for (const rel of consumers) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!src.includes('import-specifiers.mjs')) detached.push(rel);
  }
  assert.deepEqual(
    detached,
    [],
    'Questi guard non importano più `scripts/ci/lib/import-specifiers.mjs`: la clausola è tornata a ' +
      'vivere in più copie, e i casi pinnati qui sopra non dicono più niente su di loro.\n  ' +
      detached.join('\n  '),
  );
});
