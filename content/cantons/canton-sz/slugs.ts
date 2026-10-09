/**
 * Slug per locale degli articoli della sezione canton-sz (Svitto).
 * Scritto da generator/scripts/create-article.mjs --section=canton-sz.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'chiusura-strade-gallusmarkt-svitto': { it: 'chiusura-strade-gallusmarkt-svitto', en: 'road-closure-gallusmarkt-schwyz', de: 'strassensperrung-gallusmarkt-schwyz', fr: 'fermeture-routes-gallusmarkt-schwytz' },
 'svitto-cambio-cassa-malati': { it: 'svitto-cambio-cassa-malati', en: 'schwyz-health-insurance-switch', de: 'schwyz-krankenkassenwechsel', fr: 'schwytz-changement-caisse-maladie' },
 'esercitazione-militare-sihlsee-ottobre-2026': { it: 'esercitazione-militare-sihlsee-ottobre-2026', en: 'military-exercise-sihlsee-october-2026', de: 'militaeruebung-sihlsee-oktober-2026', fr: 'exercice-militaire-sihlsee-octobre-2026' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
