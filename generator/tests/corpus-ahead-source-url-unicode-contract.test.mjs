import test from 'node:test';
import assert from 'node:assert/strict';
import { shortHeadlineTokenPolicy } from '../scripts/lib/source-url-ledger.mjs';

test('short headline tokens use visible graphemes, not UTF-16 width', () => {
  assert.equal(shortHeadlineTokenPolicy('𐐀𐐁'), false);
  assert.equal(shortHeadlineTokenPolicy('e\u0301xit'), true);
});
