/**
 * Slug per locale degli articoli della sezione canton-sh (Sciaffusa).
 * Scritto da generator/scripts/create-article.mjs --section=canton-sh.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'esplosione-bancomat-thayngen': { it: 'esplosione-bancomat-thayngen', en: 'thayngen-atm-explosion', de: 'thayngen-geldautomat-gesprengt', fr: 'thayngen-distributeur-explose' },
 'sciaffusa-formazione-farmacie': { it: 'sciaffusa-formazione-farmacie', en: 'schaffhausen-pharmacy-training', de: 'schaffhausen-apotheken-schulung', fr: 'schaffhouse-formation-pharmacies' },
 'seehas-affollamento-mattutino': { it: 'seehas-affollamento-mattutino', en: 'more-crowded-seehas-and-longer-journeys-on-the-konstanz-singen-line', de: 'starker-ausgelasteter-seehas-und-langere-fahrten-auf-der-strecke-konstanz-singen', fr: 'seehas-plus-charge-et-trajets-plus-longs-sur-la-ligne-konstanz-singen' },
 'sciaffusa-dati-lavoro-2026': { it: 'sciaffusa-dati-lavoro-2026', en: 'schaffhausen-unemployment-september-2026', de: 'schaffhausen-arbeitslosigkeit-september-2026', fr: 'schaffhouse-chomage-septembre-2026' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
