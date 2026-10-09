/**
 * Slug per locale degli articoli della sezione canton-sg (San Gallo).
 * Scritto da generator/scripts/create-article.mjs --section=canton-sg.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'canton-san-gallo-stabile-ricerca-lavoro-cala-disoccupazione': { it: 'canton-san-gallo-stabile-ricerca-lavoro-cala-disoccupazione', en: 'canton-of-st-gallen-job-search-stable-unemployment-falls', de: 'kanton-st-gallen-stellensuche-stabil-arbeitslosigkeit-sinkt', fr: 'canton-de-saint-gall-la-recherche-d-emploi-reste-stable-le-chomage-recule' },
 'incidente-a13-widnau-2026': { it: 'incidente-a13-widnau-2026', en: 'a13-widnau-accident-2026', de: 'a13-widnau-unfall-2026', fr: 'accident-a13-widnau-2026' },
 'casse-malati-amministrazione-costi-2025': { it: 'casse-malati-amministrazione-costi-2025', en: 'health-insurance-funds-administration-ranges-from-103-to-445-francs', de: 'krankenkassen-verwaltungskosten-reichen-von-103-bis-445-franken', fr: 'caisses-maladie-les-couts-administratifs-varient-de-103-a-445-francs' },
 'spital-grabs-haus-o-vertice': { it: 'spital-grabs-haus-o-vertice', en: 'spital-grabs-haus-o-highest-point', de: 'spital-grabs-haus-o-hoechster-punkt', fr: 'spital-grabs-haus-o-point-le-plus-haut' },
 'lavori-strada-wartau-plattis': { it: 'lavori-strada-wartau-plattis', en: 'roadworks-wartau-plattis', de: 'bauarbeiten-wartau-plattis', fr: 'travaux-routiers-wartau-plattis' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
