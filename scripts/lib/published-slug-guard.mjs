/**
 * Values that must never be emitted as a published article identity.
 *
 * This is a publish-boundary guard, not the translation predicate: a German
 * article may legitimately contain the word `Null`, but the literal segment
 * `null` is never a safe fallback for a public URL. The topic-gate field names
 * are a second reserved family: an abort verdict is control data, not an
 * article id or slug. Keep the rules here so the writer, API builder, sitemap
 * builder and corpus scan cannot drift apart.
 */

const RESERVED_PUBLISHED_SLUGS = new Set(['null', 'undefined']);

const ARTICLE_SERVICE_MARKER_RULES = Object.freeze([
  // These values are emitted by the topic-gate branch as prefixes. Matching a
  // segment named `abort` or `topical-relevance` in the middle of an ordinary
  // slug would reserve legitimate article words for no publish-boundary
  // reason.
  Object.freeze({ name: 'abort', pattern: /^abort(?:-|$)/i }),
  Object.freeze({
    name: 'topical-relevance',
    pattern: /^(?:topical[-_]relevance|abort[-_]topical[-_]relevance)(?:-|$)/i,
  }),
  Object.freeze({ name: 'abort_topical_relevance', pattern: /^abort[-_]topical[-_]relevance(?:-|$)/i }),
  // `reason` by itself is the topic-gate field. Keep the one known leaked
  // rejection form, but do not reserve normal prose such as
  // `reason-for-moving-to-ticino`.
  Object.freeze({ name: 'reason', pattern: /(?:^|-)reason(?:$|-(?:for-)?(?:reject(?:ion)?|abort|off-topic))/i }),
]);

/**
 * Return the topic-gate service markers found in one identity value.
 * Underscores are normalized only for matching, so both the JSON field name
 * (`abort_topical_relevance`) and its leaked URL form are covered. The
 * context-sensitive rules deliberately leave ordinary slug words alone.
 */
export function findPublishedIdentityServiceMarkers(value) {
  if (typeof value !== 'string') return [];
  const normalized = value.trim().replace(/_/g, '-');
  if (!normalized) return [];
  return ARTICLE_SERVICE_MARKER_RULES
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ name }) => name);
}

/**
 * Check the id and all four localized slugs with the same rule.
 * `field`/`locale` make the corpus observer's finding actionable without
 * teaching it a second parser for the identity shape.
 */
export function findArticleIdentityServiceMarkers(identity) {
  const candidates = [
    { field: 'id', locale: null, value: identity?.id },
    ...['it', 'en', 'de', 'fr'].map((locale) => ({
      field: 'slug', locale, value: identity?.slugs?.[locale],
    })),
  ];
  return candidates.flatMap(({ field, locale, value }) =>
    findPublishedIdentityServiceMarkers(value).map((marker) => ({ field, locale, value, marker })));
}

export function isReservedPublishedSlug(value) {
  return typeof value === 'string'
    && (RESERVED_PUBLISHED_SLUGS.has(value.trim().toLowerCase())
      || findPublishedIdentityServiceMarkers(value).length > 0);
}
