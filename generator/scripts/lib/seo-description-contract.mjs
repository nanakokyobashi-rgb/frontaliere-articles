/** Shared upper bound for the public SERP description surface. */
export const SEO_DESCRIPTION_MAX = 150;

/** RSS uses the same bounded SERP description surface as the public meta tag. */
export const RSS_DESCRIPTION_MAX_CHARS = SEO_DESCRIPTION_MAX;

/** Shared upper bound for the public social-card description surface. */
export const SEO_OG_DESCRIPTION_MAX = 250;

/** Shared lower bound for the public SERP description surface. */
export const SEO_DESCRIPTION_MIN = 80;

/**
 * Historical SEO text is retained in storage, while every public projection
 * must opt into the appropriate bounded renderer. Keeping that decision
 * explicit prevents a future writer from treating old over-budget values as
 * either silently migrated or safe to publish verbatim.
 */
export const HISTORICAL_SEO_DESCRIPTION_POLICY = Object.freeze({
  storage: 'preserve',
  publicSurface: 'clamp',
});

/**
 * Verify the preserve-in-storage / clamp-on-public-surface policy.
 *
 * The default identity projectors intentionally fail for an over-budget
 * historical value: a caller that publishes it must provide the public
 * projection it actually uses. Values already within budget remain unchanged.
 *
 * @param {Array<Record<string, unknown>>} records parsed historical entries
 * @param {{projectDescription?: (value: string, record: Record<string, unknown>) => unknown,
 *   projectOgDescription?: (value: string, record: Record<string, unknown>) => unknown}} options
 * @returns {{records: number, historicalDescriptions: number, historicalOgDescriptions: number}}
 */
export function assertHistoricalSeoDescriptionsMigrated(records, {
  projectDescription = (value) => value,
  projectOgDescription = (value) => value,
} = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError('Historical SEO description policy expects an array of records');
  }
  if (typeof projectDescription !== 'function' || typeof projectOgDescription !== 'function') {
    throw new TypeError('Historical SEO description policy expects function projectors');
  }

  const violations = [];
  let historicalDescriptions = 0;
  let historicalOgDescriptions = 0;
  for (const record of records) {
    const id = String(record?.id ?? 'unknown');
    for (const [field, max, projector, counter] of [
      ['description', SEO_DESCRIPTION_MAX, projectDescription, 'description'],
      ['ogDescription', SEO_OG_DESCRIPTION_MAX, projectOgDescription, 'ogDescription'],
    ]) {
      const stored = record?.[field];
      if (stored === undefined || stored === null) continue;
      if (typeof stored !== 'string') {
        violations.push(`${id}.${field} is not a string`);
        continue;
      }
      if (stored.length <= max) continue;
      if (counter === 'description') historicalDescriptions += 1;
      else historicalOgDescriptions += 1;
      let projected;
      try {
        projected = projector(stored, record);
      } catch (error) {
        violations.push(`${id}.${field} projector failed: ${error?.message ?? error}`);
        continue;
      }
      const projectedLength = typeof projected === 'string' ? projected.trim().length : 0;
      const tooShort = field === 'description' && projectedLength < SEO_DESCRIPTION_MIN;
      if (typeof projected !== 'string' || projectedLength === 0 || projected.length > max || tooShort) {
        violations.push(
          `${id}.${field} stores ${stored.length} chars but its public projection is ` +
            `${typeof projected === 'string' ? projected.length : 'not a string'} chars ` +
            `(min ${field === 'description' ? SEO_DESCRIPTION_MIN : 0}, max ${max})`,
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Historical SEO description policy failed (${violations.length} violation(s)): ${violations.slice(0, 8).join('; ')}`,
    );
  }
  return { records: records.length, historicalDescriptions, historicalOgDescriptions };
}

/** Fail closed before a description can be written to content/seo/**. */
export function assertSeoDescriptionMinimum(description, {
  id = 'unknown',
  sourceDescriptionLength,
  sourceExcerptLength,
} = {}) {
  const boundedLength = typeof description === 'string' ? description.trim().length : 0;
  if (boundedLength >= SEO_DESCRIPTION_MIN) return description;

  const descriptionLength = Number.isInteger(sourceDescriptionLength)
    ? sourceDescriptionLength
    : boundedLength;
  const excerpt = Number.isInteger(sourceExcerptLength) ? `, excerpt: ${sourceExcerptLength}` : '';
  throw new Error(
    `SEO description for article "${id}" must contain at least ${SEO_DESCRIPTION_MIN} characters of article-specific text ` +
      `(description: ${descriptionLength}${excerpt}, after cap: ${boundedLength})`,
  );
}
