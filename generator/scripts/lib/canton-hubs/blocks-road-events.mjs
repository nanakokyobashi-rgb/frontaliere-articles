/**
 * blocks-road-events.mjs — blocco «chiusure e cantieri» dell'hub mobilita',
 * dal dataset `road-events.json` (contratto REWIRE `road-events`, cache
 * scritta da `refresh-road-events.mjs`): chiusure, cantieri, disagi del
 * traffico e del trasporto pubblico per gruppo cantonale (ASTRA DATEX II e
 * feed cantonali). Solo eventi in corso o in partenza a breve.
 */
import { clip, fmtDay, fmtNumber, httpsUrlOrNull } from './format.mjs';
import { BLOCK_THRESHOLDS, DAY_MS, freshnessProblem, instantMs, isObj, omitted } from './blocks-common.mjs';

export const ROAD_EVENTS_BLOCK_ID = 'chiusure-cantieri';

/** Ordine di rilevanza per chi si sposta: prima cio' che chiude una strada. */
const TYPE_ORDER = ['chiusura', 'traffico', 'tp', 'cantiere'];

const TXT = {
  it: {
    title: 'Chiusure, cantieri e disagi',
    description: 'Limitazioni in corso o in partenza nei prossimi giorni sulle strade e sul trasporto pubblico del cantone.',
    type: { chiusura: 'Chiusura', traffico: 'Traffico', tp: 'Trasporto pubblico', cantiere: 'Cantiere' },
    until: (day) => `fine prevista: ${day}`,
    source: 'Ufficio federale delle strade (USTRA) e avvisi cantonali',
    closures: 'Chiusure stradali in corso o imminenti',
    works: 'Cantieri attivi o imminenti',
    note: (day) => `segnalazioni aggiornate: ${day}`,
  },
  en: {
    title: 'Closures, roadworks and disruptions',
    description: 'Restrictions in force or starting in the coming days on the canton’s roads and public transport.',
    type: { chiusura: 'Closure', traffico: 'Traffic', tp: 'Public transport', cantiere: 'Roadworks' },
    until: (day) => `until ${day}`,
    source: 'Federal Roads Office (FEDRO) and cantonal notices',
    closures: 'Road closures in force or imminent',
    works: 'Roadworks active or imminent',
    note: (day) => `reports as of ${day}`,
  },
  de: {
    title: 'Sperrungen, Baustellen und Störungen',
    description: 'Laufende oder in den nächsten Tagen beginnende Einschränkungen auf den Strassen und im öffentlichen Verkehr des Kantons.',
    type: { chiusura: 'Sperrung', traffico: 'Verkehr', tp: 'Öffentlicher Verkehr', cantiere: 'Baustelle' },
    until: (day) => `bis ${day}`,
    source: 'Bundesamt für Strassen (ASTRA) und kantonale Meldungen',
    closures: 'Laufende oder bevorstehende Strassensperrungen',
    works: 'Aktive oder bevorstehende Baustellen',
    note: (day) => `Meldungen vom ${day}`,
  },
  fr: {
    title: 'Fermetures, chantiers et perturbations',
    description: 'Restrictions en cours ou débutant dans les prochains jours sur les routes et les transports publics du canton.',
    type: { chiusura: 'Fermeture', traffico: 'Trafic', tp: 'Transports publics', cantiere: 'Chantier' },
    until: (day) => `jusqu’au ${day}`,
    source: 'Office fédéral des routes (OFROU) et avis cantonaux',
    closures: 'Fermetures de routes en cours ou imminentes',
    works: 'Chantiers actifs ou imminents',
    note: (day) => `signalements au ${day}`,
  },
};

/**
 * @param {any} dataset contenuto di `road-events.json`, o null
 * @param {{ canton: string, nowMs: number }} ctx
 */
export function shapeRoadEventsBlock(dataset, { canton, nowMs }) {
  const id = ROAD_EVENTS_BLOCK_ID;
  const th = BLOCK_THRESHOLDS.roadEvents;
  if (dataset == null) return omitted(id, 'missing', 'road-events.json non in cache');
  if (!isObj(dataset) || dataset.schemaVersion !== 1 || !Array.isArray(dataset.events)) {
    return omitted(id, 'invalid', 'road-events.json: forma non riconosciuta');
  }
  const stale = freshnessProblem(dataset.generatedAt, nowMs, th.maxAgeMs, 'road-events.json');
  if (stale) return omitted(id, stale.code, stale.reason);

  const horizon = nowMs + th.horizonDays * DAY_MS;
  const active = dataset.events
    .filter((e) => isObj(e) && e.canton === canton && TYPE_ORDER.includes(e.type))
    .filter((e) => typeof e.title === 'string' && e.title.trim())
    .map((e) => ({ e, from: e.validFrom == null ? NaN : instantMs(e.validFrom), to: e.validTo == null ? NaN : instantMs(e.validTo) }))
    // Finito: fuori. Senza fine dichiarata resta, ma solo se e' gia' cominciato
    // o comincia entro l'orizzonte; un evento senza alcuna data vale la data
    // di osservazione del producer.
    .filter(({ to }) => !Number.isFinite(to) || to >= nowMs)
    .map((x) => ({ ...x, start: Number.isFinite(x.from) ? x.from : instantMs(x.e.observedAt) }))
    .filter(({ start }) => Number.isFinite(start) && start <= horizon)
    .sort((a, b) => TYPE_ORDER.indexOf(a.e.type) - TYPE_ORDER.indexOf(b.e.type)
      || b.start - a.start
      || String(a.e.id).localeCompare(String(b.e.id)));
  if (active.length < th.minRows) return omitted(id, 'empty', `nessuna limitazione attiva per ${canton}`);

  const rows = active.slice(0, th.maxRows);
  const count = (type) => active.filter(({ e }) => e.type === type).length;
  const closures = count('chiusura');
  const works = count('cantiere');
  return {
    id,
    available: true,
    updatedAt: dataset.generatedAt,
    maxAgeMs: th.maxAgeMs,
    render(locale) {
      const t = TXT[locale];
      const note = t.note(fmtDay(dataset.generatedAt, locale));
      return {
        title: t.title,
        description: t.description,
        items: rows.map(({ e, start, to }) => {
          const url = httpsUrlOrNull(e.url);
          return {
            label: clip(e.titleByLocale?.[locale] || e.title, 200),
            value: t.type[e.type],
            ...(Number.isFinite(to) ? { detail: t.until(fmtDay(to, locale)) } : {}),
            date: new Date(start).toISOString(),
            ...(url ? { url } : {}),
          };
        }),
        sourceName: t.source,
        keyFacts: [
          ...(closures ? [{ label: t.closures, value: fmtNumber(closures, locale), note }] : []),
          ...(works ? [{ label: t.works, value: fmtNumber(works, locale), note }] : []),
        ],
      };
    },
  };
}
