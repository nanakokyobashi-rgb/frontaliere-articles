import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReleaseOutcome,
  releaseImageNamespaceLock,
  releaseNotOwnedIsFatal,
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
  assert.equal(releaseNotOwnedIsFatal({ fenceMissingCandidate: true }), false);
  assert.equal(releaseNotOwnedIsFatal({ fenceMissingCandidate: false }), true);
});

test('release deadline classification is deterministic at and after the boundary', () => {
  assert.equal(classifyReleaseOutcome({ completedAt: 1_000, deadline: 1_000 }), 'released');
  assert.equal(classifyReleaseOutcome({ completedAt: 1_001, deadline: 1_000 }), 'timeout');
  assert.equal(classifyReleaseOutcome({ timedOut: true, completedAt: 1_000, deadline: 1_000 }), 'timeout');
  assert.equal(classifyReleaseOutcome({ completedAt: 1_000 }), 'timeout');
});
