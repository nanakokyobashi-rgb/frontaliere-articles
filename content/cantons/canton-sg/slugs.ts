/**
 * Slug per locale degli articoli della sezione canton-sg (San Gallo).
 * Scritto da generator/scripts/create-article.mjs --section=canton-sg.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'canton-san-gallo-stabile-ricerca-lavoro-cala-disoccupazione': { it: 'canton-san-gallo-stabile-ricerca-lavoro-cala-disoccupazione', en: 'canton-of-st-gallen-job-search-stable-unemployment-falls', de: 'kanton-st-gallen-stellensuche-stabil-arbeitslosigkeit-sinkt', fr: 'canton-de-saint-gall-la-recherche-d-emploi-reste-stable-le-chomage-recule' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
