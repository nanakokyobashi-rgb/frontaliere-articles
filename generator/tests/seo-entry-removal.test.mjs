/** Regression tests for the all-or-nothing SEO-entry removal used by retire. */
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engineSeoEntry from '../../engine/shared/seo-entry.mjs';
import * as corpusSeoEntry from '../../scripts/lib/seo-entry.mjs';

const {
  maskSeoSource,
  findAllSeoEntryMatches,
  findSeoEntryMatches,
  removeSeoEntriesFromSource,
} = corpusSeoEntry;

test('il resolver corpus è lo stesso modulo trasportato con l engine', () => {
  for (const name of [
    'maskSeoSource',
    'findSeoEntryMatches',
    'findAllSeoEntryMatches',
    'removeSeoEntriesFromSource',
  ]) {
    assert.strictEqual(
      engineSeoEntry[name],
      corpusSeoEntry[name],
      `${name} deve provenire dalla sorgente engine mirrorata`,
    );
  }

  const engineSource = fs.readFileSync(new URL('../../engine/shared/seo-entry.mjs', import.meta.url), 'utf8');
  const shimSource = fs.readFileSync(new URL('../../scripts/lib/seo-entry.mjs', import.meta.url), 'utf8');
  const rssSource = fs.readFileSync(new URL('../../engine/rssFeeds.mjs', import.meta.url), 'utf8');
  const descriptorSource = fs.readFileSync(new URL('../../engine/shared/articleSectionDescriptors.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(engineSource, /(?:from|import\s*\()\s*['"][^'"]*scripts\//);
  assert.match(shimSource, /from ['"]\.\.\/\.\.\/engine\/shared\/seo-entry\.mjs['"]/);
  assert.match(rssSource, /from ['"]\.\/shared\/seo-entry\.mjs['"]/);
  assert.match(descriptorSource, /from ['"]\.\/seo-entry\.mjs['"]/);
  assert.doesNotMatch(rssSource, /scripts\/lib\/seo-entry/);
  assert.doesNotMatch(descriptorSource, /scripts\/lib\/seo-entry/);
});

test('rimuove tutte le occorrenze SEO duplicate prima che il caller scriva', () => {
  const source = `export const SEO = {
  'blog-ritiro-2026': {
    title: 'prima',
    structuredData: { "description": "un'apostrofo e { graffa }" },
  },
  'blog-altro-2026': { title: 'resta' },
  'blog-ritiro-2026': {
    title: 'duplicata',
    nested: { answer: true },
  },
};
`;

  const result = removeSeoEntriesFromSource(source, 'ritiro-2026', 'fixture.ts');
  assert.equal(result.changed, true);
  assert.equal(result.removed, 2);
  assert.equal(result.src.includes("'blog-ritiro-2026': {"), false);
  assert.match(result.src, /'blog-altro-2026': \{ title: 'resta' \}/);
});

test('un blocco SEO malformato fallisce senza restituire uno stato da persistere', () => {
  const source = "export const SEO = {\n  'blog-ritiro-2026': { title: 'non chiuso'\n";
  assert.throws(
    () => removeSeoEntriesFromSource(source, 'ritiro-2026', 'fixture.ts'),
    /fixture\.ts: graffe sbilanciate attorno a blog-ritiro-2026/,
  );
  // La funzione è pura: l'input rimane intatto e il chiamante non ha ricevuto
  // un testo parziale da mettere nella coda di scritture.
  assert.match(source, /blog-ritiro-2026/);
});

test('un id assente non altera il file', () => {
  const source = "export const SEO = { 'blog-altro-2026': { title: 'resta' } };\n";
  assert.deepEqual(removeSeoEntriesFromSource(source, 'ritiro-2026'), {
    changed: false,
    src: source,
    removed: 0,
  });
});

test('la scansione ignora entry-like nei commenti multilinea e nei template literal', () => {
  const id = 'ritiro-2026';
  const source = [
    'export const esempio = `',
    `  'blog-${id}': {`,
    '    title: \'finta nel template\',',
    '  },',
    '`;',
    'export const SEO = {',
    '  /*',
    `    'blog-${id}': {`,
    '      title: \'finta nel commento\',',
    '    },',
    '  */',
    `  'blog-${id}': {`,
    '    title: \'entry reale\',',
    '    nested: { braces: true },',
    '  },',
    '};',
    '',
  ].join('\n');

  assert.equal(findSeoEntryMatches(source, id, 'fixture.ts').length, 1);
  assert.deepEqual(findAllSeoEntryMatches(source, 'fixture.ts').map(({ id: found }) => found), [id]);

  const result = removeSeoEntriesFromSource(source, id, 'fixture.ts');
  assert.equal(result.removed, 1);
  assert.match(result.src, /finta nel template/);
  assert.match(result.src, /finta nel commento/);
  assert.equal(findSeoEntryMatches(result.src, id, 'fixture.ts').length, 0);
});
