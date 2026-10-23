import test from 'node:test';
import assert from 'node:assert/strict';
import { selectConsistentTitleEvidence } from '../scripts/lib/source-url-ledger.mjs';

test('title evidence treats CR and CRLF declarations as equivalent', () => {
  assert.equal(
    selectConsistentTitleEvidence('A 13: Stau\r\nA 13: STAU'),
    'A 13: Stau',
  );
});
