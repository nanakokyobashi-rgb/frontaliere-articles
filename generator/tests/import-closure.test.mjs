/**
 * Every relative import under generator/ must resolve on disk. `node --test`.
 *
 * This is the gate that would have caught the transport defect. The 67 files
 * moved by #4974 item 3 step 2 were the static-import closure computed WITHIN
 * `scripts/`; six specifiers that left `scripts/` (`../build-plugins/`,
 * `../data/`, `../services/`) were never followed, so `create-article.mjs`
 * threw at load — before `main()`, on a plain `import` — and nothing noticed,
 * because the code had been copied but never run.
 *
 * A missing module is a load-time failure, which means it cannot be caught by
 * any test that imports the module under test. It has to be checked statically,
 * which is what this does.
 *
 * Deliberately regex-based rather than an actual resolver: the point is to
 * check the FILES exist, and a resolver would need the module graph to load,
 * which is the thing that is broken when this fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source files whose imports are checked. */
function sourceFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, acc);
    else if (/\.(mjs|ts)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

// Clausola `[^'";]*?` e non `[^'"\n]*?`: senza `\n` nella classe negata un
// import BRACED SU PIÙ RIGHE viene visto. Con il newline escluso questa riga
// era cieca su 102 specificatori relativi reali sotto generator/ (fra cui
// `create-article.mjs` → `./lib/fact-check-consensus.mjs`), cioè proprio la
// classe che il guard esiste per chiudere: un modulo rimosso o rinominato e
// importato in quella forma lasciava il guard verde, e saltava fuori come
// `ERR_MODULE_NOT_FOUND` a generazione — corpus e superficie fermi, CI verde.
// Vietare `'`, `"` e `;` impedisce al match non greedy di attraversare la fine
// dello statement e agganciare la stringa dell'import successivo.
// `^[ \t]*` e non `\s*` dopo il newline: `\s` mangia i newline e farebbe
// ripartire l'ancora a metà di una riga di commento che cita un import.
// Il `from` è opzionale solo per `import`, così il side-effect import
// (`import './x.mjs'`) resta coperto senza che `export default './x'` — che
// non è una dipendenza — venga contato.
//
// Il ramo `import(...)` è NON ancorato, perché un import dinamico sta sempre a
// metà di un'espressione (`const m = await import('./x.mjs')`): pretendere
// l'ancora lo rende invisibile, ed è la classe che #1030 chiude — rinominare
// un modulo raggiunto solo così lasciava il guard verde e produceva
// `ERR_MODULE_NOT_FOUND` a runtime.
// Ciò che sostituisce l'ancora è il PREFISSO consentito prima di `import(`:
// nessun apice, virgoletta o backtick, e nessun `//`, su una riga che non
// comincia per `//`, `*` o `/*`. È quello a tenere fuori le due sorgenti di
// falsi rossi che esistono davvero nell'albero:
//   - `scripts/ci/scan-generation-health.mjs:1094` cita
//     `await import("./scripts/ci/…")` DENTRO la stringa di un comando shell:
//     un ramo ingenuo lo risolverebbe da `scripts/ci/` e chiederebbe
//     `scripts/ci/scripts/ci/…` — guard rosso su codice corretto. La stringa
//     è aperta da un apice che precede `import`, quindi il prefisso la esclude.
//   - le fixture di `censimento-source.test.mjs` e la prosa di
//     `tests/lib/reachable-source.mjs`, che nominano la forma per parlarne.
// Il costo è un falso NEGATIVO su un import dinamico preceduto da una stringa
// sulla stessa riga: si perde una dipendenza, non si inventa un errore.
const SPECIFIER =
  /^(?:[ \t]*(?:import(?:\s+|(?=[{*'"]))(?:[^'";]*?[\s}*]from\s*)?|export(?:\s+|(?=[{*]))[^'";]*?[\s}*]from\s*)|(?![ \t]*(?:\/\/|\*|\/\*))(?:[^'"`\/\n]|\/(?!\/))*?\bimport\s*\(\s*)(['"])([^'"]+)\1/gm;

// I candidati provati per uno specificatore relativo, nell'ordine di Node.
// Stessa lista di `loop-drift-check.mjs:resolvedLocalImports()` e di
// `loop-scripts-closure.test.mjs`, con in piu' i due rami `.ts`.
//
// `.ts` prima dei gemelli `.mjs`/`.js`: i rami di fallback si attivano solo per
// un importatore senza estensione, cioe' TypeScript, e li' `./foo` accanto a
// `foo.ts` e `foo.mjs` risolve il `.ts`. Le quattro copie della lista devono
// muoversi insieme (#1029 le unifichera'), ordine compreso.
//
// Perche' non basta il path nudo: `sourceFiles()` include i file `.ts` sotto
// generator/ (services/, data/, build-plugins/), e in TypeScript l'import
// relativo si scrive SENZA estensione — e' la stessa convenzione per cui
// AGENTS.md impone `tsx` e non `node` per il build. Con il solo `existsSync(abs)`
// il primo `from './borderWaitFormat'` scritto in uno di quei file rendeva
// rosso questo gate su codice corretto: non un difetto trovato, un difetto
// inventato. Zero casi nell'albero di oggi, quindi il buco era latente — ma un
// gate che sbaglia sul codice giusto viene disattivato, non riparato.
function resolutionCandidates(base) {
  return [
    base,
    `${base}.ts`,
    `${base}.mjs`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.js'),
  ];
}

/**
 * Il primo candidato che esiste ed e' un FILE, o `null`.
 *
 * `isFile()` e non il solo `existsSync`: una directory omonima
 * (`./lib` con `lib/` accanto e nessun `index.*`) non e' un modulo, e contarla
 * come risolta renderebbe il fallback fail-open — cioe' trasformerebbe un gate
 * che sbagliava in rosso in uno che sbaglia in verde, che e' peggio.
 */
function resolveOnDisk(base) {
  for (const candidate of resolutionCandidates(base)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ENOENT / ENOTDIR: il candidato non c'e', si prova il prossimo.
    }
  }
  return null;
}

test('every relative import under generator/ resolves to a file that exists', () => {
  const missing = [];
  for (const file of sourceFiles(GENERATOR_ROOT)) {
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(SPECIFIER)) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue;
      const abs = path.resolve(path.dirname(file), spec);
      if (!resolveOnDisk(abs)) {
        const tried = resolutionCandidates(abs)
          .map((c) => path.relative(GENERATOR_ROOT, c))
          .join(', ');
        missing.push(`${path.relative(GENERATOR_ROOT, file)} → ${spec} (provati: ${tried})`);
      }
    }
  }
  assert.deepEqual(missing, [], `unresolved relative imports:\n  ${missing.join('\n  ')}`);
});

test('la risoluzione prova le estensioni, e non e\' diventata fail-open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-closure-'));
  try {
    fs.writeFileSync(path.join(dir, 'foo.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'bare.mjs'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(path.join(dir, 'pkg', 'index.ts'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(dir, 'plain'));

    // Il caso della issue: `./foo` con `foo.ts` accanto risolve.
    assert.equal(resolveOnDisk(path.join(dir, 'foo')), path.join(dir, 'foo.ts'));
    // Lo specificatore che porta gia' l'estensione continua a risolvere per primo.
    assert.equal(resolveOnDisk(path.join(dir, 'bare.mjs')), path.join(dir, 'bare.mjs'));
    // Una cartella con index risolve all'index, non alla cartella.
    assert.equal(resolveOnDisk(path.join(dir, 'pkg')), path.join(dir, 'pkg', 'index.ts'));
    // E cio' che non esiste NON risolve: il fallback non e' fail-open.
    assert.equal(resolveOnDisk(path.join(dir, 'bar')), null);
    // Nemmeno una directory senza index, che `existsSync` da solo direbbe risolta.
    assert.equal(resolveOnDisk(path.join(dir, 'plain')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolve-git-add-path.mjs is absent, and nothing imports it', () => {
  // It was excluded on purpose: it resolves symlinks that exist only in main
  // (services/locales/** → packages/articles/content/**). corpus-paths.mjs
  // replaced it. If this fails, someone re-imported main's workaround.
  assert.equal(
    fs.existsSync(path.join(GENERATOR_ROOT, 'scripts', 'lib', 'resolve-git-add-path.mjs')),
    false,
  );
  // Matches an IMPORT of it, not a mention: corpus-paths.mjs names the module
  // it replaced in its own header, and that prose is the documentation.
  const importsIt = /from\s*['"][^'"]*resolve-git-add-path(\.mjs)?['"]|import\s*['"][^'"]*resolve-git-add-path(\.mjs)?['"]/;
  const offenders = sourceFiles(GENERATOR_ROOT)
    .filter((f) => importsIt.test(fs.readFileSync(f, 'utf-8')))
    .map((f) => path.relative(GENERATOR_ROOT, f));
  assert.deepEqual(offenders, []);
});

test('entry points resolve the repo root, not the generator directory', () => {
  // The transport moved these from `scripts/` to `generator/scripts/`, so every
  // `path.resolve(__dirname, '..')` silently started pointing at generator/.
  // Reads would fail and writes would build a phantom corpus under generator/.
  const entries = [
    'create-article.mjs',
    'batch-add-faq-to-articles.mjs',
    'fix-faq-locales.mjs',
    'generate-border-wait-ranking-article.mjs',
    'generate-events-digest-article.mjs',
    'publish-journalist-article.mjs',
    'generate-journalist-image-catalog.mjs',
  ];
  for (const name of entries) {
    const src = fs.readFileSync(path.join(GENERATOR_ROOT, 'scripts', name), 'utf-8');
    const oneUp = /(?:path\.)?resolve\(\s*(?:path\.dirname\([^)]*\)|__dirname)\s*,\s*'\.\.'\s*\)/.test(src);
    const urlOneUp = /new URL\('\.\.',\s*import\.meta\.url\)/.test(src);
    assert.ok(
      !oneUp && !urlOneUp,
      `${name} still resolves one level up — that is generator/, not the repo root`,
    );
  }
});
