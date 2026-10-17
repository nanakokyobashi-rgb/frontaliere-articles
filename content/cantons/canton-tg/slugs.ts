/**
 * Slug per locale degli articoli della sezione canton-tg (Turgovia).
 * Scritto da generator/scripts/create-article.mjs --section=canton-tg.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'baugesuch-juchstrasse-frauenfeld': { it: 'baugesuch-juchstrasse-frauenfeld', en: 'frauenfeld-building-application-juchstrasse', de: 'baugesuch-frauenfeld-juchstrasse', fr: 'demande-construction-frauenfeld-juchstrasse' },
 'rapporti-thurmed-turgovia': { it: 'rapporti-thurmed-turgovia', en: 'thurmed-thurgau-reports', de: 'thurmed-berichte-thurgau', fr: 'rapports-thurmed-thurgovie' },
 'chiusura-strada-kesswil': { it: 'chiusura-strada-kesswil', en: 'kesswil-road-closure-october-2026', de: 'strassensperrung-kesswil-oktober-2026', fr: 'fermeture-route-kesswil-octobre-2026' },
 'turgovia-occupazione-rav-settembre': { it: 'turgovia-occupazione-rav-settembre', en: 'thurgau-employment-rav-september', de: 'thurgau-arbeitsmarkt-rav-september', fr: 'thurgovie-emploi-rav-septembre' },
 'aadorf-spese-sociali-2027': { it: 'aadorf-spese-sociali-2027', en: 'aadorf-social-costs-2027', de: 'aadorf-sozialausgaben-2027', fr: 'aadorf-depenses-sociales-2027' },
 'sicurezza-lavoro-turgovia-regole': { it: 'sicurezza-lavoro-turgovia-regole', en: 'workplace-safety-thurgau-rules', de: 'arbeitssicherheit-turgau-regeln', fr: 'securite-travail-thurgovie-regles' },
 'servizi-imprese-turgovia-rav': { it: 'servizi-imprese-turgovia-rav', en: 'thurgau-employer-support-permits', de: 'thurgau-arbeitgeber-rav-bewilligungen', fr: 'thurgovie-services-employeurs-permis' },
 'sportello-digitale-turgovia': { it: 'sportello-digitale-turgovia', en: 'thurgau-digital-counter', de: 'digitaler-schalter-thurgau', fr: 'guichet-numerique-thurgovie' },
 'kreuzlingen-barenplatz-chilbi': { it: 'kreuzlingen-barenplatz-chilbi', en: 'kreuzlingen-barenplatz-fair', de: 'kreuzlingen-barenplatz-wegen-messe-geschlossen', fr: 'kreuzlingen-barenplatz-fete' },
 'turgovia-sicurezza-lavoro-orari': { it: 'turgovia-sicurezza-lavoro-orari', en: 'thurgovia-workplace-safety-hours', de: 'turgau-arbeitssicherheit-arbeitszeiten', fr: 'thurgovie-securite-travail-horaires' },
 'tredicesima-rendita-avs-2026': { it: 'tredicesima-rendita-avs-2026', en: 'thirteenth-ahv-pension-2026', de: 'dreizehnte-ahv-rente-2026', fr: 'treizieme-rente-avs-2026' },
 'eventi-weekend-turgovia': { it: 'eventi-weekend-turgovia', en: 'weekend-events-thurgau', de: 'wochenend-veranstaltungen-thurgau', fr: 'evenements-week-end-thurgovie' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
