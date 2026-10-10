/** Shared lower bound for the public SERP description surface. */
export const SEO_DESCRIPTION_MIN = 80;

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
