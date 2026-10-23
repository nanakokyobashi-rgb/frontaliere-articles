import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  releaseImageNamespaceLock,
} from '../../scripts/lib/r2-image-namespace-lock.mjs';

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
});
