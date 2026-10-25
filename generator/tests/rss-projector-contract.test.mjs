import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRssProjectorContract } from '../../scripts/lib/rss-projector-contract.mjs';
import { RSS_DESCRIPTION_MAX_CHARS } from '../scripts/lib/seo-description-contract.mjs';

test('il contratto RSS richiede un projector non vuoto e idempotente', () => {
  const projector = (value) => String(value).trim().slice(0, RSS_DESCRIPTION_MAX_CHARS);
  assert.equal(assertRssProjectorContract(projector), projector);
  assert.throws(() => assertRssProjectorContract(null), /must be a function/);
  assert.throws(() => assertRssProjectorContract(() => ''), /non-empty/);
  assert.throws(() => assertRssProjectorContract((value) => String(value).trim()), /cap output/);
  assert.throws(
    () => assertRssProjectorContract((value) => {
      const base = String(value).slice(0, RSS_DESCRIPTION_MAX_CHARS - 1);
      return `${base}${String(value).endsWith('!') ? '?' : '!'}`;
    }),
    /idempotent/,
  );
});
