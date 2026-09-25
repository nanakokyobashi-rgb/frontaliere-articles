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
 * Zurich, Bern and every border comune of Sondrio, Lecco or Aosta, and it
 * misses 97 of the 162 Ticino names, so on the frontaliere section the scan
 * also anchors on isInLocalNewsArea (filterByAnchor). Names that
 * span the border of the area are not used: Lago Maggiore (also Novara), Lario
 * (also Lecco), Gottardo (also Uri), San Bernardino (Graubünden).
 *
 * WHAT — cronaca nera, road accidents, sport, culture and events, matched as
 * word-start stems on normalizeText() output, so a stem never fires inside
 * another word ("sportello", "trasporti", "concertazione"). Stems that are
 * also ordinary words in economic news are left out: "investito" (invested),
 * "rassegna" (rassegna stampa), "esposizione" (esposizione al rischio),
 * "mostra" (the verb), "partita" (partita IVA).
 *
 * BOTH TOGETHER — the kind and the place must describe the same event: they
 * are read sentence by sentence, and a stem takes the place NEAREST to it
 * among the places the sentence introduces with a preposition («a Chiasso»,
 * «nel Mendrisiotto») or as a dateline («Lugano, rapina…»). «Arresto a
 * Milano, ricercato anche in Ticino» is an arrest in Milan. A capitalised
 * word after a preposition that is not in the area counts as a place outside
 * it, unless it is plainly not a place (a road like A2, an acronym, a feast
 * day, an institution). With no such place in the sentence, a mention of the
 * area in the same sentence («la polizia ticinese») is enough; sport is
 * placed by the club, so a mention of the area in the sentence always is
 * («il Lugano pareggia a Basilea»). URLs are not prose and are left out.
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
const LOCAL_NEWS_RE = new RegExp(`\\b(?:${LOCAL_NEWS_STEMS.map(escapeRe).join('|')})`);
const STEM_PARTS = LOCAL_NEWS_STEMS.map((stem) => stem.split(' '));

/** Local clubs: the stem is also the place. */
const LOCAL_TEAM_STEMS = new Set(['fc lugano', 'hc lugano', 'ambri piotta']);

/**
 * Sport is placed by the club, not the venue: «il Lugano pareggia a Basilea»
 * is Ticino sport. A sport stem needs the area anywhere in its sentence.
 */
const SPORT_STEMS = new Set([
  'calcio', 'hockey', 'campionat', 'derby', 'allenator', 'sportiv', 'tennis', 'ciclism',
  'maratona', 'torneo',
]);

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

const LOCATIVE_PREPOSITIONS = new Set([
  'a', 'ad', 'in', 'di', 'da', 'tra', 'fra', 'presso', 'verso',
  'al', 'allo', 'alla', 'all', 'ai', 'agli', 'alle',
  'nel', 'nello', 'nella', 'nell', 'nei', 'negli', 'nelle',
  'sul', 'sullo', 'sulla', 'sull', 'sui', 'sugli', 'sulle',
  'del', 'dello', 'della', 'dell', 'dei', 'degli', 'delle',
  'dal', 'dallo', 'dalla', 'dall', 'dai', 'dagli', 'dalle',
]);

/** Lower-case words inside a place name: «Ronco sopra Ascona», «Collina d'Oro». */
const PLACE_CONNECTORS = new Set(['di', 'd', 'del', 'della', 'sopra', 'sotto']);

/**
 * Capitalised words after a preposition, or before a dateline colon, that are
 * not places: feast days, weekdays, institutions, section labels. A candidate
 * starting with one of them, or with a local-news stem («Hockey: …»), is
 * ignored unless the whole candidate is in the area («Municipio di Lugano»).
 */
const NOT_A_PLACE = new Set([
  'natale', 'pasqua', 'capodanno', 'ferragosto', 'carnevale', 'epifania',
  'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica',
  'polizia', 'procura', 'tribunale', 'corte', 'consiglio', 'gran', 'governo', 'stato',
  'confederazione', 'ministero', 'ufficio', 'dipartimento', 'municipio', 'comune',
  'parlamento', 'ospedale', 'pronto', 'rega', 'croce',
  'cronaca', 'sport', 'cultura', 'video', 'foto', 'aggiornamento', 'ultima', 'ultimora',
]);

const startsWithStem = (norm) => STEM_PARTS.some((parts) => parts.length === 1 && norm.startsWith(parts[0]));

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const WORD_RE = /[\p{L}\p{N}]+/gu;

function sentencesOf(text) {
  return text.replace(URL_RE, ' ').split(/(?<=[.!?;])\s+|\n+/).filter((s) => s.trim());
}

function tokensOf(sentence) {
  return [...sentence.matchAll(WORD_RE)].map((m) => ({
    raw: m[0],
    norm: normalizeText(m[0]),
    start: m.index,
    end: m.index + m[0].length,
    upper: /^\p{Lu}/u.test(m[0]),
  }));
}

/** Stem occurrences in a sentence: { index, team }. */
function stemHits(tokens) {
  const hits = [];
  for (let i = 0; i < tokens.length; i += 1) {
    for (const parts of STEM_PARTS) {
      if (i + parts.length > tokens.length) continue;
      const last = parts.length - 1;
      const match = parts.every((part, k) => (k === last
        ? tokens[i + k].norm.startsWith(part)
        : tokens[i + k].norm === part));
      if (match) {
        const stem = parts.join(' ');
        hits.push({ index: i, team: LOCAL_TEAM_STEMS.has(stem), sport: SPORT_STEMS.has(stem) });
        break;
      }
    }
  }
  return hits;
}

/**
 * Places a sentence introduces: after a preposition, or as a dateline at its
 * start. Each is { index, inArea } — inArea false for a place outside the
 * area; words that are plainly not places are dropped.
 */
function placesOf(sentence, tokens) {
  const places = [];
  const gap = (a, b) => sentence.slice(tokens[a].end, tokens[b].start);
  for (let j = 0; j < tokens.length; j += 1) {
    if (!tokens[j].upper) continue;
    const afterPreposition = j > 0
      && LOCATIVE_PREPOSITIONS.has(tokens[j - 1].norm)
      && /^[\s'’]+$/.test(gap(j - 1, j));
    let k = j;
    while (k + 1 < tokens.length) {
      if (/^[\s'’-]+$/.test(gap(k, k + 1)) && tokens[k + 1].upper) {
        k += 1;
      } else if (k + 2 < tokens.length
        && /^[\s'’]+$/.test(gap(k, k + 1)) && PLACE_CONNECTORS.has(tokens[k + 1].norm)
        && /^[\s'’]+$/.test(gap(k + 1, k + 2)) && tokens[k + 2].upper) {
        k += 2;
      } else {
        break;
      }
    }
    const dateline = j === 0 && /^\s*[,:–—-]/.test(sentence.slice(tokens[k].end));
    if (afterPreposition || dateline) {
      const name = sentence.slice(tokens[j].start, tokens[k].end);
      const preposition = afterPreposition ? tokens[j - 1].norm : 'a';
      if (isInLocalNewsArea(`${preposition} ${name}`)) {
        places.push({ index: j, inArea: true });
      } else if (!/\d/.test(tokens[j].raw)
        && !(tokens[j].raw === tokens[j].raw.toUpperCase() && tokens[j].raw.length <= 5)
        && !NOT_A_PLACE.has(tokens[j].norm)
        && !startsWithStem(tokens[j].norm)) {
        places.push({ index: j, inArea: false });
      }
    }
    j = k;
  }
  return places;
}

/** Stem occurrences whose event is placed in the area. */
function localStemHits(text) {
  if (!text || typeof text !== 'string') return 0;
  let count = 0;
  for (const sentence of sentencesOf(text)) {
    const tokens = tokensOf(sentence);
    const hits = stemHits(tokens);
    if (hits.length === 0) continue;
    const places = placesOf(sentence, tokens);
    const areaMention = isInLocalNewsArea(sentence);
    for (const hit of hits) {
      if (hit.team) {
        count += 1;
        continue;
      }
      if (hit.sport || places.length === 0) {
        if (areaMention) count += 1;
        continue;
      }
      let nearest = places[0];
      for (const place of places) {
        if (Math.abs(place.index - hit.index) < Math.abs(nearest.index - hit.index)) nearest = place;
      }
      if (nearest.inArea) count += 1;
    }
  }
  return count;
}

/**
 * Does the text read like cronaca, a road accident, sport or culture? Kind
 * only, anywhere in the text: use isLocalNews for the kind in the area.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasLocalNewsSignal(text) {
  if (!text || typeof text !== 'string') return false;
  return LOCAL_NEWS_RE.test(normalizeText(text.replace(URL_RE, ' ')));
}

/**
 * Local news the frontaliere section admits: in at least one sentence, the
 * kind of news and a place in the area that belong to the same event.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isLocalNews(text) {
  return localStemHits(text) > 0;
}

/**
 * How many local-news stems describe an event in the area — the count the
 * admission lexicon adds to its own.
 *
 * @param {string} text
 * @returns {number}
 */
export function countLocalNewsHits(text) {
  return localStemHits(text);
}
