import test from 'node:test';
import assert from 'node:assert/strict';
import { nextHtmlTagStatus } from '../scripts/lib/html-tag-scanner.mjs';

test('distinguishes malformed markup from a clean end of input', () => {
  assert.deepEqual(nextHtmlTagStatus('<div'), { status: 'malformed' });
  assert.deepEqual(nextHtmlTagStatus('plain text'), { status: 'eof' });
});
