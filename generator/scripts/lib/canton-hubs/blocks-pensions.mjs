/**
 * blocks-pensions.mjs — i blocchi dell'hub pensioni, dal dataset annuale
 * `pension-parameters/latest.json` del sito (parametri federali AVS/LPP/3a,
 * cassa di compensazione e cassa pensione pubblica del cantone, imposta sul
 * prelievo del capitale nel capoluogo).
 *
 * Contratto REWIRE `pension-parameters`, cache scritta da
 * `refresh-pension-parameters.mjs`. Senza cache i blocchi sono `missing`.
 */
import { fmtChf, fmtPct, httpsUrlOrNull } from './format.mjs';
import { BLOCK_THRESHOLDS, finite, isObj, omitted } from './blocks-common.mjs';

export const PENSION_BLOCK_IDS = Object.freeze({ federal: 'parametri-previdenza', funds: 'casse-cantonali', capital: 'imposta-capitale' });

const TXT = {
  it: {
    federalTitle: (year) => `Parametri della previdenza ${year}`,
    federalDescription: 'Importi e aliquote federali validi in tutta la Svizzera: primo pilastro (AVS), secondo pilastro (LPP) e pilastro 3a.',
    avsMin: 'Rendita AVS minima (mensile)', avsMax: 'Rendita AVS massima (mensile)', contrib: 'Contributi AVS/AI/IPG a carico del dipendente',
    lppEntry: 'Soglia d’entrata LPP (salario annuo)', lppCoord: 'Deduzione di coordinamento LPP', lppConv: 'Aliquota minima di conversione LPP',
    p3a: 'Versamento massimo nel pilastro 3a (con cassa pensione)', p3aNo: 'Versamento massimo nel pilastro 3a (senza cassa pensione)',
    federalSource: 'Centro d’informazione AVS/AI e Ufficio federale delle assicurazioni sociali',
    fundsTitle: 'Casse del cantone', fundsDescription: 'Cassa di compensazione AVS e cassa pensione pubblica di riferimento, con il sito ufficiale.',
    compensation: 'Cassa di compensazione', pensionFund: 'Cassa pensione pubblica',
    capitalTitle: (year) => `Imposta sul prelievo del capitale ${year}`,
    capitalDescription: 'Imposte dovute sul prelievo in capitale della previdenza a 65 anni, per una persona sola senza figli residente nel capoluogo.',
    capital: (amount, town) => `Prelievo di ${amount} (${town})`,
    capitalSource: 'Amministrazione federale delle contribuzioni (AFC)',
    note: (year) => `valore federale ${year}`,
  },
  en: {
    federalTitle: (year) => `Pension parameters ${year}`,
    federalDescription: 'Federal amounts and rates valid across Switzerland: first pillar (AHV), second pillar (BVG) and pillar 3a.',
    avsMin: 'Minimum AHV pension (monthly)', avsMax: 'Maximum AHV pension (monthly)', contrib: 'Employee share of AHV/IV/EO contributions',
    lppEntry: 'BVG entry threshold (annual salary)', lppCoord: 'BVG coordination deduction', lppConv: 'Minimum BVG conversion rate',
    p3a: 'Maximum pillar 3a payment (with a pension fund)', p3aNo: 'Maximum pillar 3a payment (without a pension fund)',
    federalSource: 'AHV/IV Information Centre and Federal Social Insurance Office',
    fundsTitle: 'Cantonal funds', fundsDescription: 'The AHV compensation fund and the public pension fund of reference, with their official websites.',
    compensation: 'Compensation fund', pensionFund: 'Public pension fund',
    capitalTitle: (year) => `Tax on lump-sum withdrawals ${year}`,
    capitalDescription: 'Tax due on a lump-sum pension withdrawal at 65, for a single person without children living in the cantonal capital.',
    capital: (amount, town) => `Withdrawal of ${amount} (${town})`,
    capitalSource: 'Federal Tax Administration (FTA)',
    note: (year) => `federal value ${year}`,
  },
  de: {
    federalTitle: (year) => `Eckwerte der Vorsorge ${year}`,
    federalDescription: 'Bundesweit gültige Beträge und Sätze: erste Säule (AHV), zweite Säule (BVG) und Säule 3a.',
    avsMin: 'Minimale AHV-Rente (monatlich)', avsMax: 'Maximale AHV-Rente (monatlich)', contrib: 'Arbeitnehmeranteil der AHV/IV/EO-Beiträge',
    lppEntry: 'BVG-Eintrittsschwelle (Jahreslohn)', lppCoord: 'BVG-Koordinationsabzug', lppConv: 'BVG-Mindestumwandlungssatz',
    p3a: 'Maximale Einzahlung in die Säule 3a (mit Pensionskasse)', p3aNo: 'Maximale Einzahlung in die Säule 3a (ohne Pensionskasse)',
    federalSource: 'Informationsstelle AHV/IV und Bundesamt für Sozialversicherungen',
    fundsTitle: 'Kassen des Kantons', fundsDescription: 'AHV-Ausgleichskasse und öffentliche Pensionskasse des Kantons mit offizieller Website.',
    compensation: 'Ausgleichskasse', pensionFund: 'Öffentliche Pensionskasse',
    capitalTitle: (year) => `Steuer auf Kapitalbezügen ${year}`,
    capitalDescription: 'Steuern auf einem Kapitalbezug aus der Vorsorge mit 65 Jahren für eine alleinstehende Person ohne Kinder mit Wohnsitz im Kantonshauptort.',
    capital: (amount, town) => `Bezug von ${amount} (${town})`,
    capitalSource: 'Eidgenössische Steuerverwaltung (ESTV)',
    note: (year) => `Bundeswert ${year}`,
  },
  fr: {
    federalTitle: (year) => `Paramètres de la prévoyance ${year}`,
    federalDescription: 'Montants et taux fédéraux valables dans toute la Suisse : premier pilier (AVS), deuxième pilier (LPP) et pilier 3a.',
    avsMin: 'Rente AVS minimale (mensuelle)', avsMax: 'Rente AVS maximale (mensuelle)', contrib: 'Part salariale des cotisations AVS/AI/APG',
    lppEntry: 'Seuil d’entrée LPP (salaire annuel)', lppCoord: 'Déduction de coordination LPP', lppConv: 'Taux de conversion minimal LPP',
    p3a: 'Versement maximal au pilier 3a (avec caisse de pension)', p3aNo: 'Versement maximal au pilier 3a (sans caisse de pension)',
    federalSource: 'Centre d’information AVS/AI et Office fédéral des assurances sociales',
    fundsTitle: 'Caisses du canton', fundsDescription: 'Caisse de compensation AVS et caisse de pension publique de référence, avec leur site officiel.',
    compensation: 'Caisse de compensation', pensionFund: 'Caisse de pension publique',
    capitalTitle: (year) => `Impôt sur le retrait en capital ${year}`,
    capitalDescription: 'Impôts dus sur un retrait en capital de la prévoyance à 65 ans, pour une personne seule sans enfant domiciliée au chef-lieu.',
    capital: (amount, town) => `Retrait de ${amount} (${town})`,
    capitalSource: 'Administration fédérale des contributions (AFC)',
    note: (year) => `valeur fédérale ${year}`,
  },
};

function usable(id, dataset, nowMs) {
  if (dataset == null) return omitted(id, 'missing', 'pension-parameters.json non in cache');
  if (!isObj(dataset) || dataset.schemaVersion !== 1 || !Number.isInteger(dataset.year) || !isObj(dataset.federal) || !isObj(dataset.cantons)) {
    return omitted(id, 'invalid', 'pension-parameters.json: forma non riconosciuta');
  }
  const calendarYear = new Date(nowMs).getUTCFullYear();
  if (dataset.year < calendarYear - BLOCK_THRESHOLDS.pensions.maxYearLag) return omitted(id, 'stale', `pension-parameters ${dataset.year} troppo vecchio per il ${calendarYear}`);
  // Anno in corso o precedente, come dice la soglia: un dataset dell'anno
  // prossimo non si pubblica come attuale prima che l'anno cominci.
  if (dataset.year > calendarYear) return omitted(id, 'invalid', `pension-parameters ${dataset.year} oltre l'anno in corso (${calendarYear})`);
  return null;
}

const amount = (v) => Number.isInteger(v) && v > 0;

/** Parametri federali: identici per ogni cantone, ma con fonte e anno. */
export function shapePensionFederalBlock(dataset, { nowMs }) {
  const id = PENSION_BLOCK_IDS.federal;
  const bad = usable(id, dataset, nowMs);
  if (bad) return bad;
  const f = dataset.federal;
  const avs = f.avs;
  // Stessi invarianti del refresh: rendita massima doppia della minima (art. 34 LAVS).
  if (!amount(avs?.minMonthlyCHF) || !amount(avs?.maxMonthlyCHF) || avs.maxMonthlyCHF !== avs.minMonthlyCHF * 2) {
    return omitted(id, 'invalid', 'pension-parameters.json: rendite AVS incoerenti');
  }
  const rows = [
    ['avsMin', avs.minMonthlyCHF, 'chf'],
    ['avsMax', avs.maxMonthlyCHF, 'chf'],
    ['contrib', finite(f.contributions?.employeePct), 'pct'],
    ['lppEntry', amount(f.lpp?.entryThresholdCHF) ? f.lpp.entryThresholdCHF : null, 'chf'],
    ['lppCoord', amount(f.lpp?.coordinationDeductionCHF) ? f.lpp.coordinationDeductionCHF : null, 'chf'],
    ['lppConv', finite(f.lpp?.minConversionRatePct), 'pct'],
    ['p3a', amount(f.pillar3a?.maxWithLppCHF) ? f.pillar3a.maxWithLppCHF : null, 'chf'],
    ['p3aNo', amount(f.pillar3a?.maxWithoutLppCHF) ? f.pillar3a.maxWithoutLppCHF : null, 'chf'],
  ].filter(([, v]) => v != null);
  const sourceUrl = httpsUrlOrNull(avs.source);
  const year = dataset.year;
  return {
    id,
    available: true,
    updatedAt: dataset.generatedAt,
    render(locale) {
      const t = TXT[locale];
      const show = (v, kind) => (kind === 'pct' ? fmtPct(v, locale) : fmtChf(v, locale));
      return {
        title: t.federalTitle(year),
        description: t.federalDescription,
        items: rows.map(([key, v, kind]) => ({ label: t[key], value: show(v, kind) })),
        sourceName: t.federalSource,
        ...(sourceUrl ? { sourceUrl } : {}),
        keyFacts: rows.filter(([key]) => key === 'avsMax' || key === 'p3a').map(([key, v, kind]) => ({ label: t[key], value: show(v, kind), note: t.note(year), sourceName: t.federalSource })),
      };
    },
  };
}

/** Cassa di compensazione e cassa pensione pubblica dei membri del gruppo. */
export function shapePensionFundsBlock(dataset, { canton, members, nowMs }) {
  const id = PENSION_BLOCK_IDS.funds;
  const bad = usable(id, dataset, nowMs);
  if (bad) return bad;
  const funds = members.flatMap((code) => [
    { kind: 'compensation', fund: dataset.cantons[code]?.compensationFund },
    { kind: 'pensionFund', fund: dataset.cantons[code]?.publicPensionFund },
  ]).filter(({ fund }) => isObj(fund) && typeof fund.name === 'string' && fund.name.trim() && httpsUrlOrNull(fund.url));
  if (!funds.length) return omitted(id, 'empty', `nessuna cassa con sito ufficiale per ${canton}`);
  return {
    id,
    available: true,
    updatedAt: dataset.generatedAt,
    render(locale) {
      const t = TXT[locale];
      return {
        title: t.fundsTitle,
        description: t.fundsDescription,
        items: funds.map(({ kind, fund }) => ({ label: fund.name.trim(), detail: t[kind], url: httpsUrlOrNull(fund.url) })),
        keyFacts: [],
      };
    },
  };
}

/** Imposta sul prelievo del capitale di previdenza nel capoluogo. */
export function shapeCapitalTaxBlock(dataset, { canton, members, nowMs }) {
  const id = PENSION_BLOCK_IDS.capital;
  const bad = usable(id, dataset, nowMs);
  if (bad) return bad;
  const amounts = dataset.capitalWithdrawalTax?.amountsCHF;
  if (!Array.isArray(amounts) || !amounts.length || !amounts.every(amount)) return omitted(id, 'invalid', 'pension-parameters.json: importi di prelievo illeggibili');
  const parts = members
    .map((code) => dataset.cantons[code]?.capitalWithdrawalTax)
    .filter((c) => isObj(c) && typeof c.municipality === 'string' && c.municipality && Array.isArray(c.taxCHF) && c.taxCHF.length === amounts.length && c.taxCHF.every((v) => finite(v) != null && v >= 0));
  if (!parts.length) return omitted(id, 'empty', `nessuna imposta sul capitale leggibile per ${canton}`);
  const year = Number.isInteger(dataset.capitalWithdrawalTax.year) ? dataset.capitalWithdrawalTax.year : dataset.year;
  return {
    id,
    available: true,
    updatedAt: dataset.generatedAt,
    render(locale) {
      const t = TXT[locale];
      return {
        title: t.capitalTitle(year),
        description: t.capitalDescription,
        items: parts.flatMap((p) => amounts.map((a, i) => ({ label: t.capital(fmtChf(a, locale), p.municipality), value: fmtChf(p.taxCHF[i], locale) }))),
        sourceName: t.capitalSource,
        keyFacts: [],
      };
    },
  };
}
