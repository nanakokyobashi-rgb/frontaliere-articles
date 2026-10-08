/**
 * Slug per locale degli articoli della sezione canton-appenzello (Appenzello).
 * Scritto da generator/scripts/create-article.mjs --section=canton-appenzello.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'lavoro-ar-rav-settembre-2026': { it: 'lavoro-ar-rav-settembre-2026', en: 'appenzell-ausserrhoden-rav-september-2026', de: 'arbeitslosenstatistik-ar-september-2026', fr: 'chomage-ar-septembre-2026' },
 'heiden-tassa-base-rifiuti': { it: 'heiden-tassa-base-rifiuti', en: 'heiden-base-waste-fee', de: 'heiden-kehrichtgrundgebuehr', fr: 'heiden-taxe-base-dechets' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
