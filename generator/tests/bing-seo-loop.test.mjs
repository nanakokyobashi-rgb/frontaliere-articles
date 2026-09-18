import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyFixes,
  auditLive,
  checkSource,
} from '../../scripts/seo/bing-seo-loop.mjs';
import {
  BING_TITLE_FIXES,
  BING_TITLE_MAX_CHARS,
} from '../../scripts/seo/bing-seo-policy.mjs';

function readPolicySources(repoRoot) {
  const contents = new Map();
  for (const fix of BING_TITLE_FIXES) {
    for (const relativePath of [fix.source, fix.metadataSource].filter(Boolean)) {
      if (!contents.has(relativePath)) {
        contents.set(relativePath, readFileSync(resolve(repoRoot, relativePath), 'utf8'));
      }
    }
  }
  return contents;
}

test('Bing title policy is bounded and source-aligned', () => {
  const result = checkSource();
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(BING_TITLE_FIXES.length, 16);
  assert.ok(BING_TITLE_FIXES.every((fix) => fix.title.length <= BING_TITLE_MAX_CHARS));
  assert.equal(new Set(BING_TITLE_FIXES.map((fix) => fix.url)).size, 16);
  const italianSeoFixes = BING_TITLE_FIXES.filter((fix) => fix.kind === 'seo');
  assert.equal(italianSeoFixes.length, 8);
  assert.ok(italianSeoFixes.every((fix) => fix.metadataSource === 'content/blog-meta-ch-it.ts'));
  assert.ok(italianSeoFixes.every((fix) => fix.metadataKey.startsWith('blog.article.')));
});

test('live audit accepts the brand suffix when the approved title is its prefix', async () => {
  const htmlByUrl = new Map(BING_TITLE_FIXES.map((fix) => [
    fix.url,
    '<title>' + fix.title + (fix.title.length + ' | Frontaliere Ticino'.length <= BING_TITLE_MAX_CHARS
      ? ' | Frontaliere Ticino'
      : '') + '</title>' +
      '<link rel="canonical" href="' + fix.url + '">',
  ]));
  const result = await auditLive({
    fetchImpl: async (url) => ({
      status: 200,
      url,
      text: async () => htmlByUrl.get(url),
    }),
  });
  assert.deepEqual(result.findings, []);
});

test('applyFixes rejects an unapproved editorial source drift', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const contents = readPolicySources(repoRoot);
  const firstFix = BING_TITLE_FIXES[0];
  contents.set(
    firstFix.source,
    contents.get(firstFix.source).replace(firstFix.title, 'Titolo editoriale aggiornato'),
  );

  assert.throws(
    () => applyFixes({
      repoRoot,
      readFile: (absolutePath) => contents.get(relative(repoRoot, absolutePath)),
      writeFile: () => assert.fail('un drift editoriale non deve essere scritto'),
    }),
    /Titolo sorgente inatteso/,
  );
});

test('source locators ignore comments and reject duplicate real entries', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const contents = readPolicySources(repoRoot);
  const firstFix = BING_TITLE_FIXES[0];
  const original = contents.get(firstFix.source);
  contents.set(
    firstFix.source,
    "/*\n  '" + firstFix.articleId + "': { title: 'fake' }\n*/\n" + original,
  );
  assert.doesNotThrow(() => applyFixes({
    repoRoot,
    readFile: (absolutePath) => contents.get(relative(repoRoot, absolutePath)),
    writeFile: () => assert.fail('il contenuto già approvato non deve essere scritto'),
  }));

  contents.set(
    firstFix.source,
    original + "\n  '" + firstFix.articleId + "': { title: 'duplicate' },\n",
  );
  assert.throws(
    () => applyFixes({
      repoRoot,
      readFile: (absolutePath) => contents.get(relative(repoRoot, absolutePath)),
      writeFile: () => assert.fail('una voce duplicata non deve essere scritta'),
    }),
    /Entry duplicata/,
  );
});

test('SEO fixes update the structured source and the Italian metadata API source', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const contents = readPolicySources(repoRoot);
  const firstFix = BING_TITLE_FIXES.find((fix) => fix.articleId === 'blog-frontaliere-assicurazione-auto-confronto');
  contents.set(firstFix.source, contents.get(firstFix.source).replaceAll(firstFix.title, firstFix.sourceTitle));
  contents.set(firstFix.metadataSource, contents.get(firstFix.metadataSource).replace(
    firstFix.title,
    firstFix.sourceTitle,
  ));
  const written = [];

  applyFixes({
    repoRoot,
    readFile: (absolutePath) => contents.get(relative(repoRoot, absolutePath)),
    writeFile: (absolutePath, value) => {
      const relativePath = relative(repoRoot, absolutePath);
      contents.set(relativePath, value);
      written.push(relativePath);
    },
  });

  assert.deepEqual(written.sort(), [firstFix.metadataSource, firstFix.source].sort());
  assert.ok(contents.get(firstFix.source).includes(firstFix.title));
  assert.ok(contents.get(firstFix.metadataSource).includes(firstFix.title));
});

test('live audit accepts canonical attributes in either order and numeric entities', async () => {
  const htmlByUrl = new Map(BING_TITLE_FIXES.map((fix) => [
    fix.url,
    '<title>' + fix.title.replace('?', '&#63;') + '</title>'
      + '<link href="' + fix.url + '" rel="alternate canonical">',
  ]));
  const result = await auditLive({
    fetchImpl: async (url) => ({
      status: 200,
      url,
      text: async () => htmlByUrl.get(url),
    }),
  });
  assert.deepEqual(result.findings, []);
});

// Ogni URL della policy e' una stringa scritta a mano, ma lo slug che contiene
// appartiene alla mappa localizzata di `content/router*Data.ts`: sono due copie
// dello stesso dato, e finora niente le teneva insieme. Quando
// `tassa-transito-svizzera-2023` ha preso lo slug francese
// `frais-de-transit-suisse-2026`, qui e' rimasto `frais-de-transit-suisse`:
// l'audit live ha iniziato a chiedere una pagina che non esiste e ne ha ricavato
// TRE finding dalla stessa causa — `http-status` 404, piu' `title-source-drift`
// e `canonical-missing` letti sulla 404 di GitHub Pages, che ha un `<title>`
// suo e nessun canonical. Lo step che apre la PR esce 1 sui finding residui,
// quindi il loop e' rimasto rosso 54h per uno slug, senza che nessuna
// correzione di titolo potesse chiuderlo.
//
// Il confronto e' sul letterale QUOTATO, non sulla sottostringa: `includes`
// nudo troverebbe `frais-de-transit-suisse` dentro
// `'frais-de-transit-suisse-2026'` e il guard passerebbe proprio nel caso che
// deve bocciare.
test('ogni URL della policy punta a uno slug che esiste nella mappa localizzata', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const slugSources = ['content/routerBlogData.ts', 'content/routerSwissData.ts']
    .map((relativePath) => readFileSync(resolve(repoRoot, relativePath), 'utf8'));

  const orphans = BING_TITLE_FIXES
    .map((fix) => new URL(fix.url).pathname.replace(/\/$/, '').split('/').pop())
    .filter((slug) => !slugSources.some((source) => source.includes(`'${slug}'`)));

  assert.deepEqual(
    orphans,
    [],
    `slug assenti da content/router*Data.ts (URL della policy da riallineare): ${orphans.join(', ')}`,
  );
});
