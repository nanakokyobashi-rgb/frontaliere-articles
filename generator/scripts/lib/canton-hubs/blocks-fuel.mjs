/**
 * blocks-fuel.mjs — blocco «prezzi dei carburanti» dell'hub carburanti, dal
 * dataset `fuel-prices-cantons.json` (contratto REWIRE `fuel-cantons`, cache
 * scritta da `refresh-fuel-cantons.mjs`). Nessun ricalcolo: le cifre sono
 * quelle del dataset, formattate (D11).
 */
import { fmtDay, fmtNumber, fmtPerLitre } from './format.mjs';
import { BLOCK_THRESHOLDS, finite, freshnessProblem, isObj, omitted } from './blocks-common.mjs';

export const FUEL_BLOCK_ID = 'prezzi-carburanti';

const SIDE_ORDER = ['CH', 'IT', 'FR', 'DE', 'AT'];
const FUEL_ORDER = ['sp95', 'diesel'];
const GRANULARITIES = ['station', 'region', 'national'];

// The producer adds `granularity` in the companion site PR. Keep an already
// published legacy cache readable during the HTTP hand-off: an absent field
// was necessarily a regional aggregate in schema 1. Unknown explicit values
// remain invalid and are filtered below.
const granularityOf = (record) => Object.hasOwn(record, 'granularity') ? record.granularity : 'region';

const TXT = {
  it: {
    title: 'Prezzi dei carburanti',
    description: 'Prezzi medi alla pompa rilevati sul territorio e, dove esiste un dato pubblico, nelle aree oltreconfine. Ogni riga riporta la valuta della rilevazione: i prezzi non sono convertiti.',
    fuel: { sp95: 'Benzina 95', diesel: 'Diesel' },
    side: { CH: 'Svizzera', IT: 'Italia', FR: 'Francia', DE: 'Germania', AT: 'Austria' },
    detail: (min, stations, granularity) => granularity === 'national'
      ? 'media nazionale ufficiale'
      : granularity === 'station' ? 'prezzo rilevato alla stazione' : `media regionale: minimo ${min}, ${stations} stazioni rilevate`,
    note: (day, granularity) => granularity === 'national'
      ? `media nazionale ufficiale, ${day}`
      : granularity === 'station' ? `prezzo rilevato alla stazione, ${day}` : `media regionale, ${day}`,
  },
  en: {
    title: 'Fuel prices',
    description: 'Average pump prices recorded locally and, where public data exists, across the border. Each row keeps the currency of the survey: prices are not converted.',
    fuel: { sp95: 'Petrol 95', diesel: 'Diesel' },
    side: { CH: 'Switzerland', IT: 'Italy', FR: 'France', DE: 'Germany', AT: 'Austria' },
    detail: (min, stations, granularity) => granularity === 'national'
      ? 'official national average'
      : granularity === 'station' ? 'price recorded at station' : `regional average: lowest ${min}, ${stations} stations surveyed`,
    note: (day, granularity) => granularity === 'national'
      ? `official national average, ${day}`
      : granularity === 'station' ? `price recorded at station, ${day}` : `regional average, ${day}`,
  },
  de: {
    title: 'Treibstoffpreise',
    description: 'Durchschnittliche Preise an der Zapfsäule im Gebiet und, wo öffentliche Daten vorliegen, jenseits der Grenze. Jede Zeile nennt die Währung der Erhebung: Die Preise werden nicht umgerechnet.',
    fuel: { sp95: 'Benzin 95', diesel: 'Diesel' },
    side: { CH: 'Schweiz', IT: 'Italien', FR: 'Frankreich', DE: 'Deutschland', AT: 'Österreich' },
    detail: (min, stations, granularity) => granularity === 'national'
      ? 'offizieller nationaler Durchschnitt'
      : granularity === 'station' ? 'an der Tankstelle erhobener Preis' : `regionaler Durchschnitt: tiefster Preis ${min}, ${stations} erfasste Tankstellen`,
    note: (day, granularity) => granularity === 'national'
      ? `offizieller nationaler Durchschnitt, ${day}`
      : granularity === 'station' ? `an der Tankstelle erhobener Preis, ${day}` : `regionaler Durchschnitt, ${day}`,
  },
  fr: {
    title: 'Prix des carburants',
    description: 'Prix moyens à la pompe relevés sur le territoire et, lorsqu’une donnée publique existe, de l’autre côté de la frontière. Chaque ligne conserve la monnaie du relevé : les prix ne sont pas convertis.',
    fuel: { sp95: 'Essence 95', diesel: 'Diesel' },
    side: { CH: 'Suisse', IT: 'Italie', FR: 'France', DE: 'Allemagne', AT: 'Autriche' },
    detail: (min, stations, granularity) => granularity === 'national'
      ? 'moyenne nationale officielle'
      : granularity === 'station' ? 'prix relevé à la station' : `moyenne régionale : prix le plus bas ${min}, ${stations} stations relevées`,
    note: (day, granularity) => granularity === 'national'
      ? `moyenne nationale officielle, ${day}`
      : granularity === 'station' ? `prix relevé à la station, ${day}` : `moyenne régionale, ${day}`,
  },
};

/**
 * @param {any} dataset contenuto di `fuel-prices-cantons.json`, o null se la cache manca
 * @param {{ canton: string, nowMs: number }} ctx `canton` e' il codice del gruppo URL
 */
export function shapeFuelBlock(dataset, { canton, nowMs }) {
  const id = FUEL_BLOCK_ID;
  const th = BLOCK_THRESHOLDS.fuel;
  if (dataset == null) return omitted(id, 'missing', 'fuel-prices-cantons.json non in cache');
  if (!isObj(dataset) || dataset.schemaVersion !== 1 || !Array.isArray(dataset.records)) {
    return omitted(id, 'invalid', 'fuel-prices-cantons.json: forma non riconosciuta');
  }
  const stale = freshnessProblem(dataset.generatedAt, nowMs, th.maxAgeMs, 'fuel-prices-cantons.json');
  if (stale) return omitted(id, stale.code, stale.reason);

  const rows = dataset.records
    .filter((r) => isObj(r) && r.canton === canton)
    .filter((r) => SIDE_ORDER.includes(r.side) && FUEL_ORDER.includes(r.fuel))
    .filter((r) => !Object.hasOwn(r, 'granularity') || GRANULARITIES.includes(r.granularity))
    .filter((r) => (r.currency === 'CHF' || r.currency === 'EUR') && (r.side === 'CH') === (r.currency === 'CHF'))
    .filter((r) => finite(r.avg) != null && finite(r.min) != null && r.min <= r.avg)
    .filter((r) => granularityOf(r) !== 'national' || (r.side === 'CH' && r.stations === 1))
    .filter((r) => Number.isInteger(r.stations) && r.stations >= (granularityOf(r) === 'national' ? 1 : th.minStations))
    // Ogni record ha la sua data di rilevazione: una riga ferma da piu' della
    // soglia non si mostra accanto a righe fresche.
    .filter((r) => !freshnessProblem(r.observedAt, nowMs, granularityOf(r) === 'national' ? th.nationalMaxAgeMs : th.maxAgeMs, 'record'))
    .sort((a, b) => SIDE_ORDER.indexOf(a.side) - SIDE_ORDER.indexOf(b.side) || FUEL_ORDER.indexOf(a.fuel) - FUEL_ORDER.indexOf(b.fuel));
  if (rows.length < th.minRows) {
    return omitted(id, 'empty', `nessun prezzo con almeno ${th.minStations} stazioni per ${canton}`);
  }

  const providers = [...new Set(rows.map((r) => String(r.source ?? '').trim()).filter(Boolean))];
  return {
    id,
    available: true,
    updatedAt: dataset.generatedAt,
    maxAgeMs: th.maxAgeMs,
    render(locale) {
      const t = TXT[locale];
      const label = (r) => `${t.fuel[r.fuel]} — ${t.side[r.side]}`;
      return {
        title: t.title,
        description: t.description,
        items: rows.map((r) => ({
          label: label(r),
          value: fmtPerLitre(r.avg, r.currency, locale),
          detail: t.detail(fmtPerLitre(r.min, r.currency, locale), fmtNumber(r.stations, locale), granularityOf(r)),
          date: r.observedAt,
        })),
        sourceName: providers.join('; '),
        // Al massimo due fatti: il lato svizzero se c'e', altrimenti le prime righe.
        keyFacts: (rows.some((r) => r.side === 'CH') ? rows.filter((r) => r.side === 'CH') : rows).slice(0, 2).map((r) => ({
          label: label(r),
          value: fmtPerLitre(r.avg, r.currency, locale),
          note: t.note(fmtDay(r.observedAt, locale), granularityOf(r)),
          sourceName: String(r.source).trim(),
        })),
      };
    },
  };
}
