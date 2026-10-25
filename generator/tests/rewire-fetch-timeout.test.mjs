import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRewireUrl } from '../scripts/lib/rewire-fetch.mjs';

test('getRewireUrl abortisce una richiesta che non riceve headers entro la deadline', async () => {
  let signal;
  const pendingFetch = (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };

  await assert.rejects(
    getRewireUrl('https://example.invalid/data.json', { retries: 1, fetchImpl: pendingFetch, timeoutMs: 10 }),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.code, 'REWIRE_FETCH_TIMEOUT');
      assert.match(error.message, /example\.invalid\/data\.json timed out after 10ms/);
      return true;
    },
  );
  assert.equal(signal.aborted, true);
});

test('getRewireUrl applica la stessa deadline alla lettura del body', async () => {
  let signal;
  const stalledBodyFetch = (_url, options) => {
    signal = options.signal;
    return Promise.resolve({ ok: true, text: () => new Promise(() => {}) });
  };

  await assert.rejects(
    getRewireUrl('https://example.invalid/body.json', { retries: 1, fetchImpl: stalledBodyFetch, timeoutMs: 10 }),
    (error) => error.code === 'REWIRE_FETCH_TIMEOUT',
  );
  assert.equal(signal.aborted, true);
});

test('getRewireUrl conserva il retry su un errore HTTP ritentabile', async () => {
  let calls = 0;
  const result = await getRewireUrl('https://example.invalid/retry.json', {
    retries: 2,
    timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 503 }
        : { ok: true, text: async () => '{"ok":true}' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result, '{"ok":true}');
});
