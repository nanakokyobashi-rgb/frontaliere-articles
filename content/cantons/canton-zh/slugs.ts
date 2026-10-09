/**
 * Slug per locale degli articoli della sezione canton-zh (Zurigo).
 * Scritto da generator/scripts/create-article.mjs --section=canton-zh.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'disoccupazione-zurigo-rav-2026': { it: 'disoccupazione-zurigo-rav-2026', en: 'zurich-unemployment-rav-2026', de: 'arbeitslosigkeit-zurich-rav-2026', fr: 'chomage-zurich-rav-2026' },
 'mappa-affitti-zurigo-trasloco': { it: 'mappa-affitti-zurigo-trasloco', en: 'zurich-rent-moving-map', de: 'zuerich-mieten-umzug-karte', fr: 'carte-loyers-zurich-demenagement' },
 'sbb-flotta-zurigo-500m': { it: 'sbb-flotta-zurigo-500m', en: 'sbb-zurich-sbahn-fleet', de: 'sbb-zuercher-sbahn-flotte', fr: 'sbb-flotte-sbahn-zurich' },
 'winterthur-governo-apprendisti': { it: 'winterthur-governo-apprendisti', en: 'winterthur-government-apprentices', de: 'winterthur-regierungsrat-lehrabschluesse', fr: 'winterthur-gouvernement-apprentis' },
 'zurigo-velostrade-scuole': { it: 'zurigo-velostrade-scuole', en: 'zurich-school-bike-routes-ban', de: 'zuerich-veloschnellstrassen-schulen', fr: 'zurich-veloroutes-ecoles' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
