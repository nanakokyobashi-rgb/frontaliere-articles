import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeCorpusCoreEntries, CORPUS_ACTIVE_CANTON_CODES } from '../../scripts/lib/corpus-sections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOOTSTRAP_RE = /(?:from\s+|import\s+|import\s*\(\s*)['"][^'"]*(?:cantonSectionsBootstrap\.mjs|siteShellBootstrap(?:\.ts)?)/g;
const ENGINE_IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"][^'"]*engine\//g;
const DIRECTORIES = ['scripts', 'generator/scripts', 'generator/tests', 'host'];
const CLOSED_SET_HELPERS = new Set([
  'generator/scripts/lib/canton-section-profile.mjs',
  'scripts/lib/corpus-sections.mjs',
]);
const DYNAMIC_ENTRYPOINTS = [
  'scripts/publish-article-fast.mjs',
  'scripts/refresh-hub-landing.mjs',
  'scripts/lib/article-render-pipeline.mjs',
];

function filesUnder(relativeDir) {
  const root = path.join(ROOT, relativeDir);
  const out = [];
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === '.git') continue;
      const child = path.join(abs, name);
      const childRel = path.join(rel, name);
      const stats = statSync(child);
      if (stats.isDirectory()) visit(child, childRel);
      else if (/\.(?:mjs|ts)$/.test(name)) out.push(childRel);
    }
  };
  visit(root, relativeDir);
  return out;
}

function engineImports(source) {
  return [...source.matchAll(ENGINE_IMPORT_RE)].map((match) => match.index);
}

test('ogni entrypoint corpus che usa l\'engine configura prima l\'insieme attivo D22', () => {
  const failures = [];
  for (const file of DIRECTORIES.flatMap(filesUnder)) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    const imports = engineImports(source);
    if (imports.length === 0 || CLOSED_SET_HELPERS.has(file)) continue;
    const bootstrapMatches = [...source.matchAll(BOOTSTRAP_RE)];
    if (bootstrapMatches.length === 0) {
      failures.push(`${file}: bootstrap host assente`);
      continue;
    }
    const bootstrapAt = Math.min(...bootstrapMatches.map((match) => match.index));
    if (bootstrapAt > Math.min(...imports)) failures.push(`${file}: bootstrap dopo il primo import engine`);
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('gli entrypoint con import engine dinamico hanno un bootstrap esplicito', () => {
  const failures = DYNAMIC_ENTRYPOINTS.filter((file) => {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    return [...source.matchAll(BOOTSTRAP_RE)].length === 0;
  });
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('corpus-sections e\' l\'unico modulo che valorizza il core attivo', () => {
  const source = readFileSync(path.join(ROOT, 'scripts/lib/corpus-sections.mjs'), 'utf8');
  assert.match(source, /configureActiveCantonSections/);
  assert.match(source, /CORPUS_ACTIVE_CANTON_CODES/);
  assert.match(readFileSync(path.join(ROOT, 'host/cantonSectionsBootstrap.mjs'), 'utf8'), /configureCorpusActiveSections/);
});

test('il core attivo coincide con enabled nel profilo, non con il registro servito', () => {
  assert.deepEqual(
    activeCorpusCoreEntries().filter((entry) => entry.kind === 'canton').map((entry) => entry.canton),
    [...CORPUS_ACTIVE_CANTON_CODES],
  );
});
