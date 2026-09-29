import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AnnouncedSurfaceIncoherentError,
  fetchAnnouncedSurfaceSnapshot,
} from '../../scripts/lib/announced-surface.mjs';

const FILES = ['manifest.json', 'slugs.json', 'articles.json', 'swiss-articles.json'];

function payloadFor(url) {
  const file = new URL(url).pathname.split('/').pop();
  return { file };
}

test('#10171: il cache-bust conserva la query già presente nella base API', async () => {
  const urls = [];
  await fetchAnnouncedSurfaceSnapshot('https://api.example.test/articles?tenant=foo', {
    fetchJsonImpl: async (url) => {
      urls.push(url);
      return payloadFor(url);
    },
    validateSnapshot: () => [],
    now: () => 123,
  });

  assert.deepEqual(
    urls.map((url) => new URL(url).pathname),
    FILES.map((file) => `/articles/${file}`),
  );
  for (const url of urls) {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('tenant'), 'foo');
    assert.match(parsed.searchParams.get('reconcile'), /^123-1$/);
  }
});

test('#10171: la deadline abortisce anche una fetch che non risolve', async () => {
  let aborted = false;
  await assert.rejects(
    () => fetchAnnouncedSurfaceSnapshot('https://api.example.test/articles', {
      maxDurationMs: 15,
      fetchJsonImpl: async (_url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      validateSnapshot: () => [],
    }),
    /budget 15ms/,
  );
  assert.equal(aborted, true);
});

test('#10171: un wait di retry lento non può superare il budget totale', async () => {
  const waits = [];
  const startedAt = Date.now();
  await assert.rejects(
    () => fetchAnnouncedSurfaceSnapshot('https://api.example.test/articles', {
      maxAttempts: 3,
      maxDurationMs: 20,
      retryDelayMs: 100,
      fetchJsonImpl: async () => { throw new Error('rete assente'); },
      wait: async (ms) => {
        waits.push(ms);
        return new Promise(() => {});
      },
      validateSnapshot: () => [],
    }),
    /budget 20ms/,
  );
  assert.ok(Date.now() - startedAt < 500, 'il wait non deve lasciare il reader appeso');
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 20);
});

test('#10171: una incoerenza già osservata resta visibile se il retry successivo cade in rete', async () => {
  await assert.rejects(
    () => fetchAnnouncedSurfaceSnapshot('https://api.example.test/articles', {
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchJsonImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.searchParams.get('reconcile') === '0-2') throw new Error('DNS down');
        return payloadFor(url);
      },
      wait: async () => {},
      now: () => 0,
      validateSnapshot: (surface) => {
        const manifestUrl = surface.manifest.file;
        return manifestUrl === 'manifest.json' ? ['commit misto tra manifest e slugs'] : [];
      },
    }),
    (error) => {
      assert.equal(error.name, 'AnnouncedSurfaceIncoherentError');
      assert.ok(error.surfaceErrors.some((entry) => entry.includes('commit misto')));
      assert.ok(error.surfaceErrors.some((entry) => entry.includes('lettura rete successiva')));
      assert.match(String(error.cause), /DNS down/);
      return true;
    },
  );
});
