import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readRetryAfterHeader,
  retryAfterSeconds,
} from '../../scripts/backfill-image-credits.mjs';

test('readRetryAfterHeader usa il fallback quando l adapter HTTP non coopera', () => {
  assert.equal(readRetryAfterHeader({ headers: { get: () => '7' } }), '7');
  assert.equal(readRetryAfterHeader({ headers: { get: () => 7 } }), null);
  assert.equal(readRetryAfterHeader({ headers: { get: () => { throw new Error('adapter failure'); } } }), null);
  assert.equal(readRetryAfterHeader(null), null);
  assert.equal(
    retryAfterSeconds(readRetryAfterHeader({ headers: { get: () => { throw new Error('adapter failure'); } } })),
    5,
  );
});
