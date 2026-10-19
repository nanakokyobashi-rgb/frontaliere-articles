/**
 * R2 image namespace lock seed: protocol, transport closure, and CLI import safety.
 *
 * These helpers are copied as one byte-identical unit from the SITE. Static
 * imports below intentionally load the complete local closure with plain Node:
 * no credentials, package install, or R2 access is needed for these tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  acquireImageNamespaceLeases,
  IMAGE_LEASE_CONTEXT_ENV,
  IMAGE_LOCK_ACQUIRE_TIMEOUT_MS,
  IMAGE_LOCK_KEY_PREFIX,
  imageNamespaceForKey,
  imageNamespaceLockKey,
  parseImageNamespaces,
  releaseImageNamespaceLeases,
  serializeImageLeaseContext,
  verifyImageNamespaceLease,
} from '../../scripts/lib/r2-image-namespace-lock.mjs';
import { createR2Request } from '../../scripts/lib/r2-section-lock.mjs';
import { isInvokedDirectly } from '../../scripts/lib/is-invoked-directly.mjs';

function response(status, body = '', etag) {
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === 'etag' ? etag : undefined },
    text: async () => body,
  };
}

function fakeR2() {
  const objects = new Map();
  const calls = [];
  let version = 0;
  const request = async ({ method, key, body = '', headers = {} }) => {
    calls.push({ method, key, headers });
    const current = objects.get(key);
    if (method === 'PUT') {
      if (headers['if-none-match'] === '*' && current) return response(412);
      if (headers['if-match'] && (!current || current.etag !== headers['if-match'])) return response(412);
      const etag = 'image-lease-' + (++version);
      objects.set(key, { payload: JSON.parse(body), etag });
      return response(200, '', etag);
    }
    if (method === 'GET') {
      return current
        ? response(200, JSON.stringify(current.payload), current.etag)
        : response(404);
    }
    throw new Error('unexpected fake method: ' + method);
  };
  return { request, objects, calls };
}

test('the three copied modules load their local ESM closure without running the CLI', () => {
  assert.equal(typeof acquireImageNamespaceLeases, 'function');
  assert.equal(typeof createR2Request, 'function');
  assert.equal(typeof isInvokedDirectly, 'function');
  assert.equal(IMAGE_LEASE_CONTEXT_ENV, 'FRONTALIERE_R2_IMAGE_LEASE_CONTEXT');
  assert.equal(IMAGE_LOCK_ACQUIRE_TIMEOUT_MS, 15 * 60 * 1000);
});

test('identical manifest baselines are SHA-256 prefixes of the copied helper bytes', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../scripts/ci/loop-sync-manifest.json', import.meta.url), 'utf8'));
  for (const rel of [
    'scripts/lib/is-invoked-directly.mjs',
    'scripts/lib/r2-image-namespace-lock.mjs',
    'scripts/lib/r2-section-lock.mjs',
  ]) {
    const entry = manifest.files.find(({ path: manifestPath }) => manifestPath === rel);
    assert.ok(entry, `missing manifest entry for ${rel}`);
    const bytes = fs.readFileSync(new URL('../../' + rel, import.meta.url));
    const sha256 = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    assert.equal(entry.mode, 'identical');
    assert.equal(entry.baseline.site, sha256);
    assert.equal(entry.baseline.corpus, sha256);
  }
});

test('only known image prefixes are accepted, with a stable namespace order', () => {
  assert.deepEqual(parseImageNamespaces('places,blog,places'), ['blog', 'places']);
  assert.equal(IMAGE_LOCK_KEY_PREFIX, 'internal/ci/image-namespace-locks');
  assert.equal(imageNamespaceLockKey('blog'), IMAGE_LOCK_KEY_PREFIX + '/blog.json');
  assert.equal(imageNamespaceForKey('images/blog/hero.webp'), 'blog');
  assert.equal(imageNamespaceForKey('images/places/lugano.webp'), 'places');
  assert.equal(imageNamespaceForKey('images/blogger/hero.webp'), null);
  assert.equal(imageNamespaceForKey('images/blog'), null);
  assert.equal(imageNamespaceForKey('edge/frontaliere/index.html'), null);
  assert.throws(() => parseImageNamespaces(''), /--namespace/);
  assert.throws(() => parseImageNamespaces('blog,unknown'), /unknown namespace/);
});

test('combined acquire verifies ownership and releases in reverse order with CAS tombstones', async () => {
  const { request, objects, calls } = fakeR2();
  const now = 1_000;
  const leases = await acquireImageNamespaceLeases(['places', 'blog'], {
    request,
    now: () => now,
    leaseMs: 60_000,
    timeoutMs: 1_000,
    sleep: async () => {},
  });

  assert.deepEqual(leases.map(({ namespace }) => namespace), ['blog', 'places']);
  assert.deepEqual(
    calls.filter(({ method, headers }) => method === 'PUT' && headers['if-none-match'] === '*').map(({ key }) => key),
    [imageNamespaceLockKey('blog'), imageNamespaceLockKey('places')],
  );
  const context = serializeImageLeaseContext(leases);
  assert.match(context, /"version":1/);
  const verified = await verifyImageNamespaceLease(context, 'blog', { request, now: () => now });
  assert.deepEqual(
    { namespace: verified.namespace, owner: verified.owner, leaseId: verified.leaseId, expiresAt: verified.expiresAt },
    {
      namespace: leases[0].namespace,
      owner: leases[0].owner,
      leaseId: leases[0].leaseId,
      expiresAt: leases[0].expiresAt,
    },
  );

  assert.deepEqual(await releaseImageNamespaceLeases(leases, { request, now: () => now }), ['places', 'blog']);
  assert.deepEqual(
    calls.filter(({ method, headers }) => method === 'PUT' && headers['if-match']).map(({ key }) => key),
    [imageNamespaceLockKey('places'), imageNamespaceLockKey('blog')],
  );
  for (const namespace of ['blog', 'places']) {
    const tombstone = objects.get(imageNamespaceLockKey(namespace)).payload;
    assert.equal(tombstone.releasedAt, now);
    assert.equal(tombstone.expiresAt, now);
  }
  assert.equal(calls.some(({ method }) => method === 'DELETE'), false);
  await assert.rejects(
    verifyImageNamespaceLease(context, 'blog', { request, now: () => now + 1 }),
    /blog lease is no longer owned by this context/,
  );
});

test('one cumulative acquire deadline releases earlier leases when the next namespace times out', async () => {
  const { request: baseRequest, calls, objects } = fakeR2();
  let now = 1_000;
  const placesKey = imageNamespaceLockKey('places');
  objects.set(placesKey, {
    etag: 'other-owner-etag',
    payload: {
      namespace: 'places',
      owner: 'other-owner',
      leaseId: 'other-lease',
      acquiredAt: 0,
      expiresAt: 100_000,
    },
  });
  const request = async (input) => {
    if (input.method === 'PUT'
      && input.key === imageNamespaceLockKey('blog')
      && input.headers?.['if-none-match'] === '*') {
      now += 80;
    }
    return baseRequest(input);
  };
  const sleeps = [];

  await assert.rejects(
    acquireImageNamespaceLeases(['blog', 'places'], {
      request,
      now: () => now,
      leaseMs: 60_000,
      timeoutMs: 100,
      pollMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    }),
    /timed out waiting for namespace places/,
  );

  assert.deepEqual(sleeps, [20]);
  assert.equal(objects.get(imageNamespaceLockKey('blog')).payload.releasedAt, now);
  assert.equal(objects.get(placesKey).payload.owner, 'other-owner');
  assert.equal(objects.get(placesKey).payload.leaseId, 'other-lease');
  assert.equal(calls.filter(({ method, key }) => method === 'PUT' && key === placesKey).length, 2);
  assert.equal(
    calls.filter(({ method, key, headers }) => (
      method === 'PUT' && key === imageNamespaceLockKey('blog') && headers['if-match']
    )).length,
    1,
  );
});

test('verification and release fail closed for an absent, stale, or replaced lease', async () => {
  const { request, objects } = fakeR2();
  let now = 5_000;
  const leases = await acquireImageNamespaceLeases(['blog'], {
    request,
    now: () => now,
    leaseMs: 10_000,
    timeoutMs: 1_000,
    sleep: async () => {},
  });
  const context = JSON.parse(serializeImageLeaseContext(leases));

  await assert.rejects(
    verifyImageNamespaceLease(context, 'places', { request, now: () => now }),
    /no current places lease/,
  );
  now += 10_000;
  await assert.rejects(
    verifyImageNamespaceLease(context, 'blog', { request, now: () => now }),
    /no current blog lease/,
  );

  now = 6_000;
  const key = imageNamespaceLockKey('blog');
  const current = objects.get(key);
  objects.set(key, {
    etag: 'replacement-etag',
    payload: { ...current.payload, leaseId: 'different-lease-id' },
  });
  await assert.rejects(
    verifyImageNamespaceLease(context, 'blog', { request, now: () => now }),
    /no longer owned/,
  );
  assert.deepEqual(await releaseImageNamespaceLeases(leases, { request }), []);
  assert.equal(objects.get(key).payload.leaseId, 'different-lease-id');
});

test('expired takeover uses If-Match and release never mutates a replacement owner', async () => {
  const { request, objects, calls } = fakeR2();
  const key = imageNamespaceLockKey('blog');
  objects.set(key, {
    etag: 'expired-etag',
    payload: {
      namespace: 'blog',
      owner: 'old-owner',
      leaseId: 'old-lease',
      acquiredAt: 100,
      expiresAt: 200,
    },
  });
  const now = 500;
  const leases = await acquireImageNamespaceLeases(['blog'], {
    request,
    now: () => now,
    leaseMs: 10_000,
    timeoutMs: 1_000,
    sleep: async () => {},
  });

  assert.equal(calls.find(({ method, headers }) => method === 'PUT' && headers['if-match']).headers['if-match'], 'expired-etag');
  const replacement = objects.get(key);
  objects.set(key, {
    etag: 'new-owner-etag',
    payload: { ...replacement.payload, owner: 'new-owner', leaseId: 'new-owner-lease' },
  });

  assert.deepEqual(await releaseImageNamespaceLeases(leases, { request }), []);
  assert.equal(objects.get(key).payload.owner, 'new-owner');
  assert.equal(objects.get(key).payload.leaseId, 'new-owner-lease');
});

test('malformed contexts are rejected before making an R2 request', async () => {
  const { request, calls } = fakeR2();
  await assert.rejects(
    verifyImageNamespaceLease('{"version":1,"leases":[]}', 'blog', { request }),
    /invalid shape/,
  );
  assert.deepEqual(calls, []);
});

test('the shared R2 signer makes a conditional request for the exact namespace lock key', async () => {
  let seen;
  const request = createR2Request({
    R2_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    R2_BUCKET: 'article-cdn',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
  }, {
    now: () => new Date('2026-10-19T09:00:00.000Z'),
    fetchImpl: async (url, init) => {
      seen = { url: new URL(String(url)), init };
      return response(200, '', 'etag-1');
    },
  });

  await request({
    method: 'PUT',
    key: imageNamespaceLockKey('blog'),
    body: '{}',
    headers: { 'if-none-match': '*' },
  });

  assert.equal(seen.url.pathname, '/article-cdn/' + imageNamespaceLockKey('blog'));
  assert.equal(seen.init.method, 'PUT');
  assert.equal(seen.init.headers['if-none-match'], '*');
  assert.match(seen.init.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.match(seen.init.headers['x-amz-content-sha256'], /^[a-f0-9]{64}$/);
});

test('direct-entry detection resolves symlinks without treating imports as CLI runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-entry-'));
  const entry = path.join(root, 'entry.mjs');
  const link = path.join(root, 'entry-link.mjs');
  try {
    fs.writeFileSync(entry, '');
    fs.symlinkSync(entry, link);
    assert.equal(isInvokedDirectly(pathToFileURL(entry).href, link), true);
    assert.equal(isInvokedDirectly(pathToFileURL(entry).href, path.join(root, 'other.mjs')), false);
    assert.equal(isInvokedDirectly(pathToFileURL(entry).href, undefined), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
