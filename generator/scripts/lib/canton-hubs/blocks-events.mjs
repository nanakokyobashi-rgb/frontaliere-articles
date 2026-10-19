/**
 * blocks-events.mjs — blocco «prossimi eventi» dell'hub eventi, dal dataset
 * nazionale `events.json` (contratto REWIRE `events-dataset`, cache scritta da
 * `refresh-events-dataset.mjs`). Il dataset porta il cantone BFS di ogni
 * evento: qui si filtra per i membri del gruppo URL, senza ricrawlare (D11).
 */
import { eventsBasePathForCanton } from '../events-utils.mjs';
import { clip, fmtDay, fmtNumber, httpsUrlOrNull, isoDayOf } from './format.mjs';
import { BLOCK_THRESHOLDS, DAY_MS, freshnessProblem, inGroup, isObj, isRealDay, omitted } from './blocks-common.mjs';
import { foldForMatch, sourceUrlCanonicalKey } from '../canton-section-profile.mjs';

export const EVENTS_BLOCK_ID = 'prossimi-eventi';
const EVENT_SOURCE_INDEX = Symbol('eventSourceIndex');

function foldedEventPart(value) {
  return foldForMatch(typeof value === 'string' ? value : '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** URL HTTPS evento senza userinfo, adatta all'identità o alla pubblicazione. */
function safeEventUrl(value) {
  const safeUrl = httpsUrlOrNull(value);
  if (!safeUrl) return '';
  try {
    const parsed = new URL(safeUrl);
    return parsed.username || parsed.password ? '' : safeUrl;
  } catch {
    return '';
  }
}

/** Canonicalizza le URL evento solo per l'identità e la deduplica. */
function canonicalEventUrl(value) {
  const safeUrl = safeEventUrl(value);
  if (!safeUrl) return '';
  const canonical = sourceUrlCanonicalKey(safeUrl);
  if (canonical) return canonical;
  try {
    const fallback = new URL(safeUrl);
    fallback.hash = '';
    return fallback.toString();
  } catch {
    return '';
  }
}

function eventUrlFragment(value) {
  const safeUrl = safeEventUrl(value);
  if (!safeUrl) return '';
  try {
    return new URL(safeUrl).hash;
  } catch {
    return '';
  }
}

function eventIdIdentity(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function eventSourceIndex(value) {
  const index = value?.[EVENT_SOURCE_INDEX];
  return Number.isInteger(index) && index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function compareEventSourceIndex(a, b) {
  return eventSourceIndex(a) - eventSourceIndex(b);
}

function compareUpcomingEvents(a, b) {
  return a.firstUsefulDay.localeCompare(b.firstUsefulDay)
    || b.startDate.localeCompare(a.startDate)
    || String(a.startTime ?? '').localeCompare(String(b.startTime ?? ''))
    || a.title.localeCompare(b.title)
    || String(a.id ?? '').localeCompare(String(b.id ?? ''))
    || compareEventSourceIndex(a, b);
}

function eventSemanticKey(event) {
  return JSON.stringify([event.firstUsefulDay, foldedEventPart(event.title)]);
}

function eventPlaceKey(event) {
  return foldedEventPart(event.comune) || foldedEventPart(event.venue);
}

function eventStartTime(event) {
  return String(event.startTime ?? '').trim();
}

function deduplicateEvents(events) {
  const parent = events.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return leftRoot;
    const root = Math.min(leftRoot, rightRoot);
    parent[Math.max(leftRoot, rightRoot)] = root;
    return root;
  };
  const directOwners = new Map();

  events.forEach((event, index) => {
    const semantic = eventSemanticKey(event);
    const url = canonicalEventUrl(event.url);
    const id = eventIdIdentity(event.id);
    const aliases = [url && ['url', url], id && ['id', id]].filter(Boolean);
    for (const [kind, value] of aliases) {
      const key = JSON.stringify([semantic, kind, value]);
      if (directOwners.has(key)) union(index, directOwners.get(key));
      else directOwners.set(key, index);
    }
  });

  const groups = new Map();
  events.forEach((event, index) => {
    const place = eventPlaceKey(event);
    if (!place) return;
    const key = JSON.stringify([eventSemanticKey(event), place]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });

  for (const indexes of groups.values()) {
    const roots = [...new Set(indexes.map(find))];
    const membersByRoot = new Map();
    for (const index of indexes) {
      const root = find(index);
      if (!membersByRoot.has(root)) membersByRoot.set(root, []);
      membersByRoot.get(root).push(index);
    }
    const anchored = roots.filter((root) => membersByRoot.get(root).some((index) =>
      canonicalEventUrl(events[index].url) || eventIdIdentity(events[index].id)));
    const fallback = roots.filter((root) => !anchored.includes(root));
    if (fallback.length === 0) continue;

    const unmatchedByTime = new Map();
    for (const root of fallback) {
      const fallbackMembers = membersByRoot.get(root) || [];
      const fallbackTimes = new Set(fallbackMembers.map((index) => eventStartTime(events[index])).filter(Boolean));
      const compatibleAnchors = anchored.filter((root) => {
        const anchorMembers = membersByRoot.get(root) || [];
        const anchorTimes = new Set(anchorMembers.map((index) => eventStartTime(events[index])).filter(Boolean));
        return [...fallbackTimes].some((time) => anchorTimes.has(time));
      });
      if (compatibleAnchors.length === 1) {
        union(root, compatibleAnchors[0]);
        continue;
      }
      if (compatibleAnchors.length > 1 || fallbackTimes.size !== 1) continue;
      const [time] = fallbackTimes;
      if (!unmatchedByTime.has(time)) unmatchedByTime.set(time, []);
      unmatchedByTime.get(time).push(root);
    }
    for (const unmatchedRoots of unmatchedByTime.values()) {
      for (const root of unmatchedRoots.slice(1)) union(unmatchedRoots[0], root);
    }
  }

  const firstIndexByRoot = new Map();
  const preferredIndexByRoot = new Map();
  const preference = (event) => canonicalEventUrl(event.url) ? 0
    : eventIdIdentity(event.id) ? 1
      : eventPlaceKey(event) ? 2 : 3;
  const shouldPrefer = (event, preferred) => {
    const eventPreference = preference(event);
    const preferredPreference = preference(preferred);
    if (eventPreference !== preferredPreference) return eventPreference < preferredPreference;

    // ID aliases can connect different canonical URLs for one event. Keep a
    // deep link from any URL in that identity group, with source order as the
    // deterministic tie-break when both have (or both lack) a fragment.
    const eventHasFragment = Boolean(eventUrlFragment(event.url));
    const preferredHasFragment = Boolean(eventUrlFragment(preferred.url));
    if (eventHasFragment !== preferredHasFragment) return eventHasFragment;
    return eventSourceIndex(event) < eventSourceIndex(preferred);
  };
  events.forEach((event, index) => {
    const root = find(index);
    if (!firstIndexByRoot.has(root)) {
      firstIndexByRoot.set(root, index);
      preferredIndexByRoot.set(root, index);
      return;
    }
    const preferred = preferredIndexByRoot.get(root);
    if (shouldPrefer(event, events[preferred])) {
      preferredIndexByRoot.set(root, index);
    }
  });
  return events.flatMap((_, index) => {
    const root = find(index);
    return firstIndexByRoot.get(root) === index ? [events[preferredIndexByRoot.get(root)]] : [];
  }).sort(compareUpcomingEvents);
}

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
  const upcomingCandidates = dataset.events
    .map((e, sourceIndex) => isObj(e) ? { ...e, [EVENT_SOURCE_INDEX]: sourceIndex } : e)
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
    .sort(compareUpcomingEvents);
  // URL and ID are independent aliases. Place is only a fallback, and may
  // attach an unidentified copy to a single compatible identity group.
  const upcoming = deduplicateEvents(upcomingCandidates);
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
          const url = safeEventUrl(e.url);
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
