import assert from 'node:assert/strict';
import test from 'node:test';

import { pickClusterSeeds } from '../scripts/lib/discovery/sources/googleSuggestSource.mjs';

test('pickClusterSeeds ignores nullish, boolean and blank p50 evidence', () => {
  const stats = {
    fiscale: { p50: null },
    salute: { p50: false },
    lavoro: { p50: ' ' },
    pensioni: { p50: 120 },
  };

  assert.deepEqual(pickClusterSeeds(stats), [
    'avs lpp frontalieri svizzera',
    'secondo pilastro frontalieri svizzera',
  ]);
});
