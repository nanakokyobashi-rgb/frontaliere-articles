import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePublishPlan } from '../../scripts/ci/fast-publish-section.mjs';

test('un push solo immagine risolve la sezione e l id dal registry', () => {
  const plan = imagePublishPlan(['public/images/places/swissminiatur.webp'], undefined, { served: 'shard' });
  assert.deepEqual(plan, [{ section: 'svizzera', ids: ['costo-vita-svizzera-2026'], bootstrap: false }]);
});

test('un immagine non dichiarata non attiva nessun publisher', () => {
  assert.deepEqual(imagePublishPlan(['public/images/places/not-declared-in-registry.webp'], undefined, { served: 'shard' }), []);
});
