/**
 * canton-section-demand-ranker.mjs — selezione per domanda di ricerca nei
 * cantoni (F6.2, obiettivo O2 del piano cadenza).
 *
 * Il ranker storico (`article-topic-selector.mjs`) lavora sul vocabolario
 * frontaliere/nazionale, classifica i cluster con una chiamata LLM e puo'
 * proporre candidate sperimentali evergreen: per questo `demandRanker` resta
 * `false` nei profili cantonali. Qui c'e' un ranker a parte, DETERMINISTICO e
 * LOCALE (zero chiamate LLM, quindi M4 non cresce: quando sceglie, anzi,
 * risparmia la chiamata di selezione), alimentato da un vocabolario PER
 * SEZIONE (`generator/data/section-demand-vocabulary.json`, rigenerabile con
 * `generator/scripts/build-section-demand-vocabulary.mjs`).
 *
 * Contratto di ordinamento:
 *  1. la FRESCHEZZA viene prima. Le headline si dividono in fasce di eta'
 *     (fresca <= 48 h, recente <= 7 g, vecchia/senza data); la domanda decide
 *     SOLO dentro la fascia piu' fresca presente nel pool. Una notizia fresca
 *     non viene mai superata da una piu' vecchia con piu' domanda;
 *  2. dentro la fascia, vince il punteggio di domanda (query GSC della sezione
 *     contenute nella headline, pesate per impression e posizione); a parita'
 *     vince l'ordine originale del pool;
 *  3. nessuna query riconosciuta nella fascia fresca => nessuna scelta
 *     (`picks` vuoto) e il chiamante prosegue con la selezione di oggi;
 *  4. sezione senza vocabolario sufficiente => nessuna scelta, stesso esito;
 *  5. se la fascia migliore del pool e' la 2 (tutto vecchio o senza data) =>
 *     `no-fresh-pool`: nessuna scelta, decide la selezione LLM di oggi;
 *  6. PRIVACY: le query del vocabolario passano a runtime dallo stesso filtro
 *     del builder (allowlist di dominio, niente nomi/contatti/codici) e nei log
 *     compare solo un riferimento breve (`q-<hash>`), mai la query intera;
 *  7. un vocabolario con `generatedAt` piu' vecchio di 45 giorni non si carica.
 *
 * Funzioni pure salvo `loadSectionDemandVocabulary` (legge un file JSON).
 */
import fs from 'node:fs';

import { isAllowedDemandQuery, queryRef } from './section-demand-query-filter.mjs';

export const SECTION_DEMAND_VOCABULARY_VERSION = 1;
/** Sotto queste soglie la sezione non ha segnale sufficiente: comportamento di oggi. */
export const MIN_VOCABULARY_QUERIES = 8;
export const MIN_VOCABULARY_IMPRESSIONS = 60;
export const FRESH_HOURS = 48;
export const RECENT_HOURS = 24 * 7;
/** Oltre questa eta' il vocabolario non descrive piu' la domanda: comportamento di oggi. */
export const MAX_VOCABULARY_AGE_DAYS = 45;
const HOUR_MS = 3600 * 1000;
const NOVELTY_DUP_JACCARD = 0.6;

/** Parole funzionali IT/EN/DE/FR che non portano domanda da sole. */
const STOPWORDS = new Set([
  'della', 'delle', 'degli', 'dello', 'dalla', 'dalle', 'nella', 'nelle', 'negli', 'nello', 'sulla', 'sulle', 'sugli',
  'come', 'cosa', 'sono', 'essere', 'questo', 'questa', 'quest', 'quando', 'dove', 'perche', 'anche', 'dopo', 'prima',
  'con', 'per', 'tra', 'fra', 'che', 'del', 'dei', 'dal', 'nel', 'sul', 'una', 'uno', 'gli', 'non', 'piu',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'how', 'are', 'was', 'has', 'have', 'will', 'into', 'about',
  'der', 'die', 'das', 'und', 'mit', 'von', 'für', 'fur', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'ist', 'sind', 'auf',
  'nach', 'bei', 'wie', 'was', 'wird', 'zum', 'zur', 'aus',
  'les', 'des', 'une', 'dans', 'pour', 'avec', 'sur', 'par', 'est', 'sont', 'qui', 'que', 'aux', 'du', 'de', 'la', 'le',
]);

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Radice di 5 caratteri: stessa scelta del matcher di ancore di F6.1 (`stem`). */
export function stemToken(token) {
  return token.slice(0, 5);
}

/** Token significativi (>= 3 caratteri, non funzionali) in forma normalizzata. */
export function significantTokens(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function ignoreStemSet(ignoreTerms) {
  const out = new Set();
  for (const term of ignoreTerms || []) {
    for (const token of normalizeText(term).split(' ')) {
      if (token.length >= 2) out.add(stemToken(token));
    }
  }
  return out;
}

/**
 * Peso di una query: impression (log) x fattore posizione. Le query in
 * posizione 4-20 sono quelle dove un articolo nuovo sposta di piu'; sotto il
 * 3 la sezione e' gia' coperta, oltre il 20 il segnale e' debole.
 */
export function queryWeight(entry) {
  const impressions = Math.max(0, Number(entry?.impressions) || 0);
  const position = Number(entry?.position);
  let factor = 1;
  if (Number.isFinite(position) && position > 0) {
    if (position <= 3) factor = 0.7;
    else if (position <= 20) factor = 1;
    else factor = 0.6;
  }
  return Math.log1p(impressions) * factor;
}

/**
 * Valida il vocabolario di UNA sezione. Ritorna null se insufficiente.
 * @returns {{queries: object[], impressions: number}|null}
 */
export function usableSectionVocabulary(sectionVocab) {
  const queries = Array.isArray(sectionVocab?.queries) ? sectionVocab.queries : [];
  // Difesa a runtime: un JSON vecchio non deve riportare dati personali nei log.
  const valid = queries.filter((q) => typeof q?.query === 'string' && q.query.trim() && Number(q.impressions) > 0 && isAllowedDemandQuery(q.query));
  const impressions = valid.reduce((sum, q) => sum + Number(q.impressions), 0);
  if (valid.length < MIN_VOCABULARY_QUERIES || impressions < MIN_VOCABULARY_IMPRESSIONS) return null;
  return { queries: valid, impressions };
}

/** Compila le query in strutture di match (stem richiesti, soglia, peso). */
export function compileVocabulary(sectionVocab, { ignoreTerms = [] } = {}) {
  const usable = usableSectionVocabulary(sectionVocab);
  if (!usable) return null;
  const ignored = ignoreStemSet(ignoreTerms);
  const compiled = [];
  for (const entry of usable.queries) {
    const stems = [...new Set(significantTokens(entry.query).map(stemToken))].filter((stem) => !ignored.has(stem));
    // Una query fatta solo del nome del cantone non e' domanda su un argomento.
    if (stems.length === 0) continue;
    const required = stems.length <= 2 ? stems.length : Math.ceil(stems.length * 0.67);
    compiled.push({ ref: queryRef(entry.query), stems, required, weight: queryWeight(entry) });
  }
  return compiled.length >= MIN_VOCABULARY_QUERIES ? compiled : null;
}

/** Punteggio di domanda di una headline: somma dei pesi delle query contenute. */
export function demandScore(headlineText, compiled) {
  const stems = new Set(significantTokens(headlineText).map(stemToken));
  let score = 0;
  const matched = [];
  for (const entry of compiled) {
    let hits = 0;
    for (const stem of entry.stems) if (stems.has(stem)) hits += 1;
    if (hits >= entry.required) {
      score += entry.weight;
      if (matched.length < 5) matched.push(entry.ref);
    }
  }
  return { score, matched };
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** 0 = fresca, 1 = recente, 2 = vecchia o senza data. Date future = fresche. */
export function freshnessBand(headline, now, { freshHours = FRESH_HOURS, recentHours = RECENT_HOURS } = {}) {
  const ts = toTimestamp(headline?.date);
  if (ts === null) return 2;
  const ageHours = Math.max(0, (now - ts) / HOUR_MS);
  if (ageHours <= freshHours) return 0;
  if (ageHours <= recentHours) return 1;
  return 2;
}

function stemJaccard(a, b) {
  const sa = new Set(significantTokens(a).map(stemToken));
  const sb = new Set(significantTokens(b).map(stemToken));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const token of sa) if (sb.has(token)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

function relatedHeadlinesFor(chosen, pool) {
  const tokens = (s) => (s || '').toLowerCase().replace(/[^a-z0-9àèéìòùäöüßç\s-]/gi, ' ').split(/\s+/).filter((w) => w.length > 3);
  const selected = new Set(tokens(chosen.headline));
  return pool
    .filter((h) => h !== chosen)
    .map((h) => {
      const overlap = tokens(h.headline).filter((w) => selected.has(w)).length;
      return { h, score: overlap + (h.source === chosen.source ? 2 : 0) };
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ h }) => ({ headline: h.headline, source: h.source, url: h.url }));
}

/**
 * @param {Array<{headline: string, date?: Date|string|null, url?: string, source?: string}>} headlines
 * @param {object|null} sectionVocab  — `sections[<id>]` del vocabolario
 * @param {{now?: number, ignoreTerms?: string[], existingTitles?: string[], minScore?: number,
 *          freshHours?: number, recentHours?: number, titleField?: string}} [opts]
 * @returns {{picks: object[], reason: string, band: number|null, considered: number}}
 */
export function rankCantonHeadlines(headlines, sectionVocab, opts = {}) {
  const list = Array.isArray(headlines) ? headlines : [];
  const titleField = opts.titleField || 'headline';
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0;
  if (list.length === 0) return { picks: [], reason: 'empty-pool', band: null, considered: 0 };
  const compiled = compileVocabulary(sectionVocab, { ignoreTerms: opts.ignoreTerms });
  if (!compiled) return { picks: [], reason: 'insufficient-vocabulary', band: null, considered: 0 };

  const bandOpts = { freshHours: opts.freshHours, recentHours: opts.recentHours };
  const banded = list.map((h, index) => ({ h, index, band: freshnessBand(h, now, bandOpts) }));
  const bestBand = Math.min(...banded.map((x) => x.band));
  // Pool tutto vecchio o senza data: la domanda non decide, resta la selezione LLM.
  if (bestBand >= 2) return { picks: [], reason: 'no-fresh-pool', band: bestBand, considered: 0 };
  const existing = Array.isArray(opts.existingTitles) ? opts.existingTitles : [];
  const scored = [];
  for (const { h, index, band } of banded) {
    if (band !== bestBand) continue;
    const text = String(h?.[titleField] ?? h?.title ?? '');
    if (existing.some((title) => stemJaccard(text, title) >= NOVELTY_DUP_JACCARD)) continue;
    const { score, matched } = demandScore(text, compiled);
    if (score > minScore) scored.push({ h, index, score, matched });
  }
  if (scored.length === 0) return { picks: [], reason: 'no-demand-match-in-freshest-band', band: bestBand, considered: banded.filter((x) => x.band === bestBand).length };
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const top = scored[0];
  const pick = {
    ...top.h,
    relatedHeadlines: relatedHeadlinesFor(top.h, list),
    _selectedSource: 'section-demand',
    _score: { score: top.score, demandScore: top.score, matchedQueryRefs: top.matched, freshnessBand: bestBand },
    _cluster: null,
  };
  return { picks: [pick], reason: 'demand-match', band: bestBand, considered: scored.length };
}

/**
 * Legge il vocabolario per sezione. Mai un'eccezione: file mancante, JSON
 * rotto, versione diversa o `generatedAt` assente/piu' vecchio di
 * `MAX_VOCABULARY_AGE_DAYS` => null (comportamento di oggi). Il caso stantio
 * logga `SECTION_DEMAND_STALE` con la sola data, nessuna query.
 */
export function loadSectionDemandVocabulary(filePath, { now = Date.now(), maxAgeDays = MAX_VOCABULARY_AGE_DAYS } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || parsed.version !== SECTION_DEMAND_VOCABULARY_VERSION || typeof parsed.sections !== 'object') return null;
    const generated = Date.parse(parsed.generatedAt);
    const ageDays = Number.isNaN(generated) ? null : (now - generated) / (24 * HOUR_MS);
    if (ageDays === null || ageDays > maxAgeDays) {
      console.error(`SECTION_DEMAND_STALE generatedAt=${Number.isNaN(generated) ? 'invalid' : parsed.generatedAt} ageDays=${ageDays === null ? 'n/a' : Math.floor(ageDays)} maxAgeDays=${maxAgeDays} fallback=llm_selector`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function sectionVocabularyFor(vocabulary, section) {
  const entry = vocabulary?.sections?.[section];
  return entry && typeof entry === 'object' ? entry : null;
}
