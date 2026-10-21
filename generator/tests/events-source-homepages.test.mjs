import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_SOURCES } from '../scripts/lib/events-utils.mjs';

test('Guidle usa la landing canonica senza redirect', () => {
  assert.equal(EVENT_SOURCES.guidle.homepage, 'https://www.guidle.com/de');
});
