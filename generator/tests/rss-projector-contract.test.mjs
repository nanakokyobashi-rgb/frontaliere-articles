import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRssProjectorContract } from '../../scripts/lib/rss-projector-contract.mjs';

test('il contratto RSS richiede un projector non vuoto e idempotente', () => {
  const projector = (value) => String(value).trim();
  assert.equal(assertRssProjectorContract(projector), projector);
  assert.throws(() => assertRssProjectorContract(null), /must be a function/);
  assert.throws(() => assertRssProjectorContract(() => ''), /non-empty/);
  assert.throws(() => assertRssProjectorContract((value) => `${value}!`), /idempotent/);
});
