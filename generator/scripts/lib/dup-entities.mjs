/**
 * dup-entities.mjs — the "Entità" signal of checkForDuplicates
 * (create-article.mjs): which facts two articles share.
 *
 * ## The defect (run 36096755072, 2026-09-25)
 *
 * The signal used to be the set of NUMBERS in title + excerpt, compared with
 * Jaccard. Two evergreen pages about different comuni both saying "2026"
 * scored Entità=100%, and the entity clause of the duplicate rule
 * (`entitySim >= 0.65 && combinedScore >= 0.45`) then needed only 0.25 from
 * the other three signals, which the shared "Vivere a … e lavorare in Ticino
 * da frontaliere" template supplies on its own:
 *
 *   «vivere a Erba e lavorare in Ticino…»  ID=14% Titolo=57% Excerpt=17%
 *   Entità=100% Combinato=45% → DUPLICATO, keyword banned for good
 *
 * Measured on the corpus (6181 IT articles): 2026 appears in 929 articles,
 * 2024 in 225, 2025 in 210, "20" (the 20 km zone) in 132, 10000 in 68, 7500
 * (the 2024 accord's exemption) in 35. A number that half a template family
 * carries identifies no article.
 *
 * ## The fix
 *
 *  1. Numbers shared by many published articles are boilerplate and leave
 *     the comparison (`corpusCommonEntities`, document frequency over the
 *     existing corpus, same corpus the check already reads). Comuni never
 *     do, however many pages name them.
 *  2. The comuni an article's title names become entities (`comune:<slug>`,
 *     from the municipality index of topic-coverage-guard.mjs). That is what the rule's
 *     own comment always claimed the signal was — "same place/date/event" —
 *     and it keeps the one real catch the boilerplate numbers used to make by
 *     luck: «Guida fiscale per frontalieri a Gornate Olona» against the
 *     published `gornate-olona-regime-fiscale` (same comune, same angle),
 *     while «vivere a Erba» against «vivere a Brissago-Valtravaglia» no longer
 *     shares anything.
 *
 * Pure except for the municipality index, which topic-coverage-guard reads
 * from data/municipalities.ts and caches.
 */
import { comuniMentioned } from './topic-coverage-guard.mjs';

const COMUNE_PREFIX = 'comune:';

/**
 * Numbers and percentages in `text`.
 *
 * Numbers are normalised to plain digits ("411.000", "411'000" → "411000");
 * percentages keep their sign ("-1,0%" → "10%", next to the bare "10").
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractKeyEntities(text) {
  const entities = new Set();
  const s = String(text || '');
  // Numbers like 411.000, 78'809, 411000
  for (const m of s.matchAll(/\d[\d.'',]*\d/g)) {
    entities.add(m[0].replace(/[.''',]/g, ''));
  }
  // Percentages, single digits included (e.g. "1%")
  for (const m of s.matchAll(/\b(\d+)[.,]?(\d*)\s*%/g)) {
    entities.add(`${m[1]}${m[2]}%`);
  }
  return [...entities];
}

/**
 * An article's entities: the numbers of its title and excerpt, and the
 * comuni its TITLE names.
 *
 * Title only for the places: the title names the comune the page is about,
 * the excerpt also names its neighbours ("a pochi minuti da Aosta"). Taking
 * the excerpt's comuni too made «Vivere ad Allein» look like the Aosta page,
 * measured on the corpus.
 *
 * @param {string} title
 * @param {string} excerpt
 * @returns {string[]}
 */
export function articleEntities(title, excerpt) {
  const entities = extractKeyEntities(`${title || ''} ${excerpt || ''}`);
  for (const comune of comuniMentioned(title)) entities.push(`${COMUNE_PREFIX}${comune}`);
  return entities;
}

/**
 * From how many published articles on an entity stops identifying one: 0.5%
 * of the corpus, never fewer than 20. At 6181 articles that is 31, which
 * drops the years, the 20 km zone, 10000 and 7500, and keeps figures like
 * 411000 or 78809 that one news story carries.
 *
 * @param {number} corpusSize
 * @returns {number}
 */
export function commonEntityMinDf(corpusSize) {
  return Math.max(20, Math.ceil(Math.max(0, corpusSize) * 0.005));
}

/**
 * The NUMBERS that at least `minDf` of the given entity lists contain.
 *
 * Numbers only: a comune is never boilerplate. Como or Varese in a title is
 * common because many pages are about them, and two of those pages about the
 * same place with different wording are exactly the duplicate the comune
 * entity exists to catch (review of PR #1871) — dropping it for frequent
 * comuni would leave the big ones, where most pages are, unprotected.
 *
 * @param {Iterable<string[]>} entityLists one list per existing article
 * @param {number} minDf
 * @returns {Set<string>}
 */
export function corpusCommonEntities(entityLists, minDf) {
  const df = new Map();
  for (const list of entityLists) {
    for (const entity of new Set(list)) {
      if (entity.startsWith(COMUNE_PREFIX)) continue;
      df.set(entity, (df.get(entity) || 0) + 1);
    }
  }
  const common = new Set();
  for (const [entity, count] of df) if (count >= minDf) common.add(entity);
  return common;
}

/**
 * `entities` without the corpus boilerplate.
 *
 * @param {string[]} entities
 * @param {Set<string>} common
 * @returns {string[]}
 */
export function distinctiveEntities(entities, common) {
  return entities.filter((e) => !common.has(e));
}
