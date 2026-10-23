import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findAllSeoEntryMatches } from '../../engine/shared/seo-entry.mjs';
import { matchingDelimiter } from '../../scripts/lib/ts-literals.mjs';

const SOURCE = [
  'export default {',
  "  'blog-member-dot': { value: obj.return / 2, pattern: /[}]/u },",
  "  'blog-member-optional': { value: obj?.in / 2, pattern: /[}]/u },",
  "  'blog-private': { value: obj.#in / 2, pattern: /[}]/u },",
  '};',
].join('\n');

test('SEO entry scanner keeps member divisions and regex braces inside each entry', () => {
  const entries = findAllSeoEntryMatches(SOURCE);
  assert.deepEqual(entries.map(({ id }) => id), [
    'member-dot',
    'member-optional',
    'private',
  ]);
  for (const entry of entries) {
    assert.equal(SOURCE[entry.closeIdx], '}', `${entry.id} must close on its object`);
    assert.ok(entry.closeIdx > entry.openIdx, `${entry.id} must have a balanced object`);
  }
  assert.equal(SOURCE.slice(entries[0].openIdx, entries[0].closeIdx + 1).includes('/[}]/u'), true);
});

test('static literal scanner uses the same member-aware boundary contract', () => {
  const rootOpen = SOURCE.indexOf('{');
  const rootClose = matchingDelimiter(SOURCE, rootOpen);
  assert.equal(SOURCE[rootClose], '}');
  assert.equal(SOURCE[rootClose + 1], ';');
});
