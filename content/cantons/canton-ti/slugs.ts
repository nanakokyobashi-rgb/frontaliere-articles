/**
 * Slug per locale degli articoli della sezione canton-ti (Ticino).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ti.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'a2-mendrisio-melano-risanamento': { it: 'a2-mendrisio-melano-risanamento', en: 'a2-mendrisio-melano-renovation', de: 'a2-mendrisio-melano-sanierung', fr: 'a2-mendrisio-melano-renovation' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
