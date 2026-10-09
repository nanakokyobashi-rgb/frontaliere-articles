/**
 * Slug per locale degli articoli della sezione canton-be (Berna).
 * Scritto da generator/scripts/create-article.mjs --section=canton-be.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'simplificazione-imposta-trasferimento-berna': { it: 'simplificazione-imposta-trasferimento-berna', en: 'berns-transfer-tax-simplification', de: 'berner-handaenderungssteuer-vereinfachung', fr: 'simplification-impot-transfer-berne' },
 'wabern-tram-risanamento': { it: 'wabern-tram-risanamento', en: 'kleinwabern-tram-wabern-renovation', de: 'tram-kleinwabern-sanierung-wabern', fr: 'tram-kleinwabern-renovation-wabern' },
 'disoccupazione-berna-settembre-2026-stabile': { it: 'disoccupazione-berna-settembre-2026-stabile', en: 'unemployment-steady-in-bern-in-september-2026-78-people', de: 'arbeitslosigkeit-in-bern-im-september-2026-stabil-78-personen', fr: 'chomage-stable-a-berne-en-septembre-2026-78-personnes' },
 'ipsach-gru-linea-strada': { it: 'ipsach-gru-linea-strada', en: 'ipsach-crane-railway-road', de: 'ipsach-arbeitskran-bahnstrasse', fr: 'ipsach-grue-voie-route' },
 'berna-familiari-curanti-incontro': { it: 'berna-familiari-curanti-incontro', en: 'bern-caregiving-relatives-meeting', de: 'bern-pflegende-angehoerige-treffen', fr: 'berne-proches-aidants-rencontre' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
