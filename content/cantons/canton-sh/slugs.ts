/**
 * Slug per locale degli articoli della sezione canton-sh (Sciaffusa).
 * Scritto da generator/scripts/create-article.mjs --section=canton-sh.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'esplosione-bancomat-thayngen': { it: 'esplosione-bancomat-thayngen', en: 'thayngen-atm-explosion', de: 'thayngen-geldautomat-gesprengt', fr: 'thayngen-distributeur-explose' },
 'sciaffusa-formazione-farmacie': { it: 'sciaffusa-formazione-farmacie', en: 'schaffhausen-pharmacy-training', de: 'schaffhausen-apotheken-schulung', fr: 'schaffhouse-formation-pharmacies' },
 'seehas-affollamento-mattutino': { it: 'seehas-affollamento-mattutino', en: 'more-crowded-seehas-and-longer-journeys-on-the-konstanz-singen-line', de: 'starker-ausgelasteter-seehas-und-langere-fahrten-auf-der-strecke-konstanz-singen', fr: 'seehas-plus-charge-et-trajets-plus-longs-sur-la-ligne-konstanz-singen' },
 'sciaffusa-dati-lavoro-2026': { it: 'sciaffusa-dati-lavoro-2026', en: 'schaffhausen-unemployment-september-2026', de: 'schaffhausen-arbeitslosigkeit-september-2026', fr: 'schaffhouse-chomage-septembre-2026' },
 'finanze-cantone-sciaffusa-2027': { it: 'finanze-cantone-sciaffusa-2027', en: 'schaffhausen-canton-finances-2027', de: 'finanzen-kanton-schaffhausen-2027', fr: 'finances-canton-schaffhouse-2027' },
 'singen-chiusura-schaffhauser-strasse': { it: 'singen-chiusura-schaffhauser-strasse', en: 'singen-schaffhauser-strasse-closure', de: 'singen-sperrung-schaffhauser-strasse', fr: 'singen-fermeture-schaffhauser-strasse' },
 'eventi-weekend-sciaffusa': { it: 'eventi-weekend-sciaffusa', en: 'weekend-events-schaffhausen', de: 'wochenend-veranstaltungen-schaffhausen', fr: 'evenements-week-end-schaffhouse' },
 'treni-zurigo-stoccarda': { it: 'treni-zurigo-stoccarda', en: 'zurich-stuttgart-trains', de: 'zuerich-stuttgart-zuege', fr: 'trains-zurich-stuttgart' },
 'pulizie-tunnel-sciaffusa': { it: 'pulizie-tunnel-sciaffusa', en: 'schaffhausen-tunnel-cleaning', de: 'naechtliche-tunnelreinigung-schaffhausen', fr: 'nettoyage-tunnels-schaffhouse' },
 'svp-sciaffusa-candidati-2027': { it: 'svp-sciaffusa-candidati-2027', en: 'svp-schaffhausen-candidates-2027', de: 'svp-schaffhausen-kandidaturen-2027', fr: 'svp-schaffhouse-candidatures-2027' },
 'beringen-vbsh-fermate-chiuse': { it: 'beringen-vbsh-fermate-chiuse', en: 'beringen-vbsh-stops-closed', de: 'beringen-vbsh-haltestellen-gesperrt', fr: 'beringen-vbsh-arrets-fermes' },
 'schleitheim-scooter-incidente-2026': { it: 'schleitheim-scooter-incidente-2026', en: 'schleitheim-scooter-accident-2026', de: 'schleitheim-roller-unfall-2026', fr: 'schleitheim-accident-scooter-2026' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
