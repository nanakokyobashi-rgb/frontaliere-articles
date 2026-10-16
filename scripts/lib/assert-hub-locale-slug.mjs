/**
 * Validate one localized reserved hub slug before it is interpolated into a
 * published route. A missing own property must fail closed: inherited values,
 * `undefined`, and empty strings are not publishable slugs.
 */
export function assertHubLocaleSlug(section, topic, locale, slugs) {
  const hasLocale = slugs !== null
    && typeof slugs === 'object'
    && !Array.isArray(slugs)
    && Object.prototype.hasOwnProperty.call(slugs, locale);
  const slug = hasLocale ? slugs[locale] : undefined;
  if (typeof slug !== 'string' || !slug.trim()) {
    throw new Error(`${section}: slug hub mancante o vuoto per ${topic}/${locale}`);
  }
  return slug;
}
