import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('scripts/lib/rebase-onto-remote.sh', 'utf8');

test('rebase helper preserves generated per-article files with the rebased commit', () => {
  assert.match(SOURCE, /--take-theirs/);
  assert.match(SOURCE, /THEIRS_PREFIXES/);
});
