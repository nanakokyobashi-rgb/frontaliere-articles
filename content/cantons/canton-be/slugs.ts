/**
 * Slug per locale degli articoli della sezione canton-be (Berna).
 * Scritto da generator/scripts/create-article.mjs --section=canton-be.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'simplificazione-imposta-trasferimento-berna': { it: 'simplificazione-imposta-trasferimento-berna', en: 'berns-transfer-tax-simplification', de: 'berner-handaenderungssteuer-vereinfachung', fr: 'simplification-impot-transfer-berne' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
