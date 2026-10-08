/**
 * The pure content half of the generator's duplicate guard.
 *
 * It is deliberately kept free of generator/runtime imports so CI checks can
 * apply the same thresholds to a git snapshot without loading the generation
 * pipeline or its optional provider dependencies.
 */
import {
  jaccardSim,
  normalizeItWord,
  STOP_WORDS_IT,
} from './it-text-similarity.mjs';
import { computeAdaptiveEvergreenThresholds } from './scoring/constants.mjs';
import {
  articleEntities,
  commonEntityMinDf,
  corpusCommonEntities,
  distinctiveEntities,
} from './dup-entities.mjs';

/**
 * Return the first existing article that the generator's multi-signal guard
 * considers a content duplicate, together with the measured signals.
 *
 * `data` is the generator shape (`content.it`) or the compact `{id, title,
 * excerpt}` shape used by snapshot readers. The candidate itself is excluded
 * by id so a post-rebase snapshot can contain the new record as well.
 */
export function findContentDuplicate(data, existingArticles) {
  const candidate = data?.content?.it ?? data;
  const candidateId = data?.id ?? candidate?.id;
  existingArticles = (existingArticles ?? []).filter((article) => article?.id !== candidateId);
  const articles = existingArticles;

  // ── Local tokenizer ────────────────────────────────────────
  // Differs from the shared `tokenizeIt`: strips punctuation entirely
  // (so "4.000" → "4000", not "000") because checkForDuplicates' thresholds
  // were tuned against numeric-collapse behavior. Stopwords/stemmer/synonyms
  // reuse scripts/lib/it-text-similarity.mjs's STOP_WORDS_IT directly — this
  // used to keep a byte-for-byte local copy of that Set, which is exactly the
  // drift risk AGENTS.md #6 flags (2026-07-18 sibling-pattern fix).
  function getSignificantWords(text) {
    return String(text ?? '').toLowerCase()
      .replace(/[^a-zàáèéìíòóùú0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS_IT.has(w))
      .map(w => normalizeItWord(w));
  }

  function jaccardSimilarity(wordsA, wordsB) {
    return jaccardSim(wordsA, wordsB);
  }

  // ── Entities: what facts two articles share (dup-entities.mjs) ──
  // Numbers of title + excerpt and the comuni the title names, minus the
  // corpus boilerplate: a number that 0.5% of the published articles carry
  // ("2026", the 20 km zone, the 2024 accord's 7500/10000) identifies no
  // article. It used to count, and two comune pages that both said "2026"
  // scored Entità=100% — enough, with the shared "Vivere a … e lavorare in
  // Ticino" template, to reject a new comune as a duplicate of another one
  // (run 36096755072: Erba). Measured on the 306 published comune pages: the
  // two cross-comune false positives go, and the pairs about the SAME comune
  // are caught through the comune entity instead of by number luck.
  const existingEntityLists = existingArticles.map((a) => articleEntities(a.title, a.excerpt));
  const commonEntities = corpusCommonEntities(existingEntityLists, commonEntityMinDf(existingArticles.length));

  // ── Prepare new article signals ────────────────────────────
  const newIdWords = String(candidateId ?? '').split('-').filter(w => w.length > 1).map(w => normalizeItWord(w));
  const newTitleWords = getSignificantWords(candidate?.title);
  const newExcerptWords = getSignificantWords(candidate?.excerpt || '');
  const newEntities = distinctiveEntities(
    articleEntities(candidate?.title ?? '', candidate?.excerpt || ''),
    commonEntities,
  );

  // ── Thresholds ─────────────────────────────────────────────
  // Any single signal OR the combined score exceeding its threshold → duplicate
  // Loosened 2026-07-01 (#3138 follow-up): the standalone titleSim trigger
  // (0.58) was firing on evergreen fiscal keywords that necessarily share
  // domain terminology ("quellensteuer", "svizzera", "2026", "permesso")
  // without being the same article — this burned most of the widened
  // evergreen pool from #3217 before it could ever be reached. Raised each
  // threshold ~15-25% so a title/excerpt alone must be near-identical, not
  // just topically related, to hard-block; the combined weighted score still
  // catches genuinely near-duplicate articles with different wording.
  const ID_THRESHOLD = 0.72;       // stricter: reduce false-positive duplicate IDs
  // TITLE_THRESHOLD made corpus-size-adaptive 2026-07-17: kept in sync with
  // preFlightEvergreenTopicCheck's titleJaccard (see constants.mjs) so an
  // evergreen candidate approved by the pre-flight gate is never
  // hard-rejected here post-generation — that would waste the exact LLM
  // cycle the pre-flight gate exists to avoid.
  const TITLE_THRESHOLD = computeAdaptiveEvergreenThresholds(existingArticles.length).titleJaccard; // near-identical title only (was 0.58, then fixed 0.72)
  const EXCERPT_THRESHOLD = 0.62;  // near-identical excerpt only (was 0.50)
  const COMBINED_THRESHOLD = 0.55; // catch semantically similar articles with different wording (was 0.48)

  for (const [index, existing] of articles.entries()) {
    const existingIdWords = existing.id.split('-').filter(w => w.length > 1).map(w => normalizeItWord(w));
    const existingTitleWords = getSignificantWords(existing.title);
    const existingExcerptWords = getSignificantWords(existing.excerpt);
    const existingEntities = distinctiveEntities(existingEntityLists[index], commonEntities);

    // Compute individual similarity scores
    const idSim = jaccardSimilarity(newIdWords, existingIdWords);
    const titleSim = jaccardSimilarity(newTitleWords, existingTitleWords);
    const excerptSim = jaccardSimilarity(newExcerptWords, existingExcerptWords);
    const entitySim = jaccardSimilarity(newEntities, existingEntities);

    // Weighted combined score
    const combinedScore =
      0.25 * idSim +
      0.30 * titleSim +
      0.25 * excerptSim +
      0.20 * entitySim;

    // Any signal OR combined score triggers duplicate detection
    const isDuplicate =
      (idSim >= ID_THRESHOLD && titleSim >= 0.40) ||
      titleSim >= TITLE_THRESHOLD ||
      (excerptSim >= EXCERPT_THRESHOLD && entitySim >= 0.20) ||
      // High entity overlap (same comune, same figures) with moderate combined score
      (entitySim >= 0.65 && combinedScore >= 0.45) ||
      combinedScore >= COMBINED_THRESHOLD;

    if (isDuplicate) {
      const signals = [];
      if (idSim >= ID_THRESHOLD)
        signals.push(`ID: ${(idSim * 100).toFixed(0)}% ≥ ${ID_THRESHOLD * 100}%`);
      if (titleSim >= TITLE_THRESHOLD)
        signals.push(`Titolo: ${(titleSim * 100).toFixed(0)}% ≥ ${TITLE_THRESHOLD * 100}%`);
      if (excerptSim >= EXCERPT_THRESHOLD)
        signals.push(`Excerpt: ${(excerptSim * 100).toFixed(0)}% ≥ ${EXCERPT_THRESHOLD * 100}%`);
      if (combinedScore >= COMBINED_THRESHOLD)
        signals.push(`Combinato: ${(combinedScore * 100).toFixed(0)}% ≥ ${COMBINED_THRESHOLD * 100}%`);
      // The entity clause used to leave "Segnali" empty, so the log line and
      // the run report read the Dettaglio line instead of a reason.
      if (entitySim >= 0.65 && combinedScore >= 0.45)
        signals.push(`Entità+Combinato: ${(entitySim * 100).toFixed(0)}% ≥ 65% e ${(combinedScore * 100).toFixed(0)}% ≥ 45%`);

      return {
        existing,
        signals,
        idSim,
        titleSim,
        excerptSim,
        entitySim,
        combinedScore,
        sharedEntities: [...newEntities].filter((e) => existingEntities.includes(e)),
      };
    }
  }
  return null;
}
