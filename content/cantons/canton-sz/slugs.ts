/**
 * Slug per locale degli articoli della sezione canton-sz (Svitto).
 * Scritto da generator/scripts/create-article.mjs --section=canton-sz.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'chiusura-strade-gallusmarkt-svitto': { it: 'chiusura-strade-gallusmarkt-svitto', en: 'road-closure-gallusmarkt-svitto', de: 'strassensperrung-gallusmarkt-svitto', fr: 'fermeture-routes-gallusmarkt-svitto' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
