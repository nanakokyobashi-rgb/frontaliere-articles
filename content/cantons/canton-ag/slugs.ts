/**
 * Slug per locale degli articoli della sezione canton-ag (Argovia).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ag.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'argovia-disoccupazione-settembre': { it: 'argovia-disoccupazione-settembre', en: 'aargau-unemployment-september-2026', de: 'aargau-arbeitslosigkeit-september-2026', fr: 'argovie-chomage-septembre-2026' },
 'riduzione-premi-argovia-2027': { it: 'riduzione-premi-argovia-2027', en: 'aargau-premium-reduction-2027', de: 'praemienverbilligung-aargau-2027', fr: 'reduction-primes-argovie-2027' },
 'argovia-parita-salariale': { it: 'argovia-parita-salariale', en: 'aargau-pay-equality', de: 'aargau-lohngleichheit', fr: 'argovie-egalite-salariale' },
 'chiusura-hochrheinbahn-2026': { it: 'chiusura-hochrheinbahn-2026', en: 'hochrheinbahn-basel-rheinfelden-closure-2026', de: 'hochrheinbahn-streckensperrung-2026', fr: 'fermeture-hochrheinbahn-bale-rheinfelden-2026' },
 'obermumpf-strada-sanificazione-2024': { it: 'obermumpf-strada-sanificazione-2024', en: 'obermumpf-construction-work-on-the-k491-until-autumn-2027', de: 'obermumpf-bauarbeiten-an-der-k491-bis-herbst-2027', fr: 'obermumpf-travaux-sur-la-k491-jusqu-a-l-automne-2027' },
 'buchs-deficit-2027-budget': { it: 'buchs-deficit-2027-budget', en: 'buchs-forecasts-a-3-1-million-deficit-in-the-2027-budget', de: 'buchs-rechnet-im-budget-2027-mit-einem-defizit-von-3-1-millionen', fr: 'buchs-prevoit-un-deficit-de-3-1-millions-dans-le-budget-2027' },
 'aargau-pfas-bonifiche-incerte': { it: 'aargau-pfas-bonifiche-incerte', en: 'aargau-pfas-site-costs', de: 'aargau-pfas-standorte-kosten', fr: 'argovie-sites-pfas-couts' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
