/**
 * Slug per locale degli articoli della sezione canton-fr (Friburgo).
 * Scritto da generator/scripts/create-article.mjs --section=canton-fr.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'disoccupazione-friburgo-settembre-2026': { it: 'disoccupazione-friburgo-settembre-2026', en: 'unemployment-in-fribourg-falls-to-2-5-in-september-2026', de: 'arbeitslosigkeit-in-freiburg-sinkt-im-september-2026-auf-2-5', fr: 'le-chomage-a-fribourg-baisse-a-2-5-en-septembre-2026' },
 'fribourg-modifica-licd': { it: 'fribourg-modifica-licd', en: 'fribourg-adjusts-direct-taxes-for-bracket-creep', de: 'freiburg-passt-die-direkten-steuern-an-die-kalte-progression-an', fr: 'fribourg-adapte-les-impots-directs-a-la-progression-a-froid' },
 'nuovo-piano-ciclabile-friburgo': { it: 'nuovo-piano-ciclabile-friburgo', en: 'fribourg-new-bicycle-network-plan', de: 'freiburg-neuer-velowegnetzplan', fr: 'fribourg-nouveau-plan-reseau-cyclable' },
 'friburgo-legge-lingue-ufficiali': { it: 'friburgo-legge-lingue-ufficiali', en: 'fribourg-official-languages-law', de: 'freiburg-amtssprachen-gesetz', fr: 'fribourg-loi-langues-officielles' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
