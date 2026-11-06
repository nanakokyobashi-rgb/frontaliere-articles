import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf8');

function cutFunction(name) {
  const match = new RegExp(`^function ${name}\\(`, 'm').exec(SOURCE);
  assert.ok(match, `function ${name} non trovata`);
  const start = match.index;
  const end = SOURCE.slice(start).indexOf('\n}\n');
  assert.notEqual(end, -1, `chiusura di ${name} non trovata`);
  return SOURCE.slice(start, start + end + 2);
}

const collectPublishedTextValuesIterative = new Function(
  `${cutFunction('collectPublishedTextValuesIterative')}\nreturn collectPublishedTextValuesIterative;`,
)();

test('FU-2026-10-10-006: il collector gestisce payload profondi senza ricorsione e mantiene la protezione dai cicli', () => {
  const depth = 10_000;
  const expectedPath = ['deep'];
  let deep = 'foglia';
  for (let level = depth; level > 0; level -= 1) {
    const key = `level${level}`;
    deep = { [key]: deep };
  }
  for (let level = 1; level <= depth; level += 1) expectedPath.push(`level${level}`);

  const shared = { shared: 'una sola volta' };
  const cyclic = { first: shared, second: shared };
  cyclic.self = cyclic;

  const values = collectPublishedTextValuesIterative({ deep, cyclic });
  assert.equal(values.length, 2);
  assert.equal(values[0].text, 'foglia');
  assert.equal(values[0].path, expectedPath.join('.'));
  assert.equal(values[1].path, 'cyclic.first.shared');
  assert.equal(values[1].text, 'una sola volta');
});
