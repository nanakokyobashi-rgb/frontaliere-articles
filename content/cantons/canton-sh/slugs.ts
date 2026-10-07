/**
 * Slug per locale degli articoli della sezione canton-sh (Sciaffusa).
 * Scritto da generator/scripts/create-article.mjs --section=canton-sh.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'esplosione-bancomat-thayngen': { it: 'esplosione-bancomat-thayngen', en: 'thayngen-atm-explosion', de: 'thayngen-geldautomat-gesprengt', fr: 'thayngen-distributeur-explose' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
