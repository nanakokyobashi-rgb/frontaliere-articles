/**
 * Slug per locale degli articoli della sezione canton-nw (Nidvaldo).
 * Scritto da generator/scripts/create-article.mjs --section=canton-nw.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'lopper-luce-pedoni-bici': { it: 'lopper-luce-pedoni-bici', en: 'lopper-path-lighting', de: 'lopper-wegbeleuchtung', fr: 'eclairage-piste-lopper' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
