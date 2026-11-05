import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import {
  fetchWithRefTimeout,
  removeAbortListenerSafely,
} from '../scripts/lib/fetch-with-ref-timeout.mjs';

test('removeAbortListenerSafely assorbe un adapter che lancia durante il cleanup', () => {
  const signal = {
    removeEventListener: () => { throw new Error('non-cooperative adapter'); },
  };
  assert.doesNotThrow(() => removeAbortListenerSafely(signal, () => {}));
});

test('fetchWithRefTimeout completa il cleanup anche con un signal non cooperativo', async () => {
  const signal = {
    aborted: false,
    addEventListener: () => {},
    removeEventListener: () => { throw new Error('non-cooperative adapter'); },
  };
  const response = { body: null };
  await assert.doesNotReject(
    fetchWithRefTimeout('https://example.invalid/empty', { signal }, 100, async () => response),
  );
});


test('fetchWithRefTimeout decodes a cross-realm ArrayBuffer body', async () => {
  const bytes = [...Buffer.from('{"ok":true}')];
  let sent = false;
  let released = false;
  const response = await fetchWithRefTimeout('https://example.invalid/feed', {}, 1000, async () => ({
    body: { getReader: () => ({
      async read() {
        if (sent) return { done: true };
        sent = true;
        return { done: false, value: runInNewContext('new Uint8Array(bytes).buffer', { bytes }) };
      },
      releaseLock() { released = true; },
    }) },
    json() {},
  }));
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(released, true);
});
