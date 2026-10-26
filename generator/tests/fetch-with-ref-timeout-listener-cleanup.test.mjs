import { test } from 'node:test';
import assert from 'node:assert/strict';

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
