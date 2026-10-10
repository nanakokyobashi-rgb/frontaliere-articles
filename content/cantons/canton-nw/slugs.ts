/**
 * Slug per locale degli articoli della sezione canton-nw (Nidvaldo).
 * Scritto da generator/scripts/create-article.mjs --section=canton-nw.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'lopper-luce-pedoni-bici': { it: 'lopper-luce-pedoni-bici', en: 'lopper-path-lighting', de: 'lopper-wegbeleuchtung', fr: 'eclairage-piste-lopper' },
 'postauto-orario-nidvaldo-2026': { it: 'postauto-orario-nidvaldo-2026', en: 'postauto-timetable-change-nidwalden-2026', de: 'postauto-fahrplanwechsel-nidwalden-2026', fr: 'changement-horaire-postauto-nidwald-2026' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
