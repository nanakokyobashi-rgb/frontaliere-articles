/**
 * Canonicalise the generated Italian SEO title fields.
 *
 * `content.it.title` is the editorial source of truth. The model also returns
 * `ogTitle` and the JSON-LD `headline`, but a model-side character cap can
 * turn either one into a strict prefix of the real title. Only that provable
 * prefix shape is repaired here; an unrelated model value is left alone so a
 * data-quality problem is not silently turned into a guess.
 */
import { truncateToClauseNonEmpty } from '../../../host/shared/clauseTail.mjs';

export const SEO_TITLE_FIELD_LIMITS = Object.freeze({
  ogTitle: 60,
  headline: 110,
});

/** Collapse source whitespace without changing punctuation or case. */
export function normalizeSeoTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** True only when `candidate` is a non-empty, strict prefix of `canonical`. */
export function isStrictSeoTitlePrefix(candidate, canonical) {
  const value = normalizeSeoTitle(candidate);
  const source = normalizeSeoTitle(canonical);
  return Boolean(value && source && value !== source && source.startsWith(value));
}

/**
 * Repair one field when its value is a truncated prefix of the canonical title.
 * The result is either the full title (when it fits) or a clause-safe prefix.
 */
export function repairSeoTitleField(candidate, canonical, maxLen) {
  const current = String(candidate || '').trim();
  const source = normalizeSeoTitle(canonical);
  if (!isStrictSeoTitlePrefix(current, source)) return current;
  return truncateToClauseNonEmpty(source, maxLen);
}

/**
 * Apply the same rule to the two persisted fields. Returns an audit trail so
 * the generator can explain a repair without duplicating the predicate.
 */
export function repairSeoTitleFields(seo, canonical) {
  if (!seo || typeof seo !== 'object') return [];
  const changes = [];
  for (const [field, maxLen] of Object.entries(SEO_TITLE_FIELD_LIMITS)) {
    const before = String(seo[field] || '').trim();
    const after = repairSeoTitleField(before, canonical, maxLen);
    if (after === before) continue;
    seo[field] = after;
    changes.push({ field, before, after, maxLen });
  }
  return changes;
}
