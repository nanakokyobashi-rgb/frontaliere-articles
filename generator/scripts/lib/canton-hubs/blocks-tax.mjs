/**
 * blocks-tax.mjs — i blocchi dell'hub fisco, dal dataset annuale
 * `canton-tax/latest.json` del sito (onere fiscale ESTV per capoluogo e
 * tariffe dell'imposta alla fonte per cantone).
 *
 * Contratto REWIRE `canton-tax`, cache scritta da `refresh-canton-tax.mjs`.
 * Senza cache i due blocchi sono `missing` e l'hub fisco si regge su intro,
 * avvisi ufficiali, news e strumenti.
 */
import { fmtChf, fmtPct, httpsUrlOrNull } from './format.mjs';
import { BLOCK_THRESHOLDS, finite, isObj, omitted } from './blocks-common.mjs';

export const TAX_BLOCK_IDS = Object.freeze({ burden: 'onere-fiscale', withholding: 'imposta-alla-fonte' });

const ESTV = { it: 'Amministrazione federale delle contribuzioni (AFC)', en: 'Federal Tax Administration (FTA)', de: 'Eidgenössische Steuerverwaltung (ESTV)', fr: 'Administration fédérale des contributions (AFC)' };

const TXT = {
  it: {
    burdenTitle: (year) => `Onere fiscale ${year}`,
    burdenDescription: 'Imposte cantonali, comunali e federali sul reddito in percentuale del reddito lordo annuo, per una persona sola senza figli residente nel capoluogo.',
    income: (amount, town) => `Reddito lordo di ${amount} (${town})`,
    withholdingTitle: (year) => `Imposta alla fonte ${year}`,
    withholdingDescription: 'Aliquota dell’imposta alla fonte sul salario lordo mensile per il codice tariffario A0 (persona sola senza figli), dalle tariffe ufficiali del cantone.',
    wage: (amount, code) => `Salario mensile di ${amount} (${code})`,
    burdenFact: (amount) => `Onere fiscale su ${amount} lordi`,
    withholdingFact: (amount) => `Imposta alla fonte su ${amount} al mese`,
    note: (town, year) => `${town}, ${year}`,
    tariffNote: (code, year) => `tariffa ${code}, ${year}`,
    cantonalSource: 'Autorità fiscale cantonale',
  },
  en: {
    burdenTitle: (year) => `Tax burden ${year}`,
    burdenDescription: 'Cantonal, municipal and federal income tax as a share of gross annual income, for a single person without children living in the cantonal capital.',
    income: (amount, town) => `Gross income of ${amount} (${town})`,
    withholdingTitle: (year) => `Withholding tax ${year}`,
    withholdingDescription: 'Withholding tax rate on the gross monthly wage for tariff code A0 (single person without children), from the canton’s official tariffs.',
    wage: (amount, code) => `Monthly wage of ${amount} (${code})`,
    burdenFact: (amount) => `Tax burden on ${amount} gross`,
    withholdingFact: (amount) => `Withholding tax on ${amount} a month`,
    note: (town, year) => `${town}, ${year}`,
    tariffNote: (code, year) => `tariff ${code}, ${year}`,
    cantonalSource: 'Cantonal tax authority',
  },
  de: {
    burdenTitle: (year) => `Steuerbelastung ${year}`,
    burdenDescription: 'Kantons-, Gemeinde- und Bundessteuern auf dem Einkommen in Prozent des Bruttojahreseinkommens für eine alleinstehende Person ohne Kinder mit Wohnsitz im Kantonshauptort.',
    income: (amount, town) => `Bruttoeinkommen von ${amount} (${town})`,
    withholdingTitle: (year) => `Quellensteuer ${year}`,
    withholdingDescription: 'Quellensteuersatz auf dem Bruttomonatslohn für den Tarifcode A0 (alleinstehend, ohne Kinder) gemäss den offiziellen Tarifen des Kantons.',
    wage: (amount, code) => `Monatslohn von ${amount} (${code})`,
    burdenFact: (amount) => `Steuerbelastung bei ${amount} brutto`,
    withholdingFact: (amount) => `Quellensteuer bei ${amount} pro Monat`,
    note: (town, year) => `${town}, ${year}`,
    tariffNote: (code, year) => `Tarif ${code}, ${year}`,
    cantonalSource: 'Kantonale Steuerbehörde',
  },
  fr: {
    burdenTitle: (year) => `Charge fiscale ${year}`,
    burdenDescription: 'Impôts cantonaux, communaux et fédéraux sur le revenu en pourcentage du revenu brut annuel, pour une personne seule sans enfant domiciliée au chef-lieu.',
    income: (amount, town) => `Revenu brut de ${amount} (${town})`,
    withholdingTitle: (year) => `Impôt à la source ${year}`,
    withholdingDescription: 'Taux de l’impôt à la source sur le salaire brut mensuel pour le code tarifaire A0 (personne seule sans enfant), d’après les barèmes officiels du canton.',
    wage: (amount, code) => `Salaire mensuel de ${amount} (${code})`,
    burdenFact: (amount) => `Charge fiscale sur ${amount} bruts`,
    withholdingFact: (amount) => `Impôt à la source sur ${amount} par mois`,
    note: (town, year) => `${town}, ${year}`,
    tariffNote: (code, year) => `barème ${code}, ${year}`,
    cantonalSource: 'Autorité fiscale cantonale',
  },
};

function usable(id, dataset, nowMs) {
  if (dataset == null) return omitted(id, 'missing', 'canton-tax.json non in cache');
  if (!isObj(dataset) || dataset.schemaVersion !== 1 || !Number.isInteger(dataset.year) || !isObj(dataset.cantons)) {
    return omitted(id, 'invalid', 'canton-tax.json: forma non riconosciuta');
  }
  const calendarYear = new Date(nowMs).getUTCFullYear();
  if (dataset.year < calendarYear - BLOCK_THRESHOLDS.tax.maxYearLag) return omitted(id, 'stale', `canton-tax ${dataset.year} troppo vecchio per il ${calendarYear}`);
  // Anno in corso o precedente, come dice la soglia: un dataset dell'anno
  // prossimo non si pubblica come attuale prima che l'anno cominci.
  if (dataset.year > calendarYear) return omitted(id, 'invalid', `canton-tax ${dataset.year} oltre l'anno in corso (${calendarYear})`);
  return null;
}

const pctRow = (row, length) => Array.isArray(row) && row.length === length && row.every((v) => finite(v) != null && v >= 0 && v < 50);
/** Indice della fascia da mettere fra i fatti chiave: quella centrale. */
const middle = (list) => Math.floor((list.length - 1) / 2);

/** Onere fiscale per fascia di reddito, un gruppo di righe per membro del gruppo URL. */
export function shapeTaxBurdenBlock(dataset, { canton, members, nowMs }) {
  const id = TAX_BLOCK_IDS.burden;
  const bad = usable(id, dataset, nowMs);
  if (bad) return bad;
  const brackets = dataset.burden?.incomeBracketsCHF;
  if (!Array.isArray(brackets) || brackets.length < 2 || brackets.some((v) => finite(v) == null)) return omitted(id, 'invalid', 'canton-tax.json: fasce di reddito illeggibili');
  const year = dataset.year;
  const parts = members
    .map((code) => ({ code, town: dataset.cantons[code]?.capital?.municipality, row: dataset.cantons[code]?.burdenPct?.[String(year)] }))
    .filter((p) => typeof p.town === 'string' && p.town && pctRow(p.row, brackets.length) && p.row[p.row.length - 1] >= 5);
  if (!parts.length) return omitted(id, 'empty', `nessun onere fiscale ${year} leggibile per ${canton}`);
  const sourceUrl = httpsUrlOrNull((dataset.sources ?? []).find((s) => s?.id === 'estv-tax-burden')?.url);
  const k = middle(brackets);
  return {
    id,
    available: true,
    updatedAt: dataset.generatedAt,
    render(locale) {
      const t = TXT[locale];
      return {
        title: t.burdenTitle(year),
        description: t.burdenDescription,
        items: parts.flatMap((p) => brackets.map((income, i) => ({ label: t.income(fmtChf(income, locale), p.town), value: fmtPct(p.row[i], locale) }))),
        sourceName: ESTV[locale],
        ...(sourceUrl ? { sourceUrl } : {}),
        keyFacts: [{ label: t.burdenFact(fmtChf(brackets[k], locale)), value: fmtPct(parts[0].row[k], locale), note: t.note(parts[0].town, year), sourceName: ESTV[locale] }],
      };
    },
  };
}

/** Imposta alla fonte, tariffa A0, per salario mensile. */
export function shapeWithholdingBlock(dataset, { canton, members, nowMs }) {
  const id = TAX_BLOCK_IDS.withholding;
  const bad = usable(id, dataset, nowMs);
  if (bad) return bad;
  const wages = dataset.withholding?.monthlyIncomesCHF;
  if (!Array.isArray(wages) || wages.length < 2 || wages.some((v) => finite(v) == null)) return omitted(id, 'invalid', 'canton-tax.json: salari di riferimento illeggibili');
  const year = dataset.year;
  const parts = members
    .map((code) => ({ code, row: dataset.cantons[code]?.withholding?.ratesPct?.A0, url: httpsUrlOrNull(dataset.cantons[code]?.withholdingSource) }))
    .filter((p) => pctRow(p.row, wages.length));
  if (!parts.length) return omitted(id, 'empty', `nessuna tariffa A0 ${year} leggibile per ${canton}`);
  const k = middle(wages);
  const multi = parts.length > 1;
  return {
    id,
    available: true,
    updatedAt: dataset.generatedAt,
    render(locale) {
      const t = TXT[locale];
      return {
        title: t.withholdingTitle(year),
        description: t.withholdingDescription,
        items: parts.flatMap((p) => wages.map((wage, i) => ({ label: t.wage(fmtChf(wage, locale), multi ? `${p.code}, A0` : 'A0'), value: fmtPct(p.row[i], locale) }))),
        sourceName: t.cantonalSource,
        ...(parts[0].url ? { sourceUrl: parts[0].url } : {}),
        keyFacts: [{ label: t.withholdingFact(fmtChf(wages[k], locale)), value: fmtPct(parts[0].row[k], locale), note: t.tariffNote(multi ? `A0 ${parts[0].code}` : 'A0', year), sourceName: t.cantonalSource }],
      };
    },
  };
}
