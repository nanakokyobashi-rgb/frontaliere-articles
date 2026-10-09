/**
 * Slug per locale degli articoli della sezione canton-gr (Grigioni).
 * Scritto da generator/scripts/create-article.mjs --section=canton-gr.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'strada-calanca-chiusura-preventiva': { it: 'strada-calanca-chiusura-preventiva', en: 'calanca-road-preventive-closure', de: 'calancastrasse-praventive-sperrung', fr: 'route-calanca-fermeture-preventive' },
 'benzina-grigioni-deviazione': { it: 'benzina-grigioni-deviazione', en: 'graubuenden-fuel-detour', de: 'graubuenden-tankrechner-umweg', fr: 'grisons-carburant-detour' },
 'lavoro-grigioni-settembre-2026': { it: 'lavoro-grigioni-settembre-2026', en: 'graubunden-unemployment-september-2026', de: 'arbeitslosigkeit-graubuenden-september-2026', fr: 'chomage-grisons-septembre-2026' },
 'grigioni-valanghe-scuola-rossa-roveredo': { it: 'grigioni-valanghe-scuola-rossa-roveredo', en: 'graubunden-avalanches-school-rossa-roveredo', de: 'graubuenden-lawinen-schule-rossa-roveredo', fr: 'grisons-avalanches-ecole-rossa-roveredo' },
 'code-domenicali-landquart': { it: 'code-domenicali-landquart', en: 'sunday-traffic-landquart', de: 'sonntagsstau-landquart-outlet', fr: 'bouchons-dimanche-landquart' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
