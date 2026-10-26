import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENTS_UTILS = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/lib/events-utils.mjs'),
  'utf8',
);

test('events-utils mantiene la landing canonica di Guidle', () => {
  assert.match(EVENTS_UTILS, /homepage:\s*'https:\/\/www\.guidle\.com\/de'/);
});

test('un dettaglio evento NW scaduto ha un fallback source-backed esplicito', () => {
  assert.match(EVENTS_UTILS, /nw-agenda\|https:\/\/www\.nw\.ch\/anlaesseaktuelles\/94123/);
  assert.match(EVENTS_UTILS, /eventSourceUrl\(rawUrl, event\)/);
  assert.match(EVENTS_UTILS, /eventReferralUrl\(rawUrl, event\)/);
});
