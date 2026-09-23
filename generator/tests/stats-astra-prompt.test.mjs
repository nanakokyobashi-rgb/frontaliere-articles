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
import {
  decodeSyntheticSourceToken,
  isZeroSourceForGenerationBudget,
  markSyntheticSourceValidation,
} from '../scripts/lib/synthetic-source-contract.mjs';

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
const checkStatsAstraCountFidelity = new Function(
  sliceFn(source, 'export function checkStatsAstraCountFidelity(articleText, sourceText) {')
    .replace(/^export /, '')
  + '\nreturn checkStatsAstraCountFidelity;',
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
const weeklyCantonMap = Object.fromEntries(
  cantonRows.map((row, index) => [row.code, metrics(500 + index, index)]),
);
weeklyCantonMap.TI = metrics(13414, 2750);
const DATA = {
  source: { overviewUrl: 'https://www.astra.admin.ch/astra/it/home/documentazione/dati-aperti/veicoli.html' },
  weekly: {
    latest: {
      period: '2026-W38',
      national: metrics(255550),
      byCanton: weeklyCantonMap,
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
    expect(prompt).toContain('=== CONTEGGI ASTRA DA CITARE ===');
    expect(prompt).not.toContain('%');
  });

  it('rejects a requested period that is not the current compact snapshot', () => {
    expect(() => formatStatsAstraPrompt('weekly', '2026-W37', 'frontaliere', DATA))
      .toThrow(/not available/);
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

  it('blocks an ASTRA article that drops a primary count', () => {
    const prompt = formatStatsAstraPrompt('weekly', '2026-W38', 'frontaliere', DATA);
    const complete = checkStatsAstraCountFidelity(
      'La settimana registra 255.550 veicoli in Svizzera, 13.414 in Ticino e 2750 elettrici.',
      prompt,
    );
    expect(complete.passed).toBe(true);
    const incomplete = checkStatsAstraCountFidelity(
      'La settimana registra 255.550 veicoli in Svizzera, ma il dato ticinese è in aggiornamento.',
      prompt,
    );
    expect(incomplete.passed).toBe(false);
    expect(incomplete.reason).toContain('13.414');
  });

  it('rejects an incomplete canton table instead of formatting a partial source', () => {
    const partial = structuredClone(DATA);
    partial.monthly.latest.byCanton = partial.monthly.latest.byCanton.slice(0, 25);
    expect(() => formatStatsAstraPrompt('monthly', '2026-09', 'svizzera', partial))
      .toThrow(/complete 26-canton table/);
  });
});

describe('synthetic source contract', () => {
  it('turns malformed percent-encoding into a deferible quality rejection', () => {
    expect(() => decodeSyntheticSourceToken('%E0%A4%A', 'ASTRA')).toThrow(/malformed percent-encoding/);
    try {
      decodeSyntheticSourceToken('%E0%A4%A', 'ASTRA');
    } catch (error) {
      expect(error.qualityReject).toBe(true);
      expect(error.syntheticSourceReject).toBe(true);
    }
  });

  it('caps empty ASTRA source content but preserves synthetic BFS/evergreen budgets', () => {
    expect(isZeroSourceForGenerationBudget('', 'stats-astra://monthly/2026-09/frontaliere')).toBe(true);
    expect(isZeroSourceForGenerationBudget('', 'stats-bfs://2026-Q3')).toBe(false);
    expect(isZeroSourceForGenerationBudget('', 'evergreen://tasse')).toBe(false);
  });

  it('marks partial-source validation as a quality rejection', () => {
    const error = markSyntheticSourceValidation(new Error('partial ASTRA document'), 'ASTRA');
    expect(error.message).toContain('partial ASTRA document');
    expect(error.qualityReject).toBe(true);
    expect(error.syntheticSourceReject).toBe(true);
  });

  it('keeps the raw ASTRA suffix at the fetch boundary for contract decoding', () => {
    const start = source.indexOf("if (url.startsWith('stats-astra://'))");
    const end = source.indexOf('  // Handle evergreen topics', start);
    const branch = source.slice(start, end);
    expect(branch).not.toMatch(/decodeURIComponent/);
    expect(branch).toContain('buildStatsAstraPromptContent(token)');
  });

  it('keeps the missing-document guard inside ASTRA quality validation', () => {
    const start = source.indexOf('async function buildStatsAstraPromptContent(token) {');
    const end = source.indexOf('function formatStatsAstraPrompt', start);
    const builder = source.slice(start, end);
    expect(builder).toMatch(/try\s*\{[\s\S]*if \(!snap\.exists\)[\s\S]*markSyntheticSourceValidation/);
  });
});
