import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GIT_PUSH_CHAIN_DEADLINE_MS,
  gitPushChainTimeoutMs,
} from '../scripts/batch-add-faq-to-articles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, '..', 'scripts', 'batch-add-faq-to-articles.mjs');

test('#625 la catena commit/push ha una deadline complessiva di 30 secondi', () => {
  assert.equal(GIT_PUSH_CHAIN_DEADLINE_MS, 30_000);
  assert.equal(gitPushChainTimeoutMs(1_000, 60_000, 1_000), 30_000);
  assert.equal(gitPushChainTimeoutMs(1_000, 60_000, 2_675), 28_325);
  assert.equal(gitPushChainTimeoutMs(1_000, 5_000, 2_675), 5_000);
  assert.equal(
    gitPushChainTimeoutMs(1_000, 60_000, 2_675, 5_000),
    23_325,
    'pull e retry push devono lasciare cinque secondi al rebase --abort',
  );
});

test('#625 una catena scaduta non avvia il comando successivo', () => {
  assert.throws(
    () => gitPushChainTimeoutMs(1_000, 60_000, 31_000),
    (error) => error?.code === 'GIT_PUSH_CHAIN_DEADLINE',
  );
});

test('#625 tutti e cinque i comandi seriali consumano lo stesso budget', () => {
  const source = readFileSync(SOURCE, 'utf8');
  const start = source.indexOf('function gitCommitAndPush');
  const end = source.indexOf('\nfunction commitIfNeeded', start);
  assert.ok(start >= 0 && end > start, 'gitCommitAndPush non trovato');
  const body = source.slice(start, end);
  assert.equal(
    (body.match(/timeout:\s*gitPushChainTimeoutMs\(chainStartedAt,/g) || []).length,
    5,
    'commit, push, pull --rebase, retry push e rebase --abort devono condividere la deadline',
  );
  assert.doesNotMatch(
    body,
    /timeout:\s*(?:30000|60000)\b/,
    'un timeout indipendente ricreerebbe il bound seriale di 210 secondi',
  );
});
