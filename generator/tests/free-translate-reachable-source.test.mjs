import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { codeOnly } from './lib/reachable-source.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const target = path.join(root, 'generator/scripts/lib/free-translate.mjs');

test('codeOnly spoglia i commenti dal modulo radice raggiungibile di free-translate', () => {
  const source = fs.readFileSync(target, 'utf8');
  assert.match(source, /^\/\/ Misura corpus 2026-09-12 \(content\/blog-body\{,-ch\}\):$/mu);

  const stripped = codeOnly(source);

  assert.ok(stripped.length < source.length,
    'codeOnly ha restituito free-translate.mjs invariato: lo scanner e\' diventato cieco');
  assert.doesNotMatch(stripped, /^\/\/ Misura corpus 2026-09-12 \(content\/blog-body\{,-ch\}\):$/mu);
});
