/**
 * Slug per locale degli articoli della sezione canton-ge (Ginevra).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ge.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'economia-ginevrina-ripresa-globale': { it: 'economia-ginevrina-ripresa-globale', en: 'geneva-economy-global-recovery', de: 'genfer-wirtschaft-globale-erholung', fr: 'economie-genevoise-reprise-mondiale' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
