/**
 * Slug per locale degli articoli della sezione canton-ow (Obvaldo).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ow.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'rtvv-obvaldo-categorie-aziendali': { it: 'rtvv-obvaldo-categorie-aziendali', en: 'obwalden-rtvv-business-fee-categories', de: 'obwalden-rtvv-tarifkategorien-unternehmen', fr: 'obwald-rtvv-categories-redevance-entreprises' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
