/**
 * canton-evergreen.mjs — la manopola CANTON_EVERGREEN_SECTIONS (WP3.10b): il
 * ripiego evergreen di una sezione cantonale senza news utilizzabile, spento
 * per default. Run with `node --test generator/tests/canton-evergreen.test.mjs`.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANTON_EVERGREEN_ENV,
  cantonEvergreenCodes,
  isCantonEvergreenSection,
  parseCantonEvergreenSections,
} from '../scripts/lib/canton-evergreen.mjs';
import { RC_TO_ENV, EXPECTED_ABSENT_RC_KEYS, shouldExportRcValue } from '../scripts/load-rc-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CREATE_ARTICLE = readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');

test('default sicuro: chiave assente o vuota = nessuna sezione ripiega sull evergreen', () => {
  for (const raw of [undefined, null, '', '   ']) {
    assert.equal(parseCantonEvergreenSections(raw).sections.size, 0, JSON.stringify(raw));
  }
  assert.equal(isCantonEvergreenSection('canton-ur', {}), false);
  assert.equal(isCantonEvergreenSection('canton-ur', { [CANTON_EVERGREEN_ENV]: '' }), false);
});

test('la lista accetta id, codici e all, e segnala i token sconosciuti', () => {
  const env = { [CANTON_EVERGREEN_ENV]: 'canton-ur, NW zzz' };
  assert.equal(isCantonEvergreenSection('canton-ur', env), true);
  assert.equal(isCantonEvergreenSection('canton-nw', env), true);
  assert.equal(isCantonEvergreenSection('canton-zg', env), false);
  assert.deepEqual(parseCantonEvergreenSections(env[CANTON_EVERGREEN_ENV]).unknown, ['zzz']);
  assert.equal(isCantonEvergreenSection('canton-zg', { [CANTON_EVERGREEN_ENV]: 'all' }), true);
});

test('i codici del pool sono il cantone e i membri del gruppo, senza doppioni', () => {
  assert.deepEqual(cantonEvergreenCodes({ canton: 'UR', members: ['UR'] }), ['UR']);
  assert.deepEqual(cantonEvergreenCodes({ canton: 'AR', members: ['AI', 'AR'] }), ['AR', 'AI']);
  assert.deepEqual(cantonEvergreenCodes(null), []);
});

test('Remote Config: la chiave e mappata, assente per default e vuoto = non esportato', () => {
  assert.deepEqual(RC_TO_ENV[CANTON_EVERGREEN_ENV], [CANTON_EVERGREEN_ENV]);
  assert.equal(EXPECTED_ABSENT_RC_KEYS.has(CANTON_EVERGREEN_ENV), true);
  assert.equal(shouldExportRcValue(null, CANTON_EVERGREEN_ENV), false);
  assert.equal(shouldExportRcValue('', CANTON_EVERGREEN_ENV), false);
  assert.equal(shouldExportRcValue('canton-ur', CANTON_EVERGREEN_ENV), true);
});

test('il generatore usa il pool cantonale solo dietro la manopola e restringe i pilastri al cantone', () => {
  assert.match(CREATE_ARTICLE, /function cantonEvergreenFallbackTopics\(\) \{\n  if \(!IS_CANTON \|\| !isCantonEvergreenSection\(SECTION_NAME\)\) return \[\];/);
  assert.match(CREATE_ARTICLE, /\.filter\(\(topic\) => codes\.has\(topic\.cantonCode\)\)/);
  assert.match(CREATE_ARTICLE, /const topicPool = IS_CANTON\n\s+\? cantonEvergreenFallbackTopics\(\)/);
  // Ogni voce del builder porta il codice cantone da cui il filtro dipende.
  const start = CREATE_ARTICLE.indexOf('function buildStructuralEvergreenTopicsSvizzera() {');
  const end = CREATE_ARTICLE.indexOf('\n}\n', start);
  assert.match(CREATE_ARTICLE.slice(start, end), /cantonCode: c\.code,/);
});
