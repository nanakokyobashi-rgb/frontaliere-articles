/**
 * Contract tests for the synthetic ASTRA article source.
 *
 * The source is a closed aggregate: prompts must contain the numbers the
 * writer may use, distinguish weekly from monthly cadence, and expose the
 * complete 26-canton table for national articles.
 */
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');

function sliceFn(src, header) {
  const start = src.indexOf(header);
  if (start === -1) throw new Error('formatter header not found');
  const endRel = src.slice(start).search(/\n\}\n/);
  if (endRel === -1) throw new Error('formatter closing brace not found');
  return src.slice(start, start + endRel + 2);
}

const source = fs.readFileSync(CREATE_ARTICLE, 'utf8');
const formatStatsAstraPrompt = new Function(
  sliceFn(source, 'function formatStatsAstraPrompt(cadence, requestedPeriod, section, data) {')
  + '\nreturn formatStatsAstraPrompt;',
)();

function metrics(total, electric = 0) {
  return {
    total,
    electric,
    plugInHybrid: 2,
    hybrid: 3,
    petrol: 4,
    diesel: 5,
    gas: 6,
    other: 7,
  };
}

const cantonRows = Array.from({ length: 26 }, (_unused, index) => {
  const code = ['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH'][index];
  return {
    code,
    stock: metrics(1000 + index, index),
    newRegistrations: metrics(100 + index),
    usedImports: metrics(50 + index),
  };
});
const DATA = {
  source: { overviewUrl: 'https://www.astra.admin.ch/astra/it/home/documentazione/dati-aperti/veicoli.html' },
  weekly: {
    latest: {
      period: '2026-W38',
      national: metrics(255550),
      byCanton: { TI: metrics(13414, 2750) },
    },
    history: [
      { period: '2026-W37', nationalTotal: 250000, ticinoTotal: 13000, ticinoElectric: 2600 },
      { period: '2026-W38', nationalTotal: 255550, ticinoTotal: 13414, ticinoElectric: 2750 },
    ],
  },
  monthly: {
    latest: {
      period: '2026-09',
      national: {
        stock: metrics(4500000),
        newRegistrations: metrics(25000),
        usedImports: metrics(12000),
      },
      byCanton: cantonRows,
    },
    history: [
      { period: '2026-08', nationalStock: 4490000, ticinoStock: 120000, ticinoNewRegistrations: 600, ticinoUsedImports: 300, ticinoElectric: 7000 },
      { period: '2026-09', nationalStock: 4500000, ticinoStock: 121000, ticinoNewRegistrations: 620, ticinoUsedImports: 310, ticinoElectric: 7200 },
    ],
  },
};

describe('formatStatsAstraPrompt', () => {
  it('creates a grounded weekly Ticino prompt without derived percentage anchors', () => {
    const prompt = formatStatsAstraPrompt('weekly', '2026-W38', 'frontaliere', DATA);
    expect(prompt).toContain('[ARTICOLO DATI ASTRA — REPORT SETTIMANALE NUOVE IMMATRICOLAZIONI TICINO]');
    expect(prompt).toContain('13.414');
    expect(prompt).toContain('2026-W37');
    expect(prompt).not.toContain('%');
  });

  it('creates a complete national table with all 26 cantons', () => {
    const prompt = formatStatsAstraPrompt('monthly', '2026-09', 'svizzera', DATA);
    expect(prompt).toContain('[ARTICOLO DATI ASTRA — PARCO VEICOLI E FLUSSI IN SVIZZERA]');
    for (const row of cantonRows) expect(prompt).toContain('| ' + row.code + ' |');
    expect(prompt).toContain('TABELLA COMPLETA DEI 26 CANTONI');
  });

  it('keeps monthly frontalieri output focused on Ticino and its history', () => {
    const prompt = formatStatsAstraPrompt('monthly', '2026-09', 'frontaliere', DATA);
    expect(prompt).toContain('[ARTICOLO DATI ASTRA — PARCO VEICOLI E IMMATRICOLAZIONI IN TICINO]');
    expect(prompt).toContain('Stock veicoli in Ticino 2026-09');
    expect(prompt).toContain('2026-08');
    expect(prompt).not.toContain('TABELLA COMPLETA DEI 26 CANTONI');
  });
});
