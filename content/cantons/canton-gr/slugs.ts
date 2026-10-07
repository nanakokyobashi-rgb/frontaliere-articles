/**
 * Slug per locale degli articoli della sezione canton-gr (Grigioni).
 * Scritto da generator/scripts/create-article.mjs --section=canton-gr.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'strada-calanca-chiusura-preventiva': { it: 'strada-calanca-chiusura-preventiva', en: 'calanca-road-preventive-closure', de: 'calancastrasse-praventive-sperrung', fr: 'route-calanca-fermeture-preventive' },
 'benzina-grigioni-deviazione': { it: 'benzina-grigioni-deviazione', en: 'graubuenden-fuel-detour', de: 'graubuenden-tankrechner-umweg', fr: 'grisons-carburant-detour' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
