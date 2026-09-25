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
 * The place is not decided here. The scan's anchor gate (domainAnchor.mjs)
 * already requires a Ticino / border / Swiss place before this lexicon is
 * consulted, and the three model judges (pre-spend classifier, REGOLA #0,
 * fact-check point 11) admit these categories only in Ticino and in the
 * provinces of Varese, Como and VCO. This list only says WHAT kind of news
 * it is.
 *
 * Substring stems, like TOPICAL_KEYWORDS in create-article.mjs. Chosen so a
 * stem does not fire inside a common unrelated word: no bare 'sport' (it is
 * inside "trasporti"), no 'mostra' (the verb), no 'processo', no 'indagin'
 * (an "indagine" is also a survey).
 */

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

/**
 * Does the text look like local news of one of these kinds?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasLocalNewsSignal(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return LOCAL_NEWS_KEYWORDS.some((k) => lower.includes(k));
}
