/**
 * blocks-border-wait.mjs — blocco «attese ai valichi» dell'hub mobilita',
 * dalla finestra settimanale `border-wait-ranking-window.json` (contratto
 * REWIRE `border-wait-window`, cache scritta da `refresh-border-wait-window.mjs`).
 * Esiste solo per i cantoni che hanno valichi nella finestra: per gli altri
 * il blocco e' `not-applicable`, non un guasto.
 */
import { rankingFromStats } from '../border-wait-ranking.mjs';
import { fmtDay, fmtNumber } from './format.mjs';
import { BLOCK_THRESHOLDS, DAY_MS, HOUR_MS, isObj, omitted } from './blocks-common.mjs';

export const BORDER_WAIT_BLOCK_ID = 'attese-valichi';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pagina «oggi» di un valico sul sito, per locale (pattern di `sitemap-border-wait.xml`). */
export const BORDER_WAIT_SECTION = Object.freeze({
  it: { base: '/traffico-dogane', today: 'oggi' },
  en: { base: '/en/border-wait', today: 'today' },
  de: { base: '/de/wartezeit-grenze', today: 'heute' },
  fr: { base: '/fr/temps-attente-douane', today: 'aujourd-hui' },
});

const TXT = {
  it: {
    title: 'Attese ai valichi',
    description: (from, to) => `Tempo medio di attesa ai valichi del cantone nella settimana ${from} – ${to}, dal più scorrevole al più lento.`,
    minutes: (n) => `${n} min`,
    detail: (n) => `${n} rilevazioni`,
    source: 'Monitoraggio dei valichi di Frontaliere Ticino',
    fact: 'Valico più scorrevole della settimana',
    note: (name, to) => `${name}, settimana conclusa: ${to}`,
  },
  en: {
    title: 'Border crossing waits',
    description: (from, to) => `Average waiting time at the canton’s border crossings in the week from ${from} to ${to}, fastest first.`,
    minutes: (n) => `${n} min`,
    detail: (n) => `${n} readings`,
    source: 'Frontaliere Ticino border-crossing monitoring',
    fact: 'Fastest crossing of the week',
    note: (name, to) => `${name}, week ending ${to}`,
  },
  de: {
    title: 'Wartezeiten an den Grenzübergängen',
    description: (from, to) => `Durchschnittliche Wartezeit an den Grenzübergängen des Kantons in der Woche vom ${from} bis ${to}, vom schnellsten zum langsamsten.`,
    minutes: (n) => `${n} Min.`,
    detail: (n) => `${n} Messungen`,
    source: 'Grenzübergangs-Monitoring von Frontaliere Ticino',
    fact: 'Schnellster Grenzübergang der Woche',
    note: (name, to) => `${name}, Woche bis ${to}`,
  },
  fr: {
    title: 'Attente aux postes-frontières',
    description: (from, to) => `Temps d’attente moyen aux postes-frontières du canton pendant la semaine du ${from} au ${to}, du plus fluide au plus lent.`,
    minutes: (n) => `${n} min`,
    detail: (n) => `${n} relevés`,
    source: 'Suivi des postes-frontières de Frontaliere Ticino',
    fact: 'Poste-frontière le plus fluide de la semaine',
    note: (name, to) => `${name}, semaine jusqu’au ${to}`,
  },
};

const PARTICLES = new Set(['di', 'del', 'della', 'dello', 'dei', 'de', 'des', 'du', 'la', 'le', 'les', 'd', 'e', 'am', 'an', 'im', 'bei', 'en', 'sur']);

/** Nome leggibile da uno slug, quando il registro dei valichi non lo conosce. */
export function crossingNameFromSlug(slug) {
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((w, i) => (i > 0 && PARTICLES.has(w) ? w : w.length <= 2 && i > 0 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * @param {any} window contenuto di `border-wait-ranking-window.json`, o null
 * @param {{ canton: string, nowMs: number, crossingNames?: Map<string, string> }} ctx
 */
export function shapeBorderWaitBlock(window, { canton, nowMs, crossingNames = new Map() }) {
  const id = BORDER_WAIT_BLOCK_ID;
  const th = BLOCK_THRESHOLDS.borderWait;
  if (window == null) return omitted(id, 'missing', 'border-wait-ranking-window.json non in cache');
  const current = window?.current;
  if (!isObj(current) || !isObj(current.perCrossing) || !DAY_RE.test(String(current.weekEnd)) || !DAY_RE.test(String(current.weekStart))) {
    return omitted(id, 'invalid', 'border-wait-ranking-window.json: forma non riconosciuta');
  }
  const mine = Object.fromEntries(Object.entries(current.perCrossing).filter(([, s]) => isObj(s) && s.canton === canton));
  if (Object.keys(mine).length === 0) {
    // Una finestra pubblicata prima che il sito aggiungesse `canton` (P9c) non
    // dice di chi e' un valico: non e' «questo cantone non ha valichi».
    const tagged = Object.values(current.perCrossing).some((s) => isObj(s) && typeof s.canton === 'string');
    return tagged
      ? omitted(id, 'not-applicable', `nessun valico di ${canton} nella finestra`)
      : omitted(id, 'invalid', 'finestra valichi senza il campo canton (pubblicata prima di P9c)');
  }

  const windowEndMs = Date.parse(`${current.weekEnd}T23:59:59Z`);
  const age = nowMs - windowEndMs;
  if (age > th.maxAgeMs) {
    return omitted(id, 'stale', `finestra valichi chiusa il ${current.weekEnd}, ${Math.round(age / HOUR_MS)} h fa (max ${th.maxAgeMs / DAY_MS} giorni)`);
  }
  if (age < -2 * DAY_MS) return omitted(id, 'invalid', `finestra valichi che finisce nel futuro (${current.weekEnd})`);

  const ranking = rankingFromStats(mine).filter((r) => Number.isFinite(r.avgMinutes) && r.avgMinutes >= 0);
  if (ranking.length < th.minRows) {
    return omitted(id, 'empty', `${ranking.length} valichi di ${canton} con abbastanza rilevazioni (min ${th.minRows})`);
  }
  const rows = ranking.slice(0, th.maxRows);
  const nameOf = (slug) => crossingNames.get(slug) || crossingNameFromSlug(slug);
  const minutes = (v, locale) => fmtNumber(Math.round(v * 10) / 10, locale, Number.isInteger(Math.round(v * 10) / 10) ? 0 : 1);
  return {
    id,
    available: true,
    updatedAt: new Date(windowEndMs).toISOString(),
    maxAgeMs: th.maxAgeMs,
    render(locale) {
      const t = TXT[locale];
      const section = BORDER_WAIT_SECTION[locale];
      return {
        title: t.title,
        description: t.description(fmtDay(current.weekStart, locale), fmtDay(current.weekEnd, locale)),
        items: rows.map((r) => ({
          label: nameOf(r.slug),
          value: t.minutes(minutes(r.avgMinutes, locale)),
          detail: t.detail(fmtNumber(r.totalSamples, locale)),
          url: `${section.base}/${r.slug}/${section.today}/`,
        })),
        sourceName: t.source,
        sourceUrl: `${section.base}/`,
        keyFacts: [{
          label: t.fact,
          value: t.minutes(minutes(rows[0].avgMinutes, locale)),
          note: t.note(nameOf(rows[0].slug), fmtDay(current.weekEnd, locale)),
        }],
      };
    },
  };
}

/**
 * `slug → nome` dal registro dei valichi (`generator/data/borderCrossings.ts`),
 * letto come testo: e' TypeScript e questo modulo gira sotto `node` puro. Un
 * valico il cui slug pubblicato non coincide con lo slug del nome resta senza
 * voce e prende il nome derivato dallo slug.
 */
export function parseCrossingNames(source) {
  const out = new Map();
  const rx = /\bname:\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = rx.exec(String(source ?? ''))) !== null) {
    const name = m[2].replace(/\\(['"])/g, '$1');
    const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug && !out.has(slug)) out.set(slug, name);
  }
  return out;
}
