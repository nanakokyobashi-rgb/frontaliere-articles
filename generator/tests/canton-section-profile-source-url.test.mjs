import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCantonProfile,
  buildCantonSourceUrlMap,
  cantonSourceUrlMapMetrics,
  filterCantonSourceHeadlines,
  sharedCantonFeedUrl,
  sourceUrlCanonicalKey,
} from '../scripts/lib/canton-section-profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILES = JSON.parse(fs.readFileSync(path.join(ROOT, 'generator/data/canton-sections.json'), 'utf8'));

test('un feed cantonale condiviso usa il path della notizia solo se identifica un proprietario', () => {
  const nwUrl = 'https://www.unterwalden24.ch/regionen/nidwalden/story';
  const owUrl = 'https://www.unterwalden24.ch/regionen/obwalden/story';
  assert.equal(sharedCantonFeedUrl(nwUrl), 'NW');
  assert.equal(sharedCantonFeedUrl(owUrl), 'OW');
  assert.equal(sharedCantonFeedUrl('https://www.unterwalden24.ch/regionen/unterwalden/story'), null);
  assert.equal(sharedCantonFeedUrl('https://www.unterwalden24.ch/regionen/nidwalden/obwalden/story'), null);
  assert.equal(sharedCantonFeedUrl('https://unrelated.example/regionen/nidwalden/story'), null);

  const nw = buildCantonProfile('canton-nw', { nationalTopicalKeywords: [], nationalAdmissionKeywords: [] });
  const headlines = [
    { headline: 'Unterwalden: Behörden melden neue Hinweise', url: nwUrl },
    { headline: 'Unterwalden: Behörden melden neue Hinweise', url: owUrl },
    { headline: 'Unterwalden: Behörden melden neue Hinweise', url: 'https://www.unterwalden24.ch/regionen/unterwalden/story' },
    { headline: 'Stans: Behörden melden neue Hinweise', url: owUrl },
  ];
  assert.deepEqual(
    filterCantonSourceHeadlines(nw, { quirks: { filterByCanton: 'NW' } }, headlines).map((item) => item.url),
    [nwUrl],
  );
});

test('la chiave canonica normalizza encoding, diacritici Unicode e varianti same-host da redirect', () => {
  const encoded = 'http://www.example.ch/medien/Gr%C3%A4del/?ort=Gr%C3%A4del#meldung';
  const decomposed = 'https://example.ch/medien/Gra%CC%88del?ort=Gra%CC%88del';
  assert.equal(sourceUrlCanonicalKey(encoded), sourceUrlCanonicalKey(decomposed));
  assert.equal(sourceUrlCanonicalKey('not a URL'), '');
  assert.notEqual(
    sourceUrlCanonicalKey('https://old.example.ch/medien/Gr%C3%A4del'),
    sourceUrlCanonicalKey('https://example.ch/medien/Gr%C3%A4del'),
    'un redirect cross-host non dichiarato non deve diventare un alias implicito',
  );
});

test('le collisioni canoniche sono misurate e rifiutate dalla source URL map', () => {
  const collision = {
    cantons: [
      {
        code: 'LU',
        newsSources: [{
          url: 'https://www.shared.example.ch/region/Gr%C3%A4del/',
          kind: 'media',
          quirks: { localCantonContext: 'LU' },
        }],
      },
      {
        code: 'NW',
        newsSources: [{
          url: 'http://shared.example.ch/region/Gra%CC%88del',
          kind: 'media',
          quirks: { localCantonContext: 'NW' },
        }],
      },
    ],
  };
  const map = buildCantonSourceUrlMap(collision);
  const key = sourceUrlCanonicalKey(collision.cantons[0].newsSources[0].url);

  assert.equal(map.has(key), false, 'una chiave con proprietari diversi non ancora alcun cantone');
  assert.deepEqual(map.sourceUrlMapConflicts, [{ key, cantons: ['LU', 'NW'] }]);
  assert.equal(cantonSourceUrlMapMetrics(collision).sourceUrlMapConflicts, 1);

  const liveMetrics = cantonSourceUrlMapMetrics(PROFILES);
  assert.ok(Number.isInteger(liveMetrics.sourceUrlMapConflicts));
});
