/**
 * blocks-events.mjs — blocco «prossimi eventi» dell'hub eventi, dal dataset
 * nazionale `events.json` (contratto REWIRE `events-dataset`, cache scritta da
 * `refresh-events-dataset.mjs`). Il dataset porta il cantone BFS di ogni
 * evento: qui si filtra per i membri del gruppo URL, senza ricrawlare (D11).
 */
import { eventsBasePathForCanton } from '../events-utils.mjs';
import { clip, fmtDay, fmtNumber, httpsUrlOrNull, isoDayOf } from './format.mjs';
import { BLOCK_THRESHOLDS, DAY_MS, freshnessProblem, inGroup, isObj, isRealDay, omitted } from './blocks-common.mjs';
import { foldForMatch } from '../canton-section-profile.mjs';

export const EVENTS_BLOCK_ID = 'prossimi-eventi';

const TXT = {
  it: {
    title: (days) => `Eventi dei prossimi ${days} giorni`,
    description: 'Appuntamenti in calendario sul territorio, dall’agenda eventi del sito, in ordine di data.',
    source: 'Agenda eventi di Frontaliere Ticino',
    fact: (days) => `Eventi in calendario nei prossimi ${days} giorni`,
    note: 'dall’agenda eventi del sito',
    ongoing: (day) => `in corso, ultimo giorno: ${day}`,
  },
  en: {
    title: (days) => `Events in the next ${days} days`,
    description: 'Upcoming events in the area, from the site’s events calendar, in date order.',
    source: 'Frontaliere Ticino events calendar',
    fact: (days) => `Events scheduled in the next ${days} days`,
    note: 'from the site’s events calendar',
    ongoing: (day) => `ongoing, last day: ${day}`,
  },
  de: {
    title: (days) => `Veranstaltungen der nächsten ${days} Tage`,
    description: 'Anstehende Termine im Gebiet aus dem Veranstaltungskalender der Website, nach Datum geordnet.',
    source: 'Veranstaltungskalender von Frontaliere Ticino',
    fact: (days) => `Veranstaltungen in den nächsten ${days} Tagen`,
    note: 'aus dem Veranstaltungskalender der Website',
    ongoing: (day) => `läuft, letzter Tag: ${day}`,
  },
  fr: {
    title: (days) => `Événements des ${days} prochains jours`,
    description: 'Rendez-vous à venir sur le territoire, tirés de l’agenda du site, par ordre de date.',
    source: 'Agenda des événements de Frontaliere Ticino',
    fact: (days) => `Événements prévus dans les ${days} prochains jours`,
    note: 'd’après l’agenda du site',
    ongoing: (day) => `en cours, dernier jour : ${day}`,
  },
};

/**
 * @param {any} dataset contenuto di `data/events.json`, o null
 * @param {{ canton: string, members: string[], nowMs: number }} ctx
 */
export function shapeEventsBlock(dataset, { canton, members, nowMs }) {
  const id = EVENTS_BLOCK_ID;
  const th = BLOCK_THRESHOLDS.events;
  if (dataset == null) return omitted(id, 'missing', 'events.json non in cache');
  if (!isObj(dataset) || !Array.isArray(dataset.events)) return omitted(id, 'invalid', 'events.json: forma non riconosciuta');
  const stale = freshnessProblem(dataset.generatedAt, nowMs, th.maxAgeMs, 'events.json');
  if (stale) return omitted(id, stale.code, stale.reason);

  const today = isoDayOf(nowMs);
  // Estremo ESCLUSO: `windowDays` giorni di calendario, oggi compreso.
  const until = isoDayOf(nowMs + th.windowDays * DAY_MS);
  const seen = new Set();
  const upcoming = dataset.events
    .filter((e) => isObj(e) && inGroup(members, e.canton))
    .filter((e) => typeof e.title === 'string' && e.title.trim() && isRealDay(e.startDate))
    // Intersezione con la finestra, non solo l'inizio: un evento di piu' giorni
    // cominciato ieri e ancora in corso e' un appuntamento di oggi. Senza
    // `endDate` l'evento dura il solo giorno d'inizio.
    .map((e) => ({ ...e, lastDay: isRealDay(e.endDate) && e.endDate >= e.startDate ? e.endDate : e.startDate }))
    .filter((e) => e.lastDay >= today && e.startDate < until)
    .filter((e) => e.startDate >= today || (Date.parse(e.lastDay) - Date.parse(e.startDate)) / DAY_MS <= th.maxSpanDays)
    // Ordinati per il primo giorno utile (oggi, per quelli gia' in corso).
    .map((e) => ({ ...e, firstUsefulDay: e.startDate < today ? today : e.startDate }))
    .sort((a, b) => a.firstUsefulDay.localeCompare(b.firstUsefulDay)
      || b.startDate.localeCompare(a.startDate)
      || String(a.startTime ?? '').localeCompare(String(b.startTime ?? ''))
      || a.title.localeCompare(b.title)
      || String(a.id ?? '').localeCompare(String(b.id ?? '')))
    // Lo stesso evento arriva da piu' agende: una riga per titolo e giorno.
    .filter((e) => {
      const key = `${e.firstUsefulDay}|${foldForMatch(e.title).replace(/[^a-z0-9]+/g, ' ').trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (upcoming.length < th.minRows) {
    return omitted(id, 'empty', `${upcoming.length} eventi nei prossimi ${th.windowDays} giorni per ${canton} (min ${th.minRows})`);
  }

  const rows = upcoming.slice(0, th.maxRows);
  const basePaths = eventsBasePathForCanton(canton);
  return {
    id,
    available: true,
    updatedAt: dataset.generatedAt,
    maxAgeMs: th.maxAgeMs,
    render(locale) {
      const t = TXT[locale];
      return {
        title: t.title(th.windowDays),
        description: t.description,
        items: rows.map((e) => {
          const place = [e.venue, e.comune].map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
          const url = httpsUrlOrNull(e.url);
          const where = place.length ? clip([...new Set(place)].join(', '), 100) : '';
          const ongoing = e.startDate < today ? t.ongoing(fmtDay(e.lastDay, locale)) : '';
          const detail = [where, ongoing].filter(Boolean).join(' — ');
          return {
            label: clip(e.titleByLocale?.[locale] || e.title, 120),
            ...(detail ? { detail } : {}),
            date: e.firstUsefulDay,
            ...(url ? { url } : {}),
          };
        }),
        sourceName: t.source,
        sourceUrl: `${basePaths[locale]}/`,
        keyFacts: [{ label: t.fact(th.windowDays), value: fmtNumber(upcoming.length, locale), note: t.note }],
      };
    },
  };
}
