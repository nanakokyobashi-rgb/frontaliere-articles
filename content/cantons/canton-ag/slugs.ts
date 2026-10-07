/**
 * Slug per locale degli articoli della sezione canton-ag (Argovia).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ag.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'argovia-disoccupazione-settembre': { it: 'argovia-disoccupazione-settembre', en: 'aargau-unemployment-september-2026', de: 'aargau-arbeitslosigkeit-september-2026', fr: 'argovie-chomage-septembre-2026' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
