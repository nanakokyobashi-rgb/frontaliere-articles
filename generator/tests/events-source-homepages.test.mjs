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
  assert.match(EVENTS_UTILS, /ge-agenda\|https:\/\/www\.geneve\.ch\/agenda\/cafe-quartier-initiation-gout-pain-pain-artisanal-industriel-differences/);
  assert.match(EVENTS_UTILS, /guidle\|https:\/\/www\.guidle\.com\/it\/veranstaltungen\/musik\/zuerich\/don-toliver-nitrous-octane-world-tour-leg-2_A2e1GAw/);
  assert.match(EVENTS_UTILS, /nw-agenda\|https:\/\/www\.nw\.ch\/anlaesseaktuelles\/94120/);
  assert.match(EVENTS_UTILS, /nw-agenda\|https:\/\/www\.nw\.ch\/anlaesseaktuelles\/94123/);
  assert.match(EVENTS_UTILS, /export function assertUniqueEventFallbacks/);
  assert.match(EVENTS_UTILS, /assertUniqueEventFallbacks\(\);/);
  assert.match(EVENTS_UTILS, /unscopedStaleEventSourceUrl/);
  assert.match(EVENTS_UTILS, /eventSourceUrl\(rawUrl, event\)/);
  assert.match(EVENTS_UTILS, /eventReferralUrl\(rawUrl, event\)/);
});
