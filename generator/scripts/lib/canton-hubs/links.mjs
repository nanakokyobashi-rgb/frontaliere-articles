/**
 * links.mjs — strumenti e pagine di categoria del sito pertinenti a un hub
 * (cantone, tema, locale).
 *
 * Nessun URL inventato. Tre sole origini:
 *   1. `generator/data/canton-hub-links.json`: path letti dalle sitemap
 *      pubblicate (ricontrollabili con `verify-canton-hub-links.mjs`);
 *   2. i file slug del repo: `canton-url-slugs.json` via `events-utils.mjs`
 *      (pagine eventi per cantone, le stesse che linka il digest) e lo stesso
 *      file per le pagine lavoro `cerca-lavoro-<cantone>`;
 *   3. gli articoli evergreen del cantone (digest eventi, classifica dei
 *      valichi), linkati solo se il loro id e' davvero nel registro.
 *
 * Una pagina che in una lingua non esiste non viene linkata in quella lingua.
 */
import { EVENTS_DIGEST_SLUGS, eventsBasePathForCanton } from '../events-utils.mjs';
import { CANTON_DIGEST_ARTICLES, DIGEST_ARTICLE_ID } from '../events-digest-content.mjs';
import { BORDER_WAIT_SECTION } from './blocks-border-wait.mjs';
import { cantonPlace } from './copy.mjs';
import { articleUrl } from './articles.mjs';

export const MAX_HUB_LINKS = 10;

const TXT = {
  it: {
    eventsCanton: (place) => `Tutti gli eventi ${place}`,
    eventsWeekend: 'Eventi di questo fine settimana',
    eventsDigest: 'Guida agli eventi del weekend',
    borderRegion: (toward) => `Attese ai valichi verso ${toward}`,
    borderRanking: 'Classifica settimanale dei valichi',
    premiums: (member) => `Premi di cassa malati per regione${member}`,
    plates: (member) => `Aste delle targhe${member}`,
    jobs: (place) => `Offerte di lavoro ${place}`,
  },
  en: {
    eventsCanton: (place) => `All events ${place}`,
    eventsWeekend: 'Events this weekend',
    eventsDigest: 'Weekend events guide',
    borderRegion: (toward) => `Border waits towards ${toward}`,
    borderRanking: 'Weekly border crossing ranking',
    premiums: (member) => `Health insurance premiums by region${member}`,
    plates: (member) => `Number plate auctions${member}`,
    jobs: (place) => `Job offers ${place}`,
  },
  de: {
    eventsCanton: (place) => `Alle Veranstaltungen ${place}`,
    eventsWeekend: 'Veranstaltungen an diesem Wochenende',
    eventsDigest: 'Wochenend-Veranstaltungsführer',
    borderRegion: (toward) => `Wartezeiten an der Grenze Richtung ${toward}`,
    borderRanking: 'Wöchentliche Rangliste der Grenzübergänge',
    premiums: (member) => `Krankenkassenprämien nach Region${member}`,
    plates: (member) => `Kontrollschild-Auktionen${member}`,
    jobs: (place) => `Stellenangebote ${place}`,
  },
  fr: {
    eventsCanton: (place) => `Tous les événements ${place}`,
    eventsWeekend: 'Événements de ce week-end',
    eventsDigest: 'Guide des événements du week-end',
    borderRegion: (toward) => `Attente aux frontières vers ${toward}`,
    borderRanking: 'Classement hebdomadaire des postes-frontières',
    premiums: (member) => `Primes d’assurance-maladie par région${member}`,
    plates: (member) => `Enchères de plaques${member}`,
    jobs: (place) => `Offres d’emploi ${place}`,
  },
};

/**
 * Pagina lavoro del cantone, dallo stesso `canton-url-slugs.json` del router
 * del sito. `dePrefix` copre i cantoni con l'articolo in tedesco (im Aargau,
 * in der Waadt); il Ticino tiene lo slug storico `jobs-im-tessin`.
 */
export function jobsPagePath(canton, locale, cantonUrlSlugs) {
  const record = cantonUrlSlugs?.cantons?.[canton];
  if (!record) throw new Error(`canton-hubs: nessuno slug URL per il cantone ${canton}`);
  switch (locale) {
    case 'it': return `/cerca-lavoro-${record.it}/`;
    case 'en': return `/en/find-jobs-${record.en}/`;
    case 'de': return `/de/${canton === 'TI' ? 'jobs-im-' : record.dePrefix ?? 'jobs-in-'}${record.de}/`;
    case 'fr': return `/fr/trouver-emploi-${record.fr}/`;
    default: throw new Error(`canton-hubs: locale non supportata "${locale}"`);
  }
}

/** Id dell'articolo evergreen «digest eventi del weekend» del cantone. */
export function eventsDigestArticleId(canton) {
  return canton === 'TI' ? DIGEST_ARTICLE_ID : CANTON_DIGEST_ARTICLES[canton]?.id ?? null;
}

/** Id dell'articolo evergreen «classifica dei valichi» del cantone. */
export function borderRankingArticleId(canton, cantonUrlSlugs) {
  const slug = cantonUrlSlugs?.cantons?.[canton]?.it;
  return slug ? `classifica-dogane-${slug}` : null;
}

/**
 * @param {object} args
 * @param {string} args.canton codice del gruppo URL
 * @param {string} args.topic
 * @param {string} args.locale
 * @param {any} args.catalogue `canton-hub-links.json`
 * @param {any} args.cantonUrlSlugs `canton-url-slugs.json`
 * @param {Map<string, any>} [args.evergreenArticles] id → articolo della sezione frontaliere (solo quelli registrati)
 * @returns {Array<{ label: string, url: string, description?: string }>}
 */
export function buildHubLinks({ canton, topic, locale, catalogue, cantonUrlSlugs, evergreenArticles = new Map() }) {
  const t = TXT[locale];
  if (!t) throw new Error(`canton-hubs: locale non supportata "${locale}"`);
  const links = [];
  const push = (label, url, description) => {
    if (typeof url !== 'string' || !url) return;
    links.push({ label, url, ...(description ? { description } : {}) });
  };
  const place = cantonPlace(canton, locale);
  const memberTag = (list, member) => (list.length > 1 ? ` (${member})` : '');
  const evergreen = (id, label) => {
    const article = id ? evergreenArticles.get(id) : null;
    if (article) push(label, articleUrl(article, locale));
  };

  // Prima cio' che e' del cantone, poi gli strumenti generali del tema.
  if (topic === 'eventi') {
    const base = eventsBasePathForCanton(canton)[locale];
    push(t.eventsCanton(place), `${base}/`);
    push(t.eventsWeekend, `${base}/${EVENTS_DIGEST_SLUGS.weekend[locale]}/`);
    evergreen(eventsDigestArticleId(canton), t.eventsDigest);
  }
  if (topic === 'mobilita') {
    for (const region of catalogue.borderWaitRegions?.[canton] ?? []) {
      push(t.borderRegion(region.toward[locale]), `${BORDER_WAIT_SECTION[locale].base}/${region.slug}/`);
    }
    evergreen(borderRankingArticleId(canton, cantonUrlSlugs), t.borderRanking);
  }
  if (topic === 'servizi') {
    const premiums = catalogue.healthPremiums?.[canton] ?? [];
    for (const p of premiums) push(t.premiums(memberTag(premiums, p.member)), p.paths[locale]);
    const plates = catalogue.plateAuctions?.[canton] ?? [];
    for (const p of plates) push(t.plates(memberTag(plates, p.member)), p.paths[locale]);
    push(t.jobs(place), jobsPagePath(canton, locale, cantonUrlSlugs));
  }
  for (const entry of catalogue.static ?? []) {
    if (!entry.topics.includes(topic)) continue;
    if (Array.isArray(entry.cantons) && !entry.cantons.includes(canton)) continue;
    push(entry.label[locale], entry.paths[locale], entry.description?.[locale]);
  }

  const seen = new Set();
  return links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true))).slice(0, MAX_HUB_LINKS);
}
