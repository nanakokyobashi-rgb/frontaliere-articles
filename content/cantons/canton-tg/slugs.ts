/**
 * Slug per locale degli articoli della sezione canton-tg (Turgovia).
 * Scritto da generator/scripts/create-article.mjs --section=canton-tg.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'baugesuch-juchstrasse-frauenfeld': { it: 'baugesuch-juchstrasse-frauenfeld', en: 'frauenfeld-building-application-juchstrasse', de: 'baugesuch-frauenfeld-juchstrasse', fr: 'demande-construction-frauenfeld-juchstrasse' },
 'rapporti-thurmed-turgovia': { it: 'rapporti-thurmed-turgovia', en: 'thurmed-thurgau-reports', de: 'thurmed-berichte-thurgau', fr: 'rapports-thurmed-thurgovie' },
 'chiusura-strada-kesswil': { it: 'chiusura-strada-kesswil', en: 'kesswil-road-closure-october-2026', de: 'strassensperrung-kesswil-oktober-2026', fr: 'fermeture-route-kesswil-octobre-2026' },
 'turgovia-occupazione-rav-settembre': { it: 'turgovia-occupazione-rav-settembre', en: 'thurgau-employment-rav-september', de: 'thurgau-arbeitsmarkt-rav-september', fr: 'thurgovie-emploi-rav-septembre' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
