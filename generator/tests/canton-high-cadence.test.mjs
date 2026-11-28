/**
 * canton-high-cadence.mjs — la manopola CANTON_HIGH_CADENCE_SECTIONS (F3.A.1) e
 * la cadenza di base che la lista vuota conserva (F3.A.4, §9.1 del piano).
 * Run with `node --test generator/tests/canton-high-cadence.test.mjs`.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_CADENCE_HOURS,
  CANTON_HIGH_CADENCE_ENV,
  CHAIN_SCOPE_HIGH_CADENCE,
  HIGH_CADENCE_DAILY_BUDGET,
  baseSlotHoursBySection,
  isBaseCadenceSlot,
  isHighCadenceSection,
  parseHighCadenceSections,
  slotHourFromKey,
} from '../scripts/lib/canton-high-cadence.mjs';
import { CHAIN_SCOPE_HIGH_CADENCE as GENERATOR_CHAIN_SCOPE, hourOffsets } from '../../scripts/ci/generate-canton-article-workflows.mjs';
import { RC_TO_ENV, EXPECTED_ABSENT_RC_KEYS, shouldExportRcValue } from '../scripts/load-rc-env.mjs';
import { loadCantonSectionProfiles } from '../scripts/lib/canton-section-profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'generator/scripts/lib/canton-high-cadence.mjs');
const SECTIONS = loadCantonSectionProfiles().cantons.map((c) => c.section);

test('manopola: assente o vuota = nessuna sezione (il comportamento di oggi)', () => {
  for (const raw of [undefined, null, '', '   ', ',;']) {
    assert.deepEqual([...parseHighCadenceSections(raw).sections], [], JSON.stringify(raw));
    assert.equal(isHighCadenceSection('canton-ti', { [CANTON_HIGH_CADENCE_ENV]: raw }), false);
  }
  assert.equal(isHighCadenceSection('canton-ti', {}), false);
});

test('manopola: id, codici e `all`, maiuscole e separatori indifferenti; un nome ignoto non indovina', () => {
  const parsed = parseHighCadenceSections('canton-ti, GR;be  zz');
  assert.deepEqual([...parsed.sections].sort(), ['canton-be', 'canton-gr', 'canton-ti']);
  assert.deepEqual(parsed.unknown, ['zz']);
  assert.equal(parseHighCadenceSections('all').sections.size, 24);
  assert.equal(isHighCadenceSection('canton-ti', { [CANTON_HIGH_CADENCE_ENV]: 'canton-ti' }), true);
  assert.equal(isHighCadenceSection('canton-zh', { [CANTON_HIGH_CADENCE_ENV]: 'canton-ti' }), false);
  assert.equal(isHighCadenceSection('canton-t', { [CANTON_HIGH_CADENCE_ENV]: 'canton-ti' }), false, 'nessuna corrispondenza per prefisso');
});

test('manopola: costanti del piano e valore condiviso con il generatore dei workflow', () => {
  assert.equal(HIGH_CADENCE_DAILY_BUDGET, 24);
  assert.equal(BASE_CADENCE_HOURS, 6);
  assert.equal(CHAIN_SCOPE_HIGH_CADENCE, 'canton-high-cadence');
  assert.equal(GENERATOR_CHAIN_SCOPE, CHAIN_SCOPE_HIGH_CADENCE, 'una sola sorgente fra lo step shell e i caller');
});

test('cadenza di base: stessi slot del vecchio calendario a 6 ore, calcolati con la formula del generatore', () => {
  const legacy = hourOffsets(SECTIONS.map((section) => ({ section, cadenceHours: BASE_CADENCE_HOURS })));
  const base = baseSlotHoursBySection(SECTIONS);
  assert.equal(base.size, 24);
  for (const section of SECTIONS) {
    const offset = legacy.get(section);
    assert.deepEqual(base.get(section), [offset, offset + 6, offset + 12, offset + 18], section);
  }
  assert.equal(isBaseCadenceSlot('canton-ti', 4, SECTIONS), true);
  assert.equal(isBaseCadenceSlot('canton-ti', 5, SECTIONS), false);
  assert.throws(() => isBaseCadenceSlot('canton-xx', 4, SECTIONS), /non e' fra le sezioni/);
  // 24 cantoni su 6 ore, 4 per ora: nessuna ora ha piu' di 4 slot di base.
  const perHour = Array.from({ length: 24 }, () => 0);
  for (const hours of base.values()) for (const h of hours) perHour[h] += 1;
  assert.equal(Math.max(...perHour), 4);
});

test('slotHourFromKey: solo uno slot ben formato ha un\'ora', () => {
  assert.equal(slotHourFromKey('generate-article/canton-ti/2026-11-28T04:19Z'), 4);
  assert.equal(slotHourFromKey('generate-article/canton-ti/2026-11-28T23:59Z'), 23);
  for (const bad of ['', null, undefined, 'generate-article/canton-ti/2026-11-28T24:00Z', 'canton-ti', 'generate-article/canton-ti/2026-11-28T4:19Z']) {
    assert.equal(slotHourFromKey(bad), null, String(bad));
  }
});

test('CLI `has`: exit 0 se la sezione e\' in lista, 1 altrimenti, 2 per un uso sbagliato', () => {
  const run = (args, list) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...(list === undefined ? {} : { [CANTON_HIGH_CADENCE_ENV]: list }) },
  });
  assert.equal(run(['has', 'canton-ti'], 'canton-ti').status, 0);
  assert.equal(run(['has', 'canton-ti'], 'all').status, 0);
  assert.equal(run(['has', 'canton-ti'], 'canton-gr').status, 1);
  assert.equal(run(['has', 'canton-ti'], '').status, 1);
  assert.equal(run(['has', 'canton-ti']).status, 1);
  assert.equal(run(['has']).status, 2);
  assert.equal(run([]).status, 2);
});

test('Remote Config: la chiave e\' mappata, assente per default e vuoto = non esportato', () => {
  assert.deepEqual(RC_TO_ENV[CANTON_HIGH_CADENCE_ENV], [CANTON_HIGH_CADENCE_ENV]);
  assert.equal(EXPECTED_ABSENT_RC_KEYS.has(CANTON_HIGH_CADENCE_ENV), true);
  assert.equal(shouldExportRcValue(null, CANTON_HIGH_CADENCE_ENV), false);
  assert.equal(shouldExportRcValue('', CANTON_HIGH_CADENCE_ENV), false, 'vuoto e assente sono la stessa cosa: nessuna sezione');
  assert.equal(shouldExportRcValue('canton-ti', CANTON_HIGH_CADENCE_ENV), true);
  const rc = readFileSync(path.join(ROOT, 'generator/scripts/load-rc-env.mjs'), 'utf8');
  assert.match(rc, /CANTON_HIGH_CADENCE_SECTIONS: \['CANTON_HIGH_CADENCE_SECTIONS'\]/);
});
