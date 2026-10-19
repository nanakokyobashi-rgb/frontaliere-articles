/**
 * Neutral localized alt text for generated article covers.
 *
 * Generated-image prompts and article topics do not verify the visible scene.
 * Keep one generic description for every writer that consumes generated covers.
 */
export const GENERATED_COVER_ALT_BY_LOCALE = Object.freeze({
  it: 'Immagine illustrativa pertinente al tema dell’articolo',
  en: 'Illustrative image relevant to the article topic',
  de: 'Illustratives Bild zum Thema des Artikels',
  fr: 'Image illustrative en lien avec le sujet de l’article',
});

export const LEGACY_GENERATED_COVER_ALT_BY_LOCALE = Object.freeze({
  it: 'Illustrazione generata per questo articolo',
  en: 'Illustration generated for this article',
  de: 'Für diesen Artikel erstellte Illustration',
  fr: 'Illustration générée pour cet article',
});

export function isGeneratedCoverAlt(locale, value) {
  const currentAlt = GENERATED_COVER_ALT_BY_LOCALE[locale];
  return typeof currentAlt === 'string'
    && (value === currentAlt || value === LEGACY_GENERATED_COVER_ALT_BY_LOCALE[locale]);
}

/** Localized fallback for a licensed photo when metadata still has generated-cover alt text. */
export const LICENSED_PHOTO_ALT_BY_LOCALE = Object.freeze({
  it: 'Fotografia pertinente al tema dell’articolo',
  en: 'Photograph relevant to the article topic',
  de: 'Fotografie zum Thema des Artikels',
  fr: 'Photographie en lien avec le sujet de l’article',
});
