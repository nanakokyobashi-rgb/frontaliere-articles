import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchPageManifest } from '../../scripts/lib/section-page-manifest.mjs';

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
