import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createR2Request } from '../../scripts/lib/r2-section-lock.mjs';

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

test('R2 requests normalize method casing before signing and sending', async () => {
  const { request, read } = captureRequest();

  await request({
    method: 'get',
    key: 'internal/ci/article-chunk-locks/frontaliere.json',
  });

  assert.equal(read().init.method, 'GET');
  assert.equal(Object.fromEntries(Object.entries(read().init.headers))['accept-encoding'], 'identity');
});

test('R2 transport enumerates Web Headers before signing', async () => {
  const { request, read } = captureRequest();

  await request({
    method: 'GET',
    key: 'internal/ci/article-chunk-locks/frontaliere.json',
    headers: new Headers([
      ['Accept-Encoding', 'gzip'],
      ['X-Test-Header', 'preserved'],
    ]),
  });

  const headers = Object.fromEntries(Object.entries(read().init.headers));
  assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers['x-test-header'], 'preserved');
});
