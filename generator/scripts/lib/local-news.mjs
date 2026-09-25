/**
 * local-news.mjs — the local news the frontaliere section publishes even
 * without a frontaliere angle.
 *
 * Owner decisions of 2026-09-25, in order:
 *  1. «strade chiuse fra cargo e bilancio cantonale sono notizie che
 *     potrebbero essere utili» — commute, jobs in Ticino and the cantonal
 *     budget became a real link (PR #1848, TOPICAL_KEYWORDS and REGOLA #0);
 *  2. «Fai passare anche queste notizie: cronaca nera, sport, cultura e
 *     incidenti stradali» — this module.
 *
 * Local means Ticino and the Italian provinces of Varese, Como and VCO, and
 * that is decided HERE, deterministically. The scan's anchor gate
 * (domainAnchor.mjs) is not enough: it also accepts Zurich, Bern, Basel and
 * every border comune of Sondrio, Lecco or Aosta. The model judges
 * (pre-spend classifier, REGOLA #0, fact-check point 11) say the same area in
 * words, but the classifier fails open when its model is out of quota.
 *
 * Kind: substring stems, like TOPICAL_KEYWORDS in create-article.mjs, chosen
 * so a stem does not fire inside a common unrelated word: no bare 'sport' (it
 * is inside "trasporti"), no 'mostra' (the verb), no 'processo', no 'indagin'
 * (an "indagine" is also a survey).
 */
import { normalizeText } from './profession-taxonomy.mjs';
import { comuniMentioned, municipalityProvince } from './topic-coverage-guard.mjs';

export const LOCAL_NEWS_KEYWORDS = Object.freeze([
  // cronaca nera
  'arrest', 'rapin', 'furto', 'furti', 'omicid', 'accoltell', 'aggredit', 'aggression',
  'spaccio', 'truff', 'polizia', 'carabinier', 'incendi', 'scompars', 'condannat',
  // incidenti stradali
  'incidente', 'incidenti', 'investit', 'schiant', 'tamponament', 'ribaltat',
  // sport
  'calcio', 'hockey', 'campionat', 'derby', 'allenator', 'sportiv', 'tennis',
  'ciclism', 'maratona', 'torneo', 'fc lugano', 'hc lugano', 'ambrì',
  // cultura ed eventi
  'festival', 'sagra', 'mercatin', 'fiera', 'manifestazion', 'spettacol', 'rassegna',
  'concert', 'museo', 'teatro', 'cinema', 'esposizion', 'carnevale', 'cultura', 'cultural',
]);

/** Italian provinces of the area (sigle in generator/data/municipalities.ts). */
export const LOCAL_NEWS_PROVINCES = Object.freeze(['VA', 'CO', 'VB']);
const LOCAL_PROVINCE_SET = new Set(LOCAL_NEWS_PROVINCES);

/**
 * Ticino and the names of the Italian side as a whole, on normalizeText()
 * output (lowercase, no accents, punctuation to spaces). The Italian border
 * comuni come from the municipality index instead, filtered by province.
 *
 * There is no list of Ticino comuni in this repo, so the Ticino side is the
 * canton, its regions and its towns that are not also common Italian words:
 * no "paradiso", "tenero", "agno", "pura", "quinto", "vira" (all Ticino
 * comuni, all ordinary words), no "breno" or "iseo" (also places outside the
 * area).
 */
const LOCAL_AREA_RE = new RegExp(`\\b(?:${[
  'ticin[a-z]*', 'cantone? ticino',
  'luganes[ei]', 'mendrisiott[oa]', 'locarnes[ei]', 'bellinzones[ei]',
  'leventina', 'blenio', 'vallemaggia', 'valle maggia', 'malcantone', 'gambarogno',
  'verzasca', 'centovalli', 'onsernone', 'capriasca', 'riviera ticinese', 'tre valli',
  'lugano', 'chiasso', 'mendrisio', 'locarno', 'bellinzona', 'biasca', 'airolo',
  'ascona', 'stabio', 'balerna', 'massagno', 'losone', 'minusio', 'giubiasco',
  'muralto', 'brissago', 'caslano', 'melide', 'morcote', 'riva san vitale',
  'coldrerio', 'novazzano', 'vacallo', 'morbio', 'capolago', 'bissone', 'arbedo',
  'sementina', 'gordola', 'cadenazzo', 'faido', 'olivone', 'cevio', 'bioggio',
  'lamone', 'canobbio', 'porza', 'savosa', 'sorengo', 'collina d oro', 'montagnola',
  'pregassona', 'viganello', 'breganzona', 'cugnasco', 'monte ceneri', 'mezzovico',
  'magadino', 'giornico', 'bodio', 'acquarossa', 'castel san pietro', 'rancate',
  'ponte tresa', 'tesserete', 'cadempino', 'comano', 'gentilino', 'magliaso',
  'cornaredo', 'gottardo', 'san bernardino', 'brogeda', 'gaggiolo',
  // the Italian side as a whole
  'varese', 'varesott[oa]', 'como', 'comasc[oa]', 'verbania', 'verbano', 'vco',
  'ossola', 'ossolan[oa]', 'domodossola', 'lago maggiore', 'lario', 'ceresio',
].join('|')})\\b`);

/**
 * Is the text about a place in Ticino or in the provinces of Varese, Como
 * and VCO?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isInLocalNewsArea(text) {
  if (!text || typeof text !== 'string') return false;
  if (LOCAL_AREA_RE.test(normalizeText(text))) return true;
  return comuniMentioned(text).some((slug) => LOCAL_PROVINCE_SET.has(municipalityProvince(slug)));
}

/**
 * Does the text read like cronaca, a road accident, sport or culture? Kind
 * only: pair it with isInLocalNewsArea, or use isLocalNews.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasLocalNewsSignal(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return LOCAL_NEWS_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * Local news the frontaliere section admits: the kind AND the place.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isLocalNews(text) {
  return hasLocalNewsSignal(text) && isInLocalNewsArea(text);
}

/**
 * How many local-news stems the text carries, or 0 when it is not in the
 * area — the same count the admission lexicon adds to its own.
 *
 * @param {string} text
 * @returns {number}
 */
export function countLocalNewsHits(text) {
  if (!text || typeof text !== 'string' || !isInLocalNewsArea(text)) return 0;
  const lower = text.toLowerCase();
  return LOCAL_NEWS_KEYWORDS.reduce((acc, k) => acc + (lower.split(k).length - 1), 0);
}
