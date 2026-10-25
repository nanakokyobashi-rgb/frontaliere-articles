import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghJson } from '../../scripts/ci/mint-app-token.mjs';

test('ghJson abortisce una richiesta GitHub che non riceve risposta entro la deadline', async () => {
  let signal;
  const pendingFetch = (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };

  await assert.rejects(
    ghJson('/app/installations', { fetchImpl: pendingFetch, timeoutMs: 10 }),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.code, 'MINT_APP_TOKEN_TIMEOUT');
      assert.match(error.message, /GitHub API GET \/app\/installations timed out after 10ms/);
      return true;
    },
  );
  assert.equal(signal.aborted, true);
});

test('ghJson applica la stessa deadline alla lettura del body', async () => {
  let signal;
  const stalledBodyFetch = (_url, options) => {
    signal = options.signal;
    return Promise.resolve({
      status: 201,
      json: () => new Promise(() => {}),
    });
  };

  await assert.rejects(
    ghJson('/app/installations/1/access_tokens', { method: 'POST', fetchImpl: stalledBodyFetch, timeoutMs: 10 }),
    (error) => error.code === 'MINT_APP_TOKEN_TIMEOUT',
  );
  assert.equal(signal.aborted, true);
});

test('ghJson conserva il body nullo quando GitHub restituisce JSON non valido', async () => {
  const result = await ghJson('/app/installations', {
    fetchImpl: () => Promise.resolve({ status: 502, json: () => Promise.reject(new SyntaxError('invalid json')) }),
    timeoutMs: 100,
  });
  assert.deepEqual(result, { status: 502, body: null });
});
