import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { removeAbortListenerSafely } from '../scripts/lib/fetch-with-ref-timeout.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('abort cleanup absorbs a non-cooperative signal adapter', () => {
  const signal = {
    removeEventListener() {
      throw new Error('adapter non cooperativo');
    },
  };

  assert.doesNotThrow(() => removeAbortListenerSafely(signal, () => {}));
});

test('publisher retry cleanup uses the safe abort-listener adapter', () => {
  const files = [
    'scripts/publish-section-pages.mjs',
    'scripts/lib/r2-image-namespace-lock.mjs',
    'scripts/lib/announced-surface.mjs',
  ];

  for (const relative of files) {
    const source = readFileSync(`${root}/${relative}`, 'utf8');
    assert.match(source, /removeAbortListenerSafely/);
    assert.doesNotMatch(source, /signal\??\.removeEventListener\(/);
  }
});
