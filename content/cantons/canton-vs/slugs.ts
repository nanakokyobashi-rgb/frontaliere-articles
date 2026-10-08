/**
 * Slug per locale degli articoli della sezione canton-vs (Vallese).
 * Scritto da generator/scripts/create-article.mjs --section=canton-vs.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'disoccupazione-vallese-fine-estate': { it: 'disoccupazione-vallese-fine-estate', en: 'valais-unemployment-end-summer', de: 'wallis-arbeitslosigkeit-sommerende', fr: 'chomage-valais-fin-ete' },
 'allerta-botulismo-terrina-vallese': { it: 'allerta-botulismo-terrina-vallese', en: 'valais-botulism-terrine-alert', de: 'wallis-botulismus-terrine-warnung', fr: 'alerte-botulisme-terrine-valais' },
 'a9-chiusure-notturne-sion-sierre': { it: 'a9-chiusure-notturne-sion-sierre', en: 'a9-night-closures-sion-sierre', de: 'a9-nachtsperrungen-sion-sierre', fr: 'a9-fermetures-nocturnes-sion-sierre' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
