/**
 * Slug per locale degli articoli della sezione canton-so (Soletta).
 * Scritto da generator/scripts/create-article.mjs --section=canton-so.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'soletta-disoccupazione-settembre': { it: 'soletta-disoccupazione-settembre', en: 'solothurn-unemployment-september-2026', de: 'arbeitslosenquote-solothurn-september-2026', fr: 'chomage-soleure-septembre-2026' },
 'premi-malattia-soletta-2027': { it: 'premi-malattia-soletta-2027', en: 'solothurn-health-premiums-2027', de: 'solothurn-krankenkassenpraemien-2027', fr: 'primes-maladie-soleure-2027' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
