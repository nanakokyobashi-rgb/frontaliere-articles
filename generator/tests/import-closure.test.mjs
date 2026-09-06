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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeImportSpecifiers, resolveSpecifier } from '../../scripts/ci/lib/import-specifiers.mjs';

const GENERATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `existsSync` accetta anche le directory; un import no. */
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();

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

// L'estrattore vive in `scripts/ci/lib/import-specifiers.mjs`, una sorgente
// sola per i cinque guard che facevano la stessa domanda con cinque copie
// della stessa regex (issue #929 item 5). Da li' arrivano anche i due lati che
// questo guard non vedeva: l'`import()` DINAMICO — `article-topic-selector.mjs`
// carica cosi' `./ai-models.mjs` e `load-rc-env.mjs` cosi'
// `./lib/google-service-account-token.mjs`, quindi rinominarne uno lasciava il
// guard verde e produceva `ERR_MODULE_NOT_FOUND` a generazione (item 1) — e la
// forma senza spazi `import x from'./y.mjs'` (item 2).

test('every relative import under generator/ resolves to a file that exists', () => {
  const missing = [];
  for (const file of sourceFiles(GENERATOR_ROOT)) {
    const src = fs.readFileSync(file, 'utf-8');
    for (const spec of relativeImportSpecifiers(src)) {
      const base = path.resolve(path.dirname(file), spec);
      // Fallback di estensione (issue #929 item 3): `sourceFiles()` include i
      // `.ts` sotto generator/, e in TypeScript l'import relativo si scrive
      // SENZA estensione. Con `existsSync(abs)` nudo il primo `from './foo'`
      // aggiunto in un `.ts` corretto avrebbe reso rosso il gate.
      // `isFile` e non `existsSync`: una DIRECTORY che esiste non risolve un
      // import, e accettarla renderebbe il guard cieco proprio sul caso in cui
      // manca l'`index.mjs`.
      if (!resolveSpecifier(base, isFile)) {
        missing.push(
          `${path.relative(GENERATOR_ROOT, file)} → ${spec} (${path.relative(GENERATOR_ROOT, base)})`,
        );
      }
    }
  }
  assert.deepEqual(missing, [], `unresolved relative imports:\n  ${missing.join('\n  ')}`);
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
