import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelRewireResponseBody, getRewireUrl } from '../scripts/lib/rewire-fetch.mjs';

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

test('getRewireUrl cancella il reader del body quando la deadline vince', async () => {
  let cancelled = 0;
  let released = 0;
  let wakeReader;
  const reader = {
    read: () => new Promise((resolve) => { wakeReader = resolve; }),
    cancel: () => {
      cancelled += 1;
      wakeReader?.({ done: true });
    },
    releaseLock: () => { released += 1; },
  };
  const body = {
    locked: false,
    getReader: () => {
      body.locked = true;
      return reader;
    },
  };

  await assert.rejects(
    getRewireUrl('https://example.invalid/reader.json', {
      retries: 1,
      fetchImpl: async () => ({ ok: true, body }),
      timeoutMs: 10,
    }),
    (error) => error.code === 'REWIRE_FETCH_TIMEOUT',
  );
  assert.equal(cancelled, 1);
  assert.ok(released >= 1);
});

test('getRewireUrl cancella il body di una response arrivata dopo l abort', async () => {
  let resolveFetch;
  let cancelled = 0;
  const response = {
    ok: true,
    body: {
      cancel: () => { cancelled += 1; },
    },
  };
  const pending = getRewireUrl('https://example.invalid/late.json', {
    retries: 1,
    fetchImpl: (_url, { signal }) => new Promise((resolve) => {
      resolveFetch = resolve;
      assert.equal(signal.aborted, false);
    }),
    timeoutMs: 10,
  });

  await assert.rejects(pending, (error) => error.code === 'REWIRE_FETCH_TIMEOUT');
  resolveFetch(response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test('getRewireUrl aspetta la cancellazione prima di avviare il retry', async () => {
  let calls = 0;
  let cancelled = false;
  let wakeReader;
  const firstReader = {
    read: () => new Promise((resolve) => { wakeReader = resolve; }),
    cancel: () => {
      cancelled = true;
      wakeReader?.({ done: true });
    },
    releaseLock: () => {},
  };
  const firstBody = {
    locked: false,
    getReader: () => {
      firstBody.locked = true;
      return firstReader;
    },
  };

  const result = await getRewireUrl('https://example.invalid/retry-after-cancel.json', {
    retries: 2,
    timeoutMs: 10,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: true, body: firstBody };
      assert.equal(cancelled, true);
      return { ok: true, text: async () => '{"ok":true}' };
    },
  });

  assert.equal(result, '{"ok":true}');
  assert.equal(calls, 2);
});

test('cancelRewireResponseBody è ripetibile su body e reader', async () => {
  let cancels = 0;
  const response = { body: { cancel: () => { cancels += 1; } } };
  await cancelRewireResponseBody(response);
  await cancelRewireResponseBody(response);
  assert.equal(cancels, 2);
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
