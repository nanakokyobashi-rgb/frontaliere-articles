/**
 * Slug per locale degli articoli della sezione canton-zg (Zugo).
 * Scritto da generator/scripts/create-article.mjs --section=canton-zg.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'zugo-bilancio-2027-avanzzo-15-6-milioni-tasso-52': { it: 'zugo-bilancio-2027-avanzzo-15-6-milioni-tasso-52', en: 'zug-forecasts-a-surplus-of-15-6-million-in-2027-with-the-tax-rate-at-52', de: 'zug-erwartet-2027-bei-einem-steuerfuss-von-52-einen-uberschuss-von-15-6', fr: 'zoug-prevoit-un-excedent-de-15-6-millions-en-2027-avec-un-taux-a-52' },
 'zug-rischio-coleottero-giapponese': { it: 'zug-rischio-coleottero-giapponese', en: 'zug-japanese-beetle-risk', de: 'zug-risiko-japankaefer', fr: 'zug-risque-scarabee-japonais' },
 'baar-rinnovo-comunale-2027': { it: 'baar-rinnovo-comunale-2027', en: 'baar-municipal-council-renewal', de: 'baar-erneuerung-gemeinderat', fr: 'baar-renouvellement-conseil' },
 'scuola-sternmatt-ia-2026': { it: 'scuola-sternmatt-ia-2026', en: 'sternmatt-school-ai-2026', de: 'sternmatt-schule-ki-2026', fr: 'ecole-sternmatt-ia-2026' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
