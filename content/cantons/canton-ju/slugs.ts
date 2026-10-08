/**
 * Slug per locale degli articoli della sezione canton-ju (Giura).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ju.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'disoccupazione-giura-settembre-2026': { it: 'disoccupazione-giura-settembre-2026', en: 'unemployment-in-jura-falls-to-4-2-in-september-2026', de: 'arbeitslosigkeit-im-jura-sinkt-im-september-2026-auf-4-2', fr: 'le-chomage-dans-le-jura-baisse-a-4-2-en-septembre-2026' },
 'fondo-clima-giura-2028': { it: 'fondo-clima-giura-2028', en: 'jura-climate-fund-2028', de: 'jura-klimafonds-2028', fr: 'fonds-climat-jura-2028' },
 'casse-pensioni-migliorano-terzo-trimestre': { it: 'casse-pensioni-migliorano-terzo-trimestre', en: 'swiss-pension-funds-improve-q3-2026', de: 'schweizer-pensionskassen-verbessern-q3-2026', fr: 'les-caisses-de-pension-suisses-ameliorent-q3-2026' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
