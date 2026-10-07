/**
 * Slug per locale degli articoli della sezione canton-ag (Argovia).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ag.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'argovia-disoccupazione-settembre': { it: 'argovia-disoccupazione-settembre', en: 'aargau-unemployment-september-2026', de: 'aargau-arbeitslosigkeit-september-2026', fr: 'argovie-chomage-septembre-2026' },
 'riduzione-premi-argovia-2027': { it: 'riduzione-premi-argovia-2027', en: 'aargau-premium-reduction-2027', de: 'praemienverbilligung-aargau-2027', fr: 'reduction-primes-argovie-2027' },
 'argovia-parita-salariale': { it: 'argovia-parita-salariale', en: 'aargau-pay-equality', de: 'aargau-lohngleichheit', fr: 'argovie-egalite-salariale' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
