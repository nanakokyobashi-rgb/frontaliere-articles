import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  releaseImageNamespaceLock,
  releaseNotOwnedIsFatal,
  resolveRequestedLeaseTimestamp,
} from '../../scripts/lib/r2-image-namespace-lock.mjs';

test('acquisition timestamps accept only positive finite overrides', () => {
  for (const value of ['', '0', '-1', 'not-a-timestamp', 'Infinity', null, true, false, {}]) {
    assert.equal(resolveRequestedLeaseTimestamp(value, 5_000), 5_000, value);
  }
  assert.equal(resolveRequestedLeaseTimestamp('1700000000', 5_000), 1_700_000_000);
  assert.equal(resolveRequestedLeaseTimestamp(42, 5_000), 42);
});

test('candidate fencing treats a lease owned by another writer as benign', async () => {
  const candidate = {
    namespace: 'blog',
    owner: 'candidate-owner',
    leaseId: 'candidate-lease',
    acquiredAt: 1_000,
    expiresAt: 2_000,
  };
  const current = {
    namespace: 'blog',
    owner: 'other-owner',
    leaseId: 'other-lease',
    acquiredAt: 1_000,
    expiresAt: 9_000,
  };
  const result = await releaseImageNamespaceLock(candidate, {
    fenceMissingCandidate: true,
    request: async ({ method }) => {
      assert.equal(method, 'GET');
      return {
        status: 200,
        headers: { get: () => '"other-etag"' },
        text: async () => JSON.stringify(current),
      };
    },
    now: () => 2_000,
  });
  assert.equal(result, false);
  assert.equal(releaseNotOwnedIsFatal({ fenceMissingCandidate: true }), false);
  assert.equal(releaseNotOwnedIsFatal({ fenceMissingCandidate: false }), true);
});
