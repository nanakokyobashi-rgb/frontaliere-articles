import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireImageNamespaceLock,
  isImageNamespaceLockPayload,
  parseLeaseTimestamp,
  releaseImageNamespaceLock,
  releaseImageNamespaceLeases,
  serializeImageLeaseContext,
  verifyImageNamespaceLease,
} from '../../scripts/lib/r2-image-namespace-lock.mjs';

test('lease timestamp parsing accepts only decimal safe integers', () => {
  assert.equal(parseLeaseTimestamp('1700000000000'), 1_700_000_000_000);
  for (const raw of ['0', '-1', '1e3', '0x3e8', '1.5', '9007199254740992', undefined]) {
    assert.equal(parseLeaseTimestamp(raw), null, raw);
  }
});

test('lease payloads reject unsafe releasedAt values even when still live', () => {
  const payload = {
    namespace: 'blog',
    owner: 'owner',
    leaseId: 'lease',
    acquiredAt: 1_000,
    expiresAt: 2_000,
  };
  for (const releasedAt of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.equal(isImageNamespaceLockPayload({ ...payload, releasedAt }), false, releasedAt);
  }
});

test('acquisition, verification, and release reject unsafe clocks before R2 I/O', async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    throw new Error('unexpected R2 request');
  };

  await assert.rejects(
    acquireImageNamespaceLock('blog', { request, now: () => -1 }),
    /clock must be a non-negative safe integer millisecond timestamp/,
  );
  await assert.rejects(
    acquireImageNamespaceLock('blog', {
      request,
      acquiredAt: Number.MAX_SAFE_INTEGER,
      leaseMs: 1,
    }),
    /lease expiry must be a non-negative safe integer timestamp/,
  );

  const context = serializeImageLeaseContext([{
    namespace: 'blog',
    owner: 'owner',
    leaseId: 'lease',
    acquiredAt: 1_000,
    expiresAt: 2_000,
    etag: 'lease-etag',
  }]);
  await assert.rejects(
    verifyImageNamespaceLease(context, 'blog', { request, now: () => Number.MAX_SAFE_INTEGER + 1 }),
    /verification clock must be a non-negative safe integer millisecond timestamp/,
  );
  await assert.rejects(
    releaseImageNamespaceLeases(JSON.parse(context).leases, { request, now: () => 0.5 }),
    /release clock must be a non-negative safe integer millisecond timestamp/,
  );
  assert.equal(calls, 0);
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
});
