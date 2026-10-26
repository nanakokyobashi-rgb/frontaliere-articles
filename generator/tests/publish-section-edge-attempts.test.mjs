import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGING_VERIFY_ATTEMPTS,
  normalizeStagingVerifyAttempts,
} from '../../scripts/publish-section-edge.mjs';

test('normalizza gli override degeneri del numero di tentativi staging', () => {
  assert.equal(normalizeStagingVerifyAttempts(Infinity), STAGING_VERIFY_ATTEMPTS);
  assert.equal(normalizeStagingVerifyAttempts(-Infinity), STAGING_VERIFY_ATTEMPTS);
  assert.equal(normalizeStagingVerifyAttempts(Number.NaN), STAGING_VERIFY_ATTEMPTS);
  assert.equal(normalizeStagingVerifyAttempts(Symbol('invalid')), STAGING_VERIFY_ATTEMPTS);
  assert.equal(normalizeStagingVerifyAttempts(-4), 1);
  assert.equal(normalizeStagingVerifyAttempts(0), 1);
  assert.equal(normalizeStagingVerifyAttempts(2.9), 2);
  assert.equal(normalizeStagingVerifyAttempts('3'), 3);
});
