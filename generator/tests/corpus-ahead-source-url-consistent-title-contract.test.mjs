import test from 'node:test';
import assert from 'node:assert/strict';
import { selectConsistentTitleEvidence } from '../scripts/lib/source-url-ledger.mjs';

test('conflicting title declarations fail closed before matching', () => {
  assert.equal(
    selectConsistentTitleEvidence(['A 13: Stau', 'A 13: Unfall']),
    '',
  );
});
