import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('il builder SEO e tutti i repair writer fail-closed descrizioni brevi prima della scrittura', () => {
  const writers = [
    'generator/scripts/lib/seo-entry-builder.mjs',
    'generator/scripts/repair-prompt-placeholders.mjs',
    'generator/scripts/repair-plain-excerpts.mjs',
    'generator/scripts/repair-microcopy.mjs',
  ];

  for (const relative of writers) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(source, /assertSeoDescriptionMinimum/, `${relative}: manca il guard condiviso`);
  }
});
