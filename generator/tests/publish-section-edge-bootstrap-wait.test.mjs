import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOOTSTRAP_WAIT_MS, BOOTSTRAP_RETRY_MS } from '../../scripts/publish-section-edge.mjs';

test('publish-section-edge aspetta il budget massimo del bootstrap prima di fallire', () => {
  assert.equal(BOOTSTRAP_WAIT_MS, 100 * 60 * 1000);
  assert.equal(BOOTSTRAP_RETRY_MS, 20 * 1000);
  assert.ok(BOOTSTRAP_WAIT_MS > BOOTSTRAP_RETRY_MS);
});
