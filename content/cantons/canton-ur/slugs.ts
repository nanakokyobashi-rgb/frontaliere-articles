/**
 * Slug per locale degli articoli della sezione canton-ur (Uri).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ur.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'uri-misure-energia-clima': { it: 'uri-misure-energia-clima', en: 'uri-energy-measures-climate', de: 'uri-energiemassnahmen-klimaschutz', fr: 'uri-mesures-energetiques-climat' },
 'uri-chiusura-passhoehe': { it: 'uri-chiusura-passhoehe', en: 'uri-night-road-closure', de: 'uri-nachtsperrung-passhoehe', fr: 'uri-fermeture-nocturne-route' },
 'uri-budget-avanzo-2027': { it: 'uri-budget-avanzo-2027', en: 'uri-budget-surplus-2027', de: 'uri-budget-ueberschuss-2027', fr: 'budget-uri-excedent-2027' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
