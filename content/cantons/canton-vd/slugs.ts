/**
 * Slug per locale degli articoli della sezione canton-vd (Vaud).
 * Scritto da generator/scripts/create-article.mjs --section=canton-vd.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'cdhr-frontalieri-vaud-2026': { it: 'cdhr-frontalieri-vaud-2026', en: 'cdhr-when-french-cross-border-workers-pay-the-95-advance-payment', de: 'cdhr-wann-franzosische-grenzganger-die-vorauszahlung-von-95-leisten', fr: 'cdhr-quand-les-frontaliers-francais-paient-l-acompte-de-95' },
 'vaud-revision-bouclier-fiscal-2024': { it: 'vaud-revision-bouclier-fiscal-2024', en: 'vaud-tax-shield-revision-2024', de: 'waadt-steuerbremse-revision-2024', fr: 'vaud-la-droite-relance-le-bouclier-fiscal' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
