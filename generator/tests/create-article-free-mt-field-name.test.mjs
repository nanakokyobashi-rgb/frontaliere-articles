import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');

test('freeMtField inoltra il nome reale del campo al validatore free-MT', () => {
  const start = source.indexOf('function freeMtField(');
  const end = source.indexOf('\n}\n', start);

  assert.ok(start >= 0 && end > start, 'wrapper freeMtField non trovato');
  const wrapper = source.slice(start, end);

  assert.match(
    wrapper,
    /translateFieldFreeMt\(\{[\s\S]*?fieldName:\s*field,/
  );
});
