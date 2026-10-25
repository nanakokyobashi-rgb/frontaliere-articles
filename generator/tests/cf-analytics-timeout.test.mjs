import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfGraphQL, resolveZoneId } from '../../scripts/lib/cf-analytics.mjs';

test('resolveZoneId abortisce una richiesta Cloudflare che non riceve headers', async () => {
  let signal;
  const pendingFetch = (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };

  await assert.rejects(
    resolveZoneId('secret', 'frontaliereticino.ch', undefined, pendingFetch, 10),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.code, 'CF_ANALYTICS_TIMEOUT');
      assert.match(error.message, /api\.cloudflare\.com.*zones\?name=frontaliereticino\.ch/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
  assert.equal(signal.aborted, true);
});

test('cfGraphQL applica la stessa deadline alla lettura del body', async () => {
  let signal;
  const stalledBodyFetch = (_url, options) => {
    signal = options.signal;
    return Promise.resolve({ status: 200, json: () => new Promise(() => {}) });
  };

  await assert.rejects(
    cfGraphQL('secret', 'query', {}, stalledBodyFetch, 10),
    (error) => error.code === 'CF_ANALYTICS_TIMEOUT',
  );
  assert.equal(signal.aborted, true);
});

test('le primitive Cloudflare conservano i risultati validi', async () => {
  const fetchImpl = (url) => {
    if (url.includes('/zones?')) {
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, result: [{ id: 'zone-1' }] }) });
    }
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ data: { viewer: { zones: [] } } }) });
  };
  assert.equal(await resolveZoneId('secret', 'frontaliere.ch', undefined, fetchImpl, 100), 'zone-1');
  assert.deepEqual(await cfGraphQL('secret', 'query', {}, fetchImpl, 100), { viewer: { zones: [] } });
});
