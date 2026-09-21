import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publisher = readFileSync(
  resolve(root, 'scripts/lib/push-article-shard-incremental.sh'),
  'utf8',
);

// The prose is the stable contract; executable lines must keep the fast path
// from changing the full/delta publisher's history-cap input.
const executable = publisher
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

test('il fast publisher aggiorna filecount ma non accelera il cap dei deploy', () => {
  assert.match(
    publisher,
    /\.shard-deploys.*intentionally NEVER incremented by this script/s,
    'il contratto .shard-deploys deve restare documentato nel publisher',
  );
  assert.match(
    executable,
    /update-index --add --cacheinfo 100644,"\$fc_sha",\.shard-filecount/,
    'il fast path deve mantenere il contatore dei file pubblicati',
  );
  assert.doesNotMatch(
    executable,
    /\.shard-deploys/,
    'il fast path non deve leggere o scrivere il contatore dei deploy',
  );
});
