/**
 * Canonicalise the generated Italian SEO title fields.
 *
 * `content.it.title` is the editorial source of truth. The model also returns
 * `ogTitle` and the JSON-LD `headline`, and the persisted `title` is derived
 * from the same text. Three provable shapes turn one of them into a broken
 * derivative of the real title, and only those are repaired here; an unrelated
 * model value is left alone so a data-quality problem is not silently turned
 * into a guess.
 *
 *   1. dangling tail — the value stops on a function word or an open
 *      separator («…cosa cambia per i», «… |»);
 *   2. mid-clause prefix — the value is a strict prefix of the real title cut
 *      inside a clause or inside a word («…in Svizze»);
 *   3. brand-hidden tail — the same as 1, hidden behind the brand suffix of
 *      the SEO `title` («…: cosa | Frontaliere Ticino»).
 *
 * The repair is the real title, never a new cut. Measured on the corpus on
 * 2026-10-08 (6.930 SEO entries, every section): re-cutting the real title at
 * the field budget left tails the shared stopword list cannot see («…per la
 * guerra, ma», «…di dimora: nuove», «…quali spese si»), while `og:title` has
 * no publishing limit and 3.919 of those entries already carried the full
 * title there.
 *
 * ONE source for three callers — `create-article.mjs` (new articles),
 * `repair-truncated-seo-titles.mjs` (historical backfill) and the corpus gates
 * in `generator/tests/` — so the writer, the repairer and the observer cannot
 * disagree on what a broken title is.
 */
import {
  peelDanglingClauseTail,
  truncateToClause,
} from '../../../host/shared/clauseTail.mjs';

export const SEO_TITLE_FIELD_LIMITS = Object.freeze({
  ogTitle: 60,
  headline: 110,
});

/** The three stored fields that carry the Italian title of an article. */
export const SEO_TITLE_FIELDS = Object.freeze(['title', 'ogTitle', 'headline']);

/** Brand suffix of the persisted SEO `title`, appended only when it fits. */
export const SEO_TITLE_BRAND_SUFFIX = ' | Frontaliere Ticino';
/** 60 target + 10 % tolerance, the cap `create-article.mjs` applies. */
export const SEO_TITLE_MAX_CHARS = 66;

const BRAND_SUFFIX_RE = /\s*\|\s*Frontaliere\s+Ticino\s*$/iu;
/**
 * The «already complete» guard of `repairSerpSnippet` in clauseTail.mjs. That
 * module does not export it, so this copy is bound by text:
 * `generator/tests/seo-title-prefix-repair.test.mjs` fails when the two differ.
 */
export const SEO_COMPLETE_SENTENCE_RE = /[.!?…»"')\]]$/u;
// What a word must NOT follow to be read as a mid-sentence proper noun.
const SENTENCE_BREAK_RE = /[:.!?…—–|]$/u;
// What must follow a prefix of the real title for the cut to be intentional.
const CLAUSE_BOUNDARY_NEXT_RE = /^\s*(?:[:;,.!?…—–|(]|-\s)/u;
const BARE_BAR_TAIL_RE = /\s*\|\s*$/u;

/** Collapse source whitespace without changing punctuation or case. */
export function normalizeSeoTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** The SEO `title` without its brand suffix. */
export function stripSeoTitleBrand(value) {
  return normalizeSeoTitle(value).replace(BRAND_SUFFIX_RE, '').trim();
}

/** True only when `candidate` is a non-empty, strict prefix of `canonical`. */
export function isStrictSeoTitlePrefix(candidate, canonical) {
  const value = normalizeSeoTitle(candidate);
  const source = normalizeSeoTitle(canonical);
  return Boolean(value && source && value !== source && source.startsWith(value));
}

/**
 * The names and acronyms a complete title really ends on and that the shared
 * stopword list — compared in lower case — reads as a function word: the brand
 * «On» («on»), the surname of «Lucio Dalla» («dalla»), the acronyms «AI»
 * («ai») and «AD» («ad»), the building «Haus O» («o»).
 *
 * This list is the whole exemption: no shape passes by itself. A capital, an
 * all-caps token and a lone letter all prove nothing — a title cut short ends
 * on «…Nuove Regole Per», «…Nuove Regole PER» or «…Nuove Regole O» with
 * exactly the shape of «…marchio On», «…AVS e AI» and «…Haus O». An entry is
 * added together with a published title that ends on it, and
 * `generator/tests/seo-title-prefix-repair.test.mjs` fails on an entry no
 * published field uses. A surname is listed with its first name and a lone
 * letter with the word it labels: «Dalla» and «O» by themselves are also the
 * tails of «…Colpiti Dalla» and «…Regole O».
 */
export const SEO_PROPER_NOUN_TAILS = Object.freeze(['On', 'Lucio Dalla', 'AI', 'AD', 'Haus O']);

function endsOnListedName(text) {
  return SEO_PROPER_NOUN_TAILS.some((name) => text === name || text.endsWith(` ${name}`));
}

/**
 * True when the text ends on a name or an acronym of `SEO_PROPER_NOUN_TAILS`
 * that the shared stopword list mistakes for a function word: «…per il marchio
 * On», «…di AVS e AI», «…nel nuovo Haus O», «…a Lucio Dalla».
 *
 * Even a listed name is not read as one when it opens a sentence: «…Accordo
 * vicino? On» is a cut sentence, so the name must follow another word, and
 * that part must carry lower-case text (an all-caps title proves nothing about
 * its last word).
 *
 * A listed name says the text MAY end there. Whether a stored field really
 * does is decided against its real title in `seoTitleFieldDefect`.
 */
export function hasProperNounTail(value) {
  const text = normalizeSeoTitle(value);
  const word = /(\S+)$/u.exec(text)?.[1] ?? '';
  if (!/^\p{Lu}[\p{L}\p{N}]*$/u.test(word)) return false;
  const before = text.slice(0, text.length - word.length).trimEnd();
  if (!before || SENTENCE_BREAK_RE.test(before) || !/\p{Ll}/u.test(before)) return false;
  return endsOnListedName(text);
}

/** The shared helper would peel this text: it does not read as complete. */
function stopsOnPeelableTail(text) {
  return Boolean(text) && !SEO_COMPLETE_SENTENCE_RE.test(text) && peelDanglingClauseTail(text) !== text;
}

/**
 * True when a title-like or snippet-like SEO value stops mid-clause: on a
 * function word or on an open separator. The brand suffix is ignored, so a
 * tail hidden behind it is seen.
 */
export function isDanglingSeoTitle(value) {
  const text = stripSeoTitleBrand(value);
  return stopsOnPeelableTail(text) && !hasProperNounTail(text);
}

/**
 * True when ONLY the proper-noun reading keeps a value from being a dangling
 * tail. The corpus gates count these, so the exemption cannot quietly become
 * the way a broken title passes.
 */
export function hasExemptProperNounTail(value) {
  const text = stripSeoTitleBrand(value);
  return stopsOnPeelableTail(text) && hasProperNounTail(text);
}

/**
 * True when `candidate` is a strict prefix of the real title that stops where
 * the real title itself opens a new clause: an intentional short variant.
 */
export function isClauseBoundarySeoTitlePrefix(candidate, canonical) {
  if (!isStrictSeoTitlePrefix(candidate, canonical)) return false;
  const value = normalizeSeoTitle(candidate);
  return CLAUSE_BOUNDARY_NEXT_RE.test(normalizeSeoTitle(canonical).slice(value.length));
}

/** The persisted SEO `title` for a real title: brand suffix only when it fits. */
export function seoTitleFromCanonical(canonical) {
  const source = normalizeSeoTitle(canonical);
  const branded = `${source}${SEO_TITLE_BRAND_SUFFIX}`;
  return branded.length <= SEO_TITLE_MAX_CHARS ? branded : source;
}

/**
 * Why a stored field is a broken derivative of the real title, or `null`.
 *
 *   'dangling'          the value stops on a function word or open separator,
 *                       or on a listed name where the real title goes on
 *                       inside the same clause: the exemption for names says
 *                       a title may end there, not that this one does;
 *   'mid-clause-prefix' `ogTitle`/`headline` only: a strict prefix of the real
 *                       title that neither stops on one of its clause
 *                       boundaries nor is the clause-safe cut earlier repairs
 *                       stored (those stay valid: they are not rewritten).
 *
 * «Clause-safe» means `truncateToClause`, not `truncateToClauseNonEmpty`: the
 * latter adds two fallbacks for callers that must print something, a
 * word-boundary cut made of function words and a hard cut inside the first
 * token. A stored value equal to one of those is still a broken title, and
 * `truncateToClause` answers '' there, so it can never be mistaken for valid.
 *
 * @param {'title'|'ogTitle'|'headline'} field
 */
export function seoTitleFieldDefect(field, candidate, canonical) {
  const value = normalizeSeoTitle(candidate);
  if (!value) return null;
  if (isDanglingSeoTitle(value)) return 'dangling';
  if (hasExemptProperNounTail(value)) {
    // Bound to the real title, for every field: `title` has no prefix rule of
    // its own below, so without this a cut that happens to stop on a listed
    // name would pass every check.
    const core = stripSeoTitleBrand(value);
    if (isStrictSeoTitlePrefix(core, canonical) && !isClauseBoundarySeoTitlePrefix(core, canonical)) return 'dangling';
  }
  const maxLen = SEO_TITLE_FIELD_LIMITS[field];
  if (!maxLen || !isStrictSeoTitlePrefix(value, canonical)) return null;
  if (isClauseBoundarySeoTitlePrefix(value, canonical)) return null;
  if (value === truncateToClause(normalizeSeoTitle(canonical), maxLen)) return null;
  return 'mid-clause-prefix';
}

/**
 * Repair one stored field against the real title. Returns the value unchanged
 * when it has no defect, and also when the real title is missing or dangles
 * itself: a broken source is reported by the gates, never copied around.
 *
 * @param {'title'|'ogTitle'|'headline'} field
 */
export function repairSeoTitleValue(field, candidate, canonical) {
  const current = String(candidate || '').trim();
  const source = normalizeSeoTitle(canonical);
  const defect = seoTitleFieldDefect(field, current, source);
  if (!defect) return current;
  if (!source || isDanglingSeoTitle(source)) return current;
  if (field === 'title') return seoTitleFromCanonical(source);
  if (field === 'ogTitle' && defect === 'dangling') {
    // «Chiusure autostrada A9: cosa cambia per i frontalieri |» — the model's
    // own social title is whole, only the bar of a brand it was told not to
    // add is left over. Keep its wording.
    const withoutBar = current.replace(BARE_BAR_TAIL_RE, '').trim();
    if (withoutBar && withoutBar !== current && !seoTitleFieldDefect(field, withoutBar, source)) {
      return withoutBar;
    }
  }
  return source;
}

/**
 * Apply the same rule to the two fields the model writes. Returns an audit
 * trail so the generator can explain a repair without duplicating the
 * predicate. (`title` is not here: the generator builds it from the real title.)
 */
export function repairSeoTitleFields(seo, canonical) {
  if (!seo || typeof seo !== 'object') return [];
  const changes = [];
  for (const [field, maxLen] of Object.entries(SEO_TITLE_FIELD_LIMITS)) {
    const before = String(seo[field] || '').trim();
    const after = repairSeoTitleValue(field, before, canonical);
    if (after === before) continue;
    seo[field] = after;
    changes.push({ field, before, after, maxLen });
  }
  return changes;
}
