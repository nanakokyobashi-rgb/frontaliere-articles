import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchPageManifest } from '../../scripts/lib/section-page-manifest.mjs';

const VALID_MANIFEST = {
  schema: 1,
  section: 'canton-ti',
  commit: 'a'.repeat(40),
  counts: { article: 0, archive: 0, hub: 0, landing: 0, total: 0 },
  pages: { article: [], archive: [], hub: [], landing: [] },
};

test('fetchPageManifest stops before starting a request when the shared budget is exhausted', async () => {
  let calls = 0;
  const result = await fetchPageManifest('https://cdn.test/manifest.json', {
    section: 'canton-ti',
    remainingBudget: () => 0,
    fetchImpl: async () => {
      calls++;
      throw new Error('fetch must not start after the deadline');
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.state, 'unknown');
  assert.match(result.reason, /budget wall-clock del manifest esaurito/u);
});

test('fetchPageManifest bounds response body consumption by the shared budget', async () => {
  let cancelled = false;
  const result = await fetchPageManifest('https://cdn.test/manifest.json', {
    section: 'canton-ti',
    remainingBudget: () => 50,
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      body: { cancel: () => { cancelled = true; } },
      json: () => new Promise(() => {}),
    }),
  });

  assert.equal(result.state, 'unknown');
  assert.match(result.reason, /timed out/u);
  assert.equal(cancelled, true);
});

test('fetchPageManifest ritenta un timeout transitorio e poi valida il manifest', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await fetchPageManifest('https://cdn.test/manifest.json', {
    section: 'canton-ti',
    retryDelayMs: 7,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new DOMException('The operation timed out', 'TimeoutError');
      return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 });
    },
  });

  assert.equal(result.state, 'ok');
  assert.equal(result.doc.commit, VALID_MANIFEST.commit);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [7]);
});

test('fetchPageManifest limita i retry transienti e conserva il marker fail-closed', async () => {
  let calls = 0;
  const result = await fetchPageManifest('https://cdn.test/manifest.json', {
    section: 'canton-ti',
    attempts: 99,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      throw new DOMException('The operation timed out', 'TimeoutError');
    },
  });

  assert.equal(result.state, 'unknown');
  assert.equal(result.transient, true);
  assert.equal(calls, 3, 'il cap impedisce una cascata illimitata di richieste edge');
});

test('fetchPageManifest non marchia come transient un documento malformato', async () => {
  let calls = 0;
  const result = await fetchPageManifest('https://cdn.test/manifest.json', {
    section: 'canton-ti',
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ schema: 1 }), { status: 200 });
    },
  });

  assert.equal(result.state, 'unknown');
  assert.equal(result.transient, undefined);
  assert.equal(calls, 1);
});
