/**
 * Verifica il ponte fra le cache REWIRE annuali e il brief del generatore.
 * Il test usa i fixture registrati: nessuna rete e nessuna cache locale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCantonFactsBrief } from '../scripts/lib/canton-facts-brief.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'rewire', name), 'utf8'));
const taxData = fixture('canton-tax.json');
const pensionData = fixture('pension-parameters.json');

test('il brief cantonale porta i valori fiscali e previdenziali del solo cantone', () => {
  const brief = buildCantonFactsBrief({
    canton: 'TI',
    members: ['TI'],
    taxData,
    pensionData,
  });

  assert.match(brief, /dataset 2026/);
  assert.match(brief, /Fisco TI/);
  assert.match(brief, /CHF 30['’]000, CHF 60['’]000/);
  assert.match(brief, /2\.91%, 8\.92%, 14\.43%, 19%, 24\.82%/);
  assert.match(brief, /A0/);
  assert.match(brief, /6\.4%, 10\.1%, 12\.8%, 14\.9%, 19\.1%/);
  assert.match(brief, /rendita AVS mensile minima\/massima CHF 1['’]260\/CHF 2['’]520/);
  assert.match(brief, /soglia d'ingresso CHF 22['’]680/);
  assert.match(brief, /pilastro 3a massimo CHF 7['’]258\/CHF 36['’]288/);
  assert.match(brief, /Istituto delle assicurazioni sociali/);
  assert.doesNotMatch(brief, /Fisco BE|Fisco GE/);
});

test('un gruppo cantonale conserva una riga distinta per ciascun membro', () => {
  const brief = buildCantonFactsBrief({
    canton: 'APPENZELLO',
    members: ['AI', 'AR'],
    taxData,
    pensionData,
  });

  assert.match(brief, /Fisco AI/);
  assert.match(brief, /Fisco AR/);
  assert.match(brief, /Previdenza AI/);
  assert.match(brief, /Previdenza AR/);
});

test('cache incompleta non produce fatti con valori undefined', () => {
  const brief = buildCantonFactsBrief({
    canton: 'TI',
    members: ['TI'],
    taxData: { year: 2026, cantons: {} },
    pensionData: { year: 2026, cantons: {} },
  });

  assert.equal(brief, '');
  assert.doesNotMatch(brief, /undefined|null/);
});
