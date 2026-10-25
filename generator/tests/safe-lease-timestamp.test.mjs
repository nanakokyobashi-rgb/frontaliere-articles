import assert from 'node:assert/strict';
import test from 'node:test';

import { isNonNegativeSafeInteger } from '../../scripts/lib/safe-lease-timestamp.mjs';

test('R2 lease timestamps share one non-negative safe-integer predicate', () => {
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isNonNegativeSafeInteger(value), true, value);
  }
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.equal(isNonNegativeSafeInteger(value), false, value);
  }
});
