/**
 * Slug per locale degli articoli della sezione canton-gl (Glarona).
 * Scritto da generator/scripts/create-article.mjs --section=canton-gl.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'revisione-fiscale-canton-glarona': { it: 'revisione-fiscale-canton-glarona', en: 'tax-law-amendment-canton-glarus', de: 'steuergesetz-aenderung-kanton-glarus', fr: 'modification-de-la-loi-fiscale-canton-de-glaris' },
 'premi-standard-glarona': { it: 'premi-standard-glarona', en: 'glarner-lowest-standard-premiums', de: 'glarner-guenstigste-standardpraemien', fr: 'glarner-primes-standard-basses' },
 'imposta-seconde-case-glarona': { it: 'imposta-seconde-case-glarona', en: 'secondary-homes-tax-glarus', de: 'zweitwohnungssteuer-glarus', fr: 'taxe-residences-secondaires-glaris' },
 'klontalstrasse-staldengarten-butzi': { it: 'klontalstrasse-staldengarten-butzi', en: 'klontalstrasse-traffic-restriction', de: 'verkehrseinschraenkung-kloentalerstrasse', fr: 'restriction-trafic-kloentalerstrasse' },
 'eventi-weekend-glarona': { it: 'eventi-weekend-glarona', en: 'weekend-events-glarus', de: 'wochenend-veranstaltungen-glarus', fr: 'evenements-week-end-glaris' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
