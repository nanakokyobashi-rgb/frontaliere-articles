import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helper = readFileSync(resolve(here, '../../scripts/lib/shard-git-helpers.sh'), 'utf8');
const publisher = readFileSync(
  resolve(here, '../../scripts/lib/push-article-shard-incremental.sh'),
  'utf8',
);

test('the fast publisher delegates marker reads to the tree-aware shared helper', () => {
  assert.match(helper, /shard_read_counter\(\)[\s\S]*?git -C \"\$dir\" ls-tree HEAD/);
  assert.match(publisher, /shard_read_counter \"\$stage\" \.shard-filecount/);
  assert.doesNotMatch(
    publisher,
    /git -C \"\$stage\" show HEAD:\.shard-filecount[\s\S]*?echo 0/,
  );
});
