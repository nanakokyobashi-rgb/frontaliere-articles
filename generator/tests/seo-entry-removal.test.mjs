/** Regression tests for the all-or-nothing SEO-entry removal used by retire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeSeoEntriesFromSource } from '../../scripts/lib/seo-entry.mjs';

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
