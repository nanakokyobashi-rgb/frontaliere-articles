import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  releaseBootstrapLocks,
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

test('normalizza gli override degeneri anche nel release dei bootstrap lock', async () => {
  let infinityAttempts = 0;
  const infinity = await releaseBootstrapLocks(['canton-ti'], {
    releaseBootstrapLock: async () => {
      infinityAttempts++;
      return false;
    },
  }, { attempts: Infinity });
  assert.equal(infinity.released, false);
  assert.equal(infinityAttempts, STAGING_VERIFY_ATTEMPTS);

  let symbolAttempts = 0;
  const symbol = await releaseBootstrapLocks(['canton-ti'], {
    releaseBootstrapLock: async () => {
      symbolAttempts++;
      return false;
    },
  }, { attempts: Symbol('invalid') });
  assert.equal(symbol.released, false);
  assert.equal(symbolAttempts, STAGING_VERIFY_ATTEMPTS);
});
