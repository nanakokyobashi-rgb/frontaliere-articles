import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('scripts/lib/rebase-onto-remote.sh', 'utf8');

test('rebase helper keeps append-only registries on the merge resolver path', () => {
  assert.match(SOURCE, /--merge-registry/);
  assert.match(SOURCE, /merge-content-registry-conflict\.mjs/);
});
