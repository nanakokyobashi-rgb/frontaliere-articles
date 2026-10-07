/**
 * Slug per locale degli articoli della sezione canton-gl (Glarona).
 * Scritto da generator/scripts/create-article.mjs --section=canton-gl.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'revisione-fiscale-canton-glarona': { it: 'revisione-fiscale-canton-glarona', en: 'tax-law-amendment-canton-glarus', de: 'steuergesetz-aenderung-kanton-glarus', fr: 'modification-de-la-loi-fiscale-canton-de-glarus' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
