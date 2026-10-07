/**
 * Slug per locale degli articoli della sezione canton-lu (Lucerna).
 * Scritto da generator/scripts/create-article.mjs --section=canton-lu.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'lucerna-salute-mentale-banchi': { it: 'lucerna-salute-mentale-banchi', en: 'lucerne-mental-health-benches', de: 'luzern-psychische-gesundheit-baenke', fr: 'lucerne-sante-mentale-bancs' },
 'lucerna-qualita-sviluppo-scuole': { it: 'lucerna-qualita-sviluppo-scuole', en: 'lucerne-school-quality-development', de: 'luzern-schulqualitaet-entwicklung', fr: 'lucerne-qualite-developpement-scolaire' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
