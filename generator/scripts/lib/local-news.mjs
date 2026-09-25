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
 * Two questions, both answered deterministically here.
 *
 * WHERE — Ticino and the Italian provinces of Varese, Como and VCO, from
 * complete geographic sources, filtered by canton and province:
 *  - the 100 comuni and 62 localities of the canton Ticino in
 *    generator/data/ticino-municipalities.json (BFS snapshot, copied from the
 *    site's data/canton-municipalities.json);
 *  - the Italian border comuni of generator/data/municipalities.ts, through
 *    the municipality index of topic-coverage-guard.mjs, kept only when their
 *    province is VA, CO or VB;
 *  - the canton and the regions by name (Ticino, Luganese, Mendrisiotto, …).
 * The scan's anchor gate (domainAnchor.mjs) is not enough: it also accepts
 * Zurich, Bern and every border comune of Sondrio, Lecco or Aosta. Names that
 * span the border of the area are not used: Lago Maggiore (also Novara), Lario
 * (also Lecco), Gottardo (also Uri), San Bernardino (Graubünden).
 *
 * WHAT — cronaca nera, road accidents, sport, culture and events, matched as
 * word-start stems on normalizeText() output, so a stem never fires inside
 * another word ("sportello", "trasporti", "concertazione"). Stems that are
 * also ordinary words in economic news are left out: "investito" (invested),
 * "rassegna" (rassegna stampa), "esposizione" (esposizione al rischio),
 * "mostra" (the verb), "partita" (partita IVA).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeText } from './profession-taxonomy.mjs';
import { comuniMentioned, municipalityProvince } from './topic-coverage-guard.mjs';

export const LOCAL_NEWS_STEMS = Object.freeze([
  // cronaca nera
  'arrest', 'rapin', 'furt', 'omicid', 'accoltell', 'aggredit', 'aggression', 'rissa',
  'spaccio', 'truff', 'polizia', 'carabinier', 'incendi', 'scompars', 'condannat',
  // incidenti stradali
  'incidente', 'incidenti', 'schiant', 'tamponament', 'ribaltat', 'pedon', 'motociclist',
  // sport
  'calcio', 'hockey', 'campionat', 'derby', 'allenator', 'sportiv', 'tennis', 'ciclism',
  'maratona', 'torneo', 'fc lugano', 'hc lugano', 'ambri piotta',
  // cultura ed eventi
  'festival', 'sagra', 'sagre', 'mercatin', 'fiera', 'fiere', 'spettacol', 'concerto',
  'concerti', 'museo', 'musei', 'teatro', 'cinema', 'carnevale', 'cultura', 'cultural',
  'manifestazion',
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LOCAL_NEWS_RE = new RegExp(`\\b(?:${LOCAL_NEWS_STEMS.map(escapeRe).join('|')})`, 'g');

/** Italian provinces of the area (sigle in generator/data/municipalities.ts). */
export const LOCAL_NEWS_PROVINCES = Object.freeze(['VA', 'CO', 'VB']);
const LOCAL_PROVINCE_SET = new Set(LOCAL_NEWS_PROVINCES);

/** The canton, its regions and the Italian side by name (normalizeText output). */
const AREA_NAMES_RE = new RegExp(`\\b(?:${[
  'ticin[a-z]*', 'luganes[ei]', 'mendrisiott[oa]', 'locarnes[ei]', 'bellinzones[ei]',
  'leventina', 'malcantone', 'vallemaggia', 'valle maggia', 'tre valli', 'ceresio',
  'brogeda', 'gaggiolo',
  'varese', 'varesott[oa]', 'comasc[oa]', 'vco', 'ossola', 'ossolan[oa]',
].join('|')})\\b`);

const TICINO_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/ticino-municipalities.json',
);

/**
 * Ticino names that are also ordinary Italian words or other well-known
 * places. They count only after a locative in the original text, with their
 * capital letter and not followed by another capitalised word: «a Paradiso»,
 * «di Tenero», not «paradiso fiscale», «il governo vira», «a Sessa Aurunca».
 */
const AMBIGUOUS_TICINO_NAMES = new Set([
  'paradiso', 'pura', 'quinto', 'tenero', 'contra', 'agno', 'riviera', 'tresa',
  'campo', 'bosco', 'lema', 'vaglio', 'taverne', 'montagnola', 'rodi', 'agra',
  'rivera', 'serravalle', 'vernate', 'muzzano', 'lumino', 'curio', 'sessa', 'manno',
  'carona', 'castione', 'lodrino', 'gudo', 'melano', 'comano', 'cadro', 'piotta',
  'contone', 'moleno', 'lamone', 'isone', 'sala', 'vira', 'quartino', 'torricella',
]);

/**
 * Localities of the BFS list whose name alone is a common noun: they count
 * only in their full form, «Locarno Monti», «Mendrisio Borgo».
 */
const GENERIC_ALONE = new Set(['monti', 'borgo']);

/** Places outside the area whose name contains a Ticino comune. */
const OUTSIDE_AREA_HOMONYMS_RE = /\b(?:castel san pietro terme|sant antonino di susa)\b/g;

let _ticino = null;

/** { plain: Set<normalized name>, ambiguous: Map<normalized, display name>, maxTokens } */
function ticinoIndex() {
  if (_ticino !== null) return _ticino;
  const plain = new Set();
  const ambiguous = new Map();
  let maxTokens = 1;
  try {
    const data = JSON.parse(readFileSync(TICINO_SOURCE, 'utf-8'));
    const names = [...(data.municipalities || []), ...(data.aliases || [])];
    for (const raw of names) {
      const base = String(raw).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
      // "Arbedo-Castione", "Bosco/Gurin": the whole name and each part.
      for (const display of new Set([base, ...base.split(/[-/]/)])) {
        const norm = normalizeText(display);
        if (norm.length < 4 || GENERIC_ALONE.has(norm)) continue;
        if (AMBIGUOUS_TICINO_NAMES.has(norm)) {
          ambiguous.set(norm, display.trim());
          continue;
        }
        plain.add(norm);
        maxTokens = Math.max(maxTokens, norm.split(' ').length);
      }
    }
  } catch {
    // Missing file: only the canton and region names below still place a text.
  }
  _ticino = { plain, ambiguous, maxTokens };
  return _ticino;
}

function mentionsTicinoPlace(text, norm) {
  const { plain, ambiguous, maxTokens } = ticinoIndex();
  const tokens = norm.replace(OUTSIDE_AREA_HOMONYMS_RE, ' ').split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    for (let n = 1; n <= maxTokens && i + n <= tokens.length; n += 1) {
      const phrase = tokens.slice(i, i + n).join(' ');
      if (plain.has(phrase)) return true;
      if (n === 1 && ambiguous.has(phrase)) {
        const display = escapeRe(ambiguous.get(phrase));
        const locative = new RegExp(`(?:^|[^\\p{L}])(?:a|ad|di|da|in|comune di)\\s+${display}(?![\\p{L}]|\\s+\\p{Lu})`, 'u');
        if (locative.test(text)) return true;
      }
    }
  }
  return false;
}

/**
 * Is the text about a place in Ticino or in the provinces of Varese, Como
 * and VCO?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isInLocalNewsArea(text) {
  if (!text || typeof text !== 'string') return false;
  const norm = normalizeText(text);
  if (AREA_NAMES_RE.test(norm)) return true;
  if (mentionsTicinoPlace(text, norm)) return true;
  return comuniMentioned(text).some((slug) => LOCAL_PROVINCE_SET.has(municipalityProvince(slug)));
}

/**
 * How many local-news stems (cronaca, incidenti, sport, cultura) the text
 * carries, wherever it is.
 *
 * @param {string} text
 * @returns {number}
 */
function countLocalNewsStems(text) {
  if (!text || typeof text !== 'string') return 0;
  return [...normalizeText(text).matchAll(LOCAL_NEWS_RE)].length;
}

/**
 * Does the text read like cronaca, a road accident, sport or culture? Kind
 * only: pair it with isInLocalNewsArea, or use isLocalNews.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasLocalNewsSignal(text) {
  return countLocalNewsStems(text) > 0;
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
 * area — the count the admission lexicon adds to its own.
 *
 * @param {string} text
 * @returns {number}
 */
export function countLocalNewsHits(text) {
  const hits = countLocalNewsStems(text);
  return hits > 0 && isInLocalNewsArea(text) ? hits : 0;
}
