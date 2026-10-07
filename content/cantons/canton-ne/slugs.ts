/**
 * Slug per locale degli articoli della sezione canton-ne (Neuchâtel).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ne.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'neuchatel-rinnova-politica-abitativa-con-24-milioni': { it: 'neuchatel-rinnova-politica-abitativa-con-24-milioni', en: 'neuchatel-renews-housing-policy-with-24-million', de: 'neuchatel-erneuert-wohnungspolitik-mit-24-millionen', fr: 'neuchatel-renouvelle-sa-politique-du-logement-avec-24-millions' },
 'disoccupazione-stabile-4-4-neuchatel-settembre-2026': { it: 'disoccupazione-stabile-4-4-neuchatel-settembre-2026', en: 'unemployment-stable-at-4-4-neuchatel-september-2026', de: 'arbeitslosigkeit-in-neuchatel-im-september-2026-stabil-bei-4-4', fr: 'chomage-stable-a-4-4-a-neuchatel-en-septembre-2026' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
