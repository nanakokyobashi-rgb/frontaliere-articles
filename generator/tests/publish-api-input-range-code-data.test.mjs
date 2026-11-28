import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  apiTriggerCodeDiffersBetween,
  apiTriggerInputsDifferBetween,
  isPublishApiDataPath,
} from '../../scripts/lib/publish-api-input-range.mjs';

const TRIGGER_PATHS = [
  'content/**',
  'data/blog-articles/**',
  'sections/**',
  'generator/data/canton-sections.json',
  'scripts/build-api.mjs',
  'generator/scripts/lib/article-excerpt.mjs',
  'engine/**',
  '.github/workflows/publish-api.yml',
];

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-api-range-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (files, message) => {
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), body);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  // Le funzioni leggono con `git -C <root del corpus>`: si riscrive il -C.
  const exec = (command, args, options) => execFileSync(command, ['-C', dir, ...args.slice(2)], options);
  const opts = { execFileSyncImpl: exec, triggerPathsImpl: () => TRIGGER_PATHS };
  return { commit, opts };
}

test('classifica come DATO solo i path che non possono cambiare codice o workflow', () => {
  for (const file of [
    'content/blog/a.ts',
    'data/blog-articles/x.json',
    'public/images/blog/a.webp',
    'sections/registry.json',
    'generator/data/canton-sections.json',
    'scripts/ci/excerpt-completeness-baseline.json',
  ]) assert.equal(isPublishApiDataPath(file), true, file);
  for (const file of [
    'scripts/build-api.mjs',
    'scripts/lib/section-registry.mjs',
    'generator/scripts/lib/article-excerpt.mjs',
    'generator/data/news-sitemap-whitelist.mjs',
    'engine/shared/x.mjs',
    'host/x.mjs',
    '.github/workflows/publish-api.yml',
    '.github/actions/setup-article-source-runtime/action.yml',
    'articleSections.ts',
    'qualcosa/di/nuovo.mjs',
  ]) assert.equal(isPublishApiDataPath(file), false, file);
});

test('commit continui di soli dati: i trigger differiscono ma il codice no (la run ritargetta su main)', (t) => {
  const { commit, opts } = makeRepo(t);
  const workflow = commit({ 'scripts/build-api.mjs': '1', 'content/a.ts': '1', '.github/workflows/publish-api.yml': 'w' }, 'base');
  commit({ 'content/b.ts': '1' }, 'articolo 1');
  commit({ 'sections/registry.json': '{}' }, 'registro');
  const main = commit({ 'data/blog-articles/x.json': '[]' }, 'sidecar');
  assert.equal(apiTriggerInputsDifferBetween({ before: workflow, after: main }, opts), true);
  assert.equal(apiTriggerCodeDiffersBetween({ before: workflow, after: main }, opts), false);
});

test('un cambio di codice o di workflow nel delta resta un salto (la run della push nuova prende il posto)', (t) => {
  const { commit, opts } = makeRepo(t);
  const workflow = commit({ 'scripts/build-api.mjs': '1', 'content/a.ts': '1' }, 'base');
  const dataOnly = commit({ 'content/b.ts': '1' }, 'dato');
  assert.equal(apiTriggerCodeDiffersBetween({ before: workflow, after: dataOnly }, opts), false);
  const withCode = commit({ 'scripts/build-api.mjs': '2' }, 'codice');
  assert.equal(apiTriggerCodeDiffersBetween({ before: workflow, after: withCode }, opts), true);
  const wf = commit({ '.github/workflows/publish-api.yml': 'nuovo' }, 'workflow');
  assert.equal(apiTriggerCodeDiffersBetween({ before: dataOnly, after: wf }, opts), true);
  const engine = commit({ 'engine/x.mjs': '1' }, 'engine');
  assert.equal(apiTriggerCodeDiffersBetween({ before: wf, after: engine }, opts), true);
});

test('un delta senza path del trigger non e codice; storia non discendente o SHA invalide falliscono chiuse', (t) => {
  const { commit, opts } = makeRepo(t);
  const a = commit({ 'content/a.ts': '1' }, 'a');
  const b = commit({ 'README.md': 'x' }, 'fuori trigger');
  assert.equal(apiTriggerCodeDiffersBetween({ before: a, after: b }, opts), false);
  assert.throws(() => apiTriggerCodeDiffersBetween({ before: b, after: a }, opts), /lettura Git non verificabile/);
  assert.throws(() => apiTriggerCodeDiffersBetween({ before: 'x', after: b }, opts), /commit non valido/);
});
