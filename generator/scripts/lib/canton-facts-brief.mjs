/**
 * Facts annuali per il brief degli articoli cantonali.
 *
 * Le cache sono artefatti REWIRE del sito e vengono riempite dal workflow
 * prima della generazione. Questo modulo non fa fetch: `buildCantonFactsBrief`
 * resta puro e quindi puo' essere verificato con fixture senza rete.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TAX_CACHE = 'generator/data/canton-tax.json';
const PENSION_CACHE = 'generator/data/pension-parameters.json';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function integer(value) {
  return Number.isInteger(value) && value > 0;
}

function numberText(value) {
  if (!finite(value)) return null;
  return new Intl.NumberFormat('de-CH', { maximumFractionDigits: 2 }).format(value);
}

function chf(value) {
  const text = numberText(value);
  return text === null ? null : `CHF ${text}`;
}

function pct(value) {
  const text = numberText(value);
  return text === null ? null : `${text}%`;
}

function valuesText(values, formatter) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const formatted = values.map(formatter);
  return formatted.every(Boolean) ? formatted.join(', ') : null;
}

function memberData(dataset, code) {
  const direct = dataset?.cantons?.[code];
  if (direct && typeof direct === 'object') return direct;
  // Tolerate the wrapper used by older recorded pension fixtures while the
  // public producer remains the source of truth for the live shape.
  const nested = dataset?.cantons?.cantons?.[code];
  return nested && typeof nested === 'object' ? nested : null;
}

function uniqueCodes(canton, members) {
  const source = Array.isArray(members) && members.length > 0 ? members : [canton];
  return [...new Set(source.map((code) => String(code || '').trim().toUpperCase()).filter(Boolean))];
}

function taxLines(taxData, codes) {
  const year = taxData?.year;
  const brackets = taxData?.burden?.incomeBracketsCHF;
  const wages = taxData?.withholding?.monthlyIncomesCHF;
  if (!integer(year) || !Array.isArray(brackets) || !Array.isArray(wages)) return [];

  const lines = [];
  for (const code of codes) {
    const row = memberData(taxData, code);
    const burden = row?.burdenPct?.[String(year)];
    const a0 = row?.withholding?.ratesPct?.A0;
    const burdenValues = valuesText(burden, pct);
    const withholdingValues = valuesText(a0, pct);
    const bracketValues = valuesText(brackets, chf);
    const wageValues = valuesText(wages, chf);
    if (!burdenValues || !bracketValues) continue;

    let line = `- Fisco ${code}, dataset ${year}: onere totale sui redditi annui ${bracketValues} = ${burdenValues}`;
    if (withholdingValues && wageValues) {
      line += `; imposta alla fonte A0 sui salari mensili ${wageValues} = ${withholdingValues}`;
    }
    line += '. Scenario: persona sola senza figli, capoluogo cantonale, senza imposta di culto.';
    lines.push(line);
  }
  return lines;
}

function pensionFederalLine(pensionData) {
  const year = pensionData?.year;
  const federal = pensionData?.federal;
  const avs = federal?.avs;
  const contributions = federal?.contributions;
  const unemployment = federal?.unemployment;
  const lpp = federal?.lpp;
  const pillar3a = federal?.pillar3a;
  if (!integer(year) || !integer(avs?.minMonthlyCHF) || !integer(avs?.maxMonthlyCHF)) return null;

  const facts = [`rendita AVS mensile minima/massima ${chf(avs.minMonthlyCHF)}/${chf(avs.maxMonthlyCHF)}`];
  if (pct(contributions?.employeePct)) facts.push(`AVS/AI/IPG dipendente ${pct(contributions.employeePct)}`);
  if (pct(unemployment?.employeePct) && chf(unemployment?.salaryCapCHF)) {
    facts.push(`AD dipendente ${pct(unemployment.employeePct)} fino a ${chf(unemployment.salaryCapCHF)}`);
  }
  if (chf(lpp?.entryThresholdCHF) && chf(lpp?.coordinationDeductionCHF) && chf(lpp?.maxInsuredSalaryCHF)) {
    facts.push(`LPP: soglia d'ingresso ${chf(lpp.entryThresholdCHF)}, deduzione coordinamento ${chf(lpp.coordinationDeductionCHF)}, salario massimo assicurato ${chf(lpp.maxInsuredSalaryCHF)}`);
  }
  if (chf(pillar3a?.maxWithLppCHF) && chf(pillar3a?.maxWithoutLppCHF)) {
    facts.push(`pilastro 3a massimo ${chf(pillar3a.maxWithLppCHF)}/${chf(pillar3a.maxWithoutLppCHF)} con/senza LPP`);
  }
  return `- Previdenza federale, dataset ${year}: ${facts.join('; ')}.`;
}

function pensionMemberLines(pensionData, codes) {
  const year = pensionData?.year;
  if (!integer(year)) return [];
  const lines = [];
  for (const code of codes) {
    const row = memberData(pensionData, code);
    const facts = [];
    const fund = row?.compensationFund;
    if (fund?.name) facts.push(`cassa di compensazione: ${fund.name}`);
    const publicFund = row?.publicPensionFund;
    if (publicFund?.name) facts.push(`cassa pensione pubblica: ${publicFund.name}`);
    const capital = row?.capitalWithdrawalTax;
    const amounts = valuesText(pensionData?.capitalWithdrawalTax?.amountsCHF, chf);
    const taxes = valuesText(capital?.taxCHF, chf);
    if (capital?.municipality && amounts && taxes) {
      facts.push(`imposta sul capitale nel capoluogo ${capital.municipality} per prelievi ${amounts}: ${taxes}`);
    }
    if (facts.length > 0) lines.push(`- Previdenza ${code}, dataset ${year}: ${facts.join('; ')}.`);
  }
  return lines;
}

/**
 * Costruisce il blocco di fatti verificati per una sezione cantonale.
 *
 * @param {{ canton: string, members?: string[], taxData: object, pensionData: object }} input
 * @returns {string}
 */
export function buildCantonFactsBrief({ canton, members, taxData, pensionData } = {}) {
  const codes = uniqueCodes(canton, members);
  if (codes.length === 0) return '';

  const lines = [
    ...taxLines(taxData, codes),
    pensionFederalLine(pensionData),
    ...pensionMemberLines(pensionData, codes),
  ].filter(Boolean);
  if (lines.length === 0) return '';

  return [
    'FATTI ANNUALI VERIFICATI DEL CANTONE (dataset ufficiali aggiornati; usa questi valori e non ricostruire cifre a memoria):',
    ...lines,
  ].join('\n');
}

function loadJson(root, relativePath) {
  try {
    return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
  } catch (error) {
    console.error(`⚠️  Brief cantonale: cache ${relativePath} non disponibile (${error.message})`);
    return null;
  }
}

/**
 * Legge le due cache già verificate dal refresh workflow e costruisce il brief.
 * Nessun fetch e nessuna scrittura avvengono qui.
 *
 * @param {{ root: string, canton: string, members?: string[] }} input
 * @returns {string}
 */
export function loadCantonFactsBrief({ root = process.cwd(), canton, members } = {}) {
  const taxData = loadJson(root, TAX_CACHE);
  const pensionData = loadJson(root, PENSION_CACHE);
  return buildCantonFactsBrief({ canton, members, taxData, pensionData });
}
