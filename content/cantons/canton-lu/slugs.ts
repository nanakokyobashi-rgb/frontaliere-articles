/**
 * Slug per locale degli articoli della sezione canton-lu (Lucerna).
 * Scritto da generator/scripts/create-article.mjs --section=canton-lu.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'lucerna-salute-mentale-banchi': { it: 'lucerna-salute-mentale-banchi', en: 'lucerne-mental-health-benches', de: 'luzern-psychische-gesundheit-baenke', fr: 'lucerne-sante-mentale-bancs' },
 'lucerna-qualita-sviluppo-scuole': { it: 'lucerna-qualita-sviluppo-scuole', en: 'lucerne-school-quality-development', de: 'luzern-schulqualitaet-entwicklung', fr: 'lucerne-qualite-developpement-scolaire' },
 'kriens-torna-in-deficit': { it: 'kriens-torna-in-deficit', en: 'kriens-returns-to-deficit', de: 'kriens-rutscht-wieder-ins-minus', fr: 'kriens-repasse-dans-le-rouge' },
 'progetto-latte-climatico': { it: 'progetto-latte-climatico', en: 'swiss-milk-climate-project', de: 'schweizer-milch-klimaprojekt', fr: 'projet-lait-climatique-suisse' },
 'riduzione-premi-padre-divorziato-lucerna': { it: 'riduzione-premi-padre-divorziato-lucerna', en: 'premium-reduction-divorced-father-lucerne', de: 'praemienverbilligung-geschiedener-vater-luzern', fr: 'reduction-primes-pere-divorce-lucerne' },
 'juso-lucerna-humbel-governo': { it: 'juso-lucerna-humbel-governo', en: 'juso-lucerne-humbel-government', de: 'juso-luzern-humbel-regierungsrat', fr: 'juso-lucerne-humbel-gouvernement' },
 'prioswiss-ricorso-luks': { it: 'prioswiss-ricorso-luks', en: 'prioswiss-appeal-luks', de: 'prioswiss-berufung-luks', fr: 'prioswiss-recours-luks' },
 'lucerna-forensic-nurses-violenza': { it: 'lucerna-forensic-nurses-violenza', en: 'lucerne-forensic-nurses-domestic-violence', de: 'luzern-forensic-nurses-haeusliche-gewalt', fr: 'lucerne-infirmiers-medico-legaux-violence-domestique' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
