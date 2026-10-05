/**
 * The per-canton half of the border-wait ranking generator (P9c), kept free
 * of npm dependencies so `node --test` can load it without `npm ci` (the
 * Generator CI unit job has none, and generate-border-wait-ranking-article.mjs
 * imports create-article.mjs, which needs them).
 *
 * Holds the evergreen metadata of each canton's ranking, the canton filter
 * over the published window, the snapshot computation and the `--canton`
 * parser. The generator imports all of it; nothing here writes.
 */
import { rankingFromStats, trendFromStats, computeFunFacts, computeWeekWindow, computeMovers } from './border-wait-ranking.mjs';
import { BORDER_RANKING_CANTONS } from './border-wait-ranking-content.mjs';
import { isTicinoCrossing } from '../../build-plugins/borderWaitData.ts';

// Evergreen metadata — registered once, NEVER refreshed (no date/count inside).
export const STATIC_META = {
  category: 'novita',
  image: 'mendrisio.webp', // → /images/places/mendrisio.webp (exists in catalog, dogana/confine keywords)
  hasCalculator: false,
  author: { slug: 'redazione', name: 'Redazione Frontaliere Ticino' },
  seo: {
    title: 'Classifica delle dogane in Ticino: le migliori e le peggiori',
    description:
      "Ogni dogana ticinese classificata per tempo medio di attesa, con trend settimanale e quanti minuti si perdono (o guadagnano) scegliendo un valico piuttosto che un altro.",
    keywords:
      'dogane ticino, tempi attesa dogana, classifica dogane, traffico confine ticino, valico ticino, coda dogana',
    ogTitle: 'Classifica delle dogane in Ticino',
    ogDescription:
      "Le dogane ticinesi classificate per tempo di attesa: le più veloci, le più lente, e quanti minuti di vita si perdono a sceglierne una piuttosto che un'altra.",
    headline: 'Classifica delle dogane in Ticino: le migliori e le peggiori per tempo di attesa',
    breadcrumbName: 'Classifica dogane',
  },
};

/**
 * Photo of each canton's ranking, from the site's `/images/places/` catalog.
 * Only Ticino has one today (the catalog holds Ticino places only); a canton
 * missing here cannot be REGISTERED — the dry run still works — so the first
 * publication of a new canton (P11) has to choose its image consciously
 * instead of inheriting a Ticino photo.
 */
const RANKING_IMAGE = { TI: STATIC_META.image };

/**
 * Evergreen metadata of a canton's ranking. Ticino returns STATIC_META itself
 * (registered once in 2026, never rewritten); the others are derived from the
 * same place phrases the article body uses.
 */
export function staticMetaFor(canton = 'TI') {
  if (canton === 'TI') return STATIC_META;
  const profile = BORDER_RANKING_CANTONS[canton];
  if (!profile) throw new Error(`no border-wait ranking for canton ${canton}`);
  const it = profile.it;
  const name = it.of.replace(/^(del Canton|della regione di|del|dei|della|dell'|di)\s*/, '');
  return {
    ...STATIC_META,
    image: RANKING_IMAGE[canton] ?? null,
    seo: {
      title: `Classifica delle dogane ${it.in}: le migliori e le peggiori`,
      description:
        `Ogni dogana ${it.of} classificata per tempo medio di attesa, con trend settimanale e quanti minuti si perdono (o guadagnano) scegliendo un valico piuttosto che un altro.`,
      keywords: `dogane ${name.toLowerCase()}, tempi attesa dogana, classifica dogane, traffico confine ${name.toLowerCase()}, valichi ${name.toLowerCase()}, coda dogana`,
      ogTitle: `Classifica delle dogane ${it.in}`,
      ogDescription:
        `Le dogane ${it.of} classificate per tempo di attesa: le più veloci, le più lente, e quanti minuti di vita si perdono a sceglierne una piuttosto che un'altra.`,
      headline: `Classifica delle dogane ${it.in}: le migliori e le peggiori per tempo di attesa`,
      breadcrumbName: 'Classifica dogane',
    },
  };
}

/**
 * Crossings of one canton in the window. Ticino keeps its region-based test
 * only for legacy windows where `canton` is absent; once the field is present,
 * the published group is authoritative, including explicit `null` tombstones.
 * Every other canton uses the `canton` the site publishes for each crossing
 * (URL group code: BS/BL → BASILEA). A window published before that field
 * existed ranks nothing, and main() refuses the empty article.
 */
export function crossingInCanton(canton, slug, stats) {
  if (canton === 'TI') {
    const hasCanton = stats !== null && typeof stats === 'object' && Object.hasOwn(stats, 'canton');
    return hasCanton ? stats.canton === 'TI' : isTicinoCrossing(slug);
  }
  return stats?.canton === canton;
}

/**
 * Compute the current ranking/trend/fun-facts/week-window/movers snapshot for
 * todayIso, from the fetched aggregate window.
 */
export function computeCantonSnapshot(todayIso, windowPayload, canton = 'TI') {
  // This snapshot feeds ONE canton's evergreen ranking (default Ticino, whose
  // embedded live chart also reads it via buildRankingJson below).
  // rankingFromStats/trendFromStats are generic aggregation over ALL
  // registered crossings (141, every corridor), so scope to the canton here,
  // once, before funFacts/movers derive from it — otherwise another canton's
  // crossing could surface as this article's best/worst/biggest mover.
  const current = windowPayload.current.perCrossing;
  const inCanton = (slug) => crossingInCanton(canton, slug, current[slug]);
  const rankingAll = rankingFromStats(current);
  const ranking = rankingAll
    .filter((r) => inCanton(r.slug))
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
  const trendAll = trendFromStats(
    current,
    windowPayload.previous?.perCrossing ?? {},
  );
  const trend = Object.fromEntries(Object.entries(trendAll).filter(([slug]) => inCanton(slug)));
  const funFacts = computeFunFacts(ranking);
  const { weekStart, weekEnd } = computeWeekWindow(todayIso, 7);
  const movers = computeMovers(trend);
  return { ranking, trend, funFacts, weekStart, weekEnd, movers };
}

/** `--canton=XX` / BORDER_WAIT_CANTON, default TI; validated against the profiles. */
export function cantonFromArgs(argv = process.argv, env = process.env) {
  const arg = argv.find((a) => a.startsWith('--canton='))?.slice('--canton='.length);
  const canton = String(arg || env.BORDER_WAIT_CANTON || 'TI').trim().toUpperCase();
  if (!BORDER_RANKING_CANTONS[canton]) {
    throw new Error(
      `--canton=${canton}: no border-wait ranking for this canton (known: ${Object.keys(BORDER_RANKING_CANTONS).join(', ')})`,
    );
  }
  return canton;
}
