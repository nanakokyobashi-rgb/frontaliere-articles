import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts/ci/pr-body-contract.mjs'), 'utf8');

test('le query paginate del body contract emettono elementi e aggregano dopo tutte le pagine', () => {
  assert.equal((SOURCE.match(/'--paginate', '--jq'/g) || []).length, 3);
  assert.equal((SOURCE.match(/\.\[\] \| select\(\.body \/\/ "" \| contains\("/g) || []).length, 2);
  assert.match(SOURCE, /function paginatedLines\(raw\)/);
  assert.match(SOURCE, /function lastPaginatedValue\(raw\)/);
  assert.match(SOURCE, /paginatedLines\(existing\)\.length > 0/);
  assert.doesNotMatch(SOURCE, /\[\.\[\] \| select\(\.body \/\/ "" \| contains\("[^"]*"\)\)\] \| (?:last \| )?\.(?:id|length)/);
});
