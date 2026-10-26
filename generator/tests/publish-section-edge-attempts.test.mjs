import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOTSTRAP_RELEASE_ATTEMPTS,
  STAGING_VERIFY_ATTEMPTS,
  normalizeBoundedAttempts,
  normalizeStagingVerifyAttempts,
  releaseBootstrapLocks,
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

test('il release dei bootstrap usa il fallback finito per override non numerici', async () => {
  assert.equal(normalizeBoundedAttempts(Symbol('invalid'), 7), 7);
  for (const attempts of [Infinity, Number.NaN, Symbol('invalid')]) {
    let calls = 0;
    const result = await releaseBootstrapLocks(['canton-ti'], {
      releaseBootstrapLock: async () => {
        calls++;
        return false;
      },
    }, { attempts, log: () => {} });
    assert.equal(calls, BOOTSTRAP_RELEASE_ATTEMPTS);
    assert.equal(result.released, false);
  }
});
