import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acquireSectionLock,
  createR2Request,
  isLockPayload,
  renewSectionLock,
} from '../../scripts/lib/r2-section-lock.mjs';

const env = {
  R2_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  R2_BUCKET: 'articles',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret-key',
};

function captureRequest() {
  let captured;
  const request = createR2Request(env, {
    now: () => new Date('2026-10-20T06:00:00.000Z'),
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { status: 200 };
    },
  });
  return { request, read: () => captured };
}

test('R2 lock reads force identity encoding before signing', async () => {
  for (const method of ['GET', 'HEAD']) {
    const { request, read } = captureRequest();

    await request({
      method,
      key: 'internal/ci/article-chunk-locks/frontaliere.json',
      headers: {
        'Accept-Encoding': 'gzip',
        'X-Test-Header': 'preserved',
      },
    });

    const headers = Object.entries(read().init.headers);
    assert.equal(headers.filter(([name]) => name === 'accept-encoding').length, 1);
    assert.equal(Object.fromEntries(headers)['accept-encoding'], 'identity');
    assert.equal(Object.fromEntries(headers)['x-test-header'], 'preserved');
  }
});

test('R2 writes retain caller-provided encoding headers', async () => {
  const { request, read } = captureRequest();

  await request({
    method: 'PUT',
    key: 'internal/ci/article-chunk-locks/frontaliere.json',
    body: '{}',
    headers: { 'Accept-Encoding': 'gzip' },
  });

  assert.equal(Object.fromEntries(Object.entries(read().init.headers))['accept-encoding'], 'gzip');
});

test('R2 transport normalizes method casing and Web Headers before signing', async () => {
  const { request, read } = captureRequest();

  await request({
    method: 'get',
    key: 'internal/ci/article-chunk-locks/frontaliere.json',
    headers: new Headers({ 'X-Test-Header': 'preserved' }),
  });

  assert.equal(read().init.method, 'GET');
  assert.equal(read().init.headers['x-test-header'], 'preserved');
  assert.equal(read().init.headers['accept-encoding'], 'identity');
});

test('lowercase GET keeps a successful response body readable', async () => {
  let cancelled = false;
  let captured;
  const request = createR2Request(env, {
    now: () => new Date('2026-10-20T06:00:00.000Z'),
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        status: 200,
        body: { cancel: () => { cancelled = true; } },
        text: async () => '{"ok":true}',
      };
    },
  });

  const response = await request({
    method: 'get',
    key: 'internal/ci/article-chunk-locks/frontaliere.json',
  });

  assert.equal(captured.init.method, 'GET');
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(cancelled, false);
});

test('lock payload timestamps are non-negative safe integers', () => {
  const valid = {
    owner: 'run-1',
    section: 'frontaliere',
    acquiredAt: 0,
    expiresAt: 1,
  };

  assert.equal(isLockPayload(valid), true);
  for (const [name, value] of [
    ['negative acquiredAt', { ...valid, acquiredAt: -1 }],
    ['fractional acquiredAt', { ...valid, acquiredAt: 0.5 }],
    ['unsafe expiresAt', { ...valid, expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative expiresAt', { ...valid, expiresAt: -1 }],
    ['infinite expiresAt', { ...valid, expiresAt: Number.POSITIVE_INFINITY }],
  ]) {
    assert.equal(isLockPayload(value), false, name);
  }
});

test('acquire and renew reject clocks that cannot produce safe timestamps', async () => {
  const request = async () => {
    throw new Error('request must not run');
  };

  await assert.rejects(
    () => acquireSectionLock('frontaliere', { request, now: () => 0.5 }),
    /acquiredAt must be a non-negative safe integer timestamp/u,
  );
  await assert.rejects(
    () => acquireSectionLock('frontaliere', {
      request,
      now: () => Number.MAX_SAFE_INTEGER,
      leaseMs: 2,
    }),
    /expiresAt must be a non-negative safe integer timestamp/u,
  );

  const current = {
    owner: 'run-1',
    leaseId: 'lease-1',
    section: 'frontaliere',
    acquiredAt: 1,
    expiresAt: 2,
  };
  const renewRequest = async ({ method }) => {
    if (method === 'GET') {
      return {
        status: 200,
        headers: { etag: '"strong"' },
        text: async () => JSON.stringify(current),
      };
    }
    throw new Error('renew PUT must not run');
  };
  await assert.rejects(
    () => renewSectionLock('frontaliere', {
      owner: current.owner,
      leaseId: current.leaseId,
      request: renewRequest,
      now: () => -1,
    }),
    /acquiredAt must be a non-negative safe integer timestamp/u,
  );
});
