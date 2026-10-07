import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stripPlaceholderTokens } from '../scripts/lib/translation-glossary.mjs';

test('rimuove il placeholder dalla label Markdown senza esporre la destinazione', () => {
  assert.equal(
    stripPlaceholderTokens('[COMPANY](https://example.test/%COMPANY%)'),
    '(https://example.test/%COMPANY%)',
  );
});

test('protegge fino alla fine utile una destinazione Markdown con parentesi annidate', () => {
  for (const value of [
    '[x](https://h/a_(b)/tail%COMPANY%',
    '[x](https://h/a_(b) %COMPANY% https://z/tail',
  ]) {
    assert.equal(stripPlaceholderTokens(value), value);
  }
});
