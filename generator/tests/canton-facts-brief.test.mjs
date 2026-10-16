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
const NOW = Date.UTC(2026, 0, 1);

test('il brief cantonale porta i valori fiscali e previdenziali del solo cantone', () => {
  const brief = buildCantonFactsBrief({
    canton: 'TI',
    members: ['TI'],
    taxData,
    pensionData,
    nowMs: NOW,
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
    nowMs: NOW,
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
    nowMs: NOW,
  });

  assert.equal(brief, '');
  assert.doesNotMatch(brief, /undefined|null/);
});

test('il brief scarta le aliquote A0 se cardinalità o valori non rispettano lo shaper canonico', () => {
  const mismatched = structuredClone(taxData);
  mismatched.cantons.TI.withholding.ratesPct.A0.pop();
  const mismatchBrief = buildCantonFactsBrief({ canton: 'TI', taxData: mismatched, nowMs: NOW });
  assert.doesNotMatch(mismatchBrief, /imposta alla fonte A0/);

  const invalid = structuredClone(taxData);
  invalid.cantons.TI.withholding.ratesPct.A0[2] = 50;
  const invalidBrief = buildCantonFactsBrief({ canton: 'TI', taxData: invalid, nowMs: NOW });
  assert.doesNotMatch(invalidBrief, /imposta alla fonte A0/);
});

test('la riga della tassa sul capitale usa il suo anno e richiede array allineati e validi', () => {
  const differentYear = structuredClone(pensionData);
  differentYear.capitalWithdrawalTax.year = 2025;
  const brief = buildCantonFactsBrief({ canton: 'TI', pensionData: differentYear, nowMs: NOW });
  assert.match(brief, /imposta sul capitale, dataset 2025/);
  assert.match(brief, /Previdenza TI, dataset 2026/);

  const mismatched = structuredClone(pensionData);
  mismatched.cantons.TI.capitalWithdrawalTax.taxCHF.pop();
  const mismatchBrief = buildCantonFactsBrief({ canton: 'TI', pensionData: mismatched, nowMs: NOW });
  assert.doesNotMatch(mismatchBrief, /imposta sul capitale/);

  const invalid = structuredClone(pensionData);
  invalid.cantons.TI.capitalWithdrawalTax.taxCHF[1] = -1;
  const invalidBrief = buildCantonFactsBrief({ canton: 'TI', pensionData: invalid, nowMs: NOW });
  assert.doesNotMatch(invalidBrief, /imposta sul capitale/);
});

test('fatti fiscali e previdenziali rispettano la finestra annuale canonica UTC', () => {
  const makeTaxYear = (year) => {
    const data = structuredClone(taxData);
    data.year = year;
    for (const row of Object.values(data.cantons)) {
      if (row?.burdenPct?.['2026']) row.burdenPct[String(year)] = row.burdenPct['2026'];
    }
    return data;
  };

  for (const year of [2025, 2026]) {
    const brief = buildCantonFactsBrief({ canton: 'TI', taxData: makeTaxYear(year), nowMs: NOW });
    assert.match(brief, /Fisco TI/, `tax year ${year} is within the canonical window`);
  }
  for (const year of [2024, 2027]) {
    const brief = buildCantonFactsBrief({ canton: 'TI', taxData: makeTaxYear(year), nowMs: NOW });
    assert.doesNotMatch(brief, /Fisco TI/, `tax year ${year} is outside the canonical window`);
  }

  for (const year of [2025, 2026]) {
    const data = { ...structuredClone(pensionData), year };
    const brief = buildCantonFactsBrief({ canton: 'TI', pensionData: data, nowMs: NOW });
    assert.match(brief, /Previdenza federale/, `pension year ${year} is within the canonical window`);
  }
  for (const year of [2024, 2027]) {
    const data = { ...structuredClone(pensionData), year };
    const brief = buildCantonFactsBrief({ canton: 'TI', pensionData: data, nowMs: NOW });
    assert.doesNotMatch(brief, /Previdenza federale|Previdenza TI/, `pension year ${year} is outside the canonical window`);
  }
});
