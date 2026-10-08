/**
 * Slug per locale degli articoli della sezione canton-ti (Ticino).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ti.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'a2-mendrisio-melano-risanamento': { it: 'a2-mendrisio-melano-risanamento', en: 'a2-mendrisio-melano-renovation', de: 'a2-mendrisio-melano-sanierung', fr: 'a2-mendrisio-melano-renovation' },
 'scambio-dati-salariali-2027': { it: 'scambio-dati-salariali-2027', en: 'salary-data-exchange-2027', de: 'lohndatenaustausch-2027', fr: 'echange-donnees-salaires-2027' },
 'decreto-tassa-salute-frontalieri-pubblicato-via-libera-regioni': { it: 'decreto-tassa-salute-frontalieri-pubblicato-via-libera-regioni', en: 'healthcare-tax-decree-for-cross-border-workers-approved', de: 'gesundheitsabgabe-fur-grenzganger-dekret-publiziert', fr: 'decret-sur-la-taxe-sante-des-frontaliers-publie-feu-vert-des-regions' },
 'capitale-lpp-rimborso-imposta-fonte': { it: 'capitale-lpp-rimborso-imposta-fonte', en: 'lpp-capital-withholding-tax-refund', de: 'lpp-kapital-quellensteuer-rueckerstattung', fr: 'capital-lpp-remboursement-impot-source' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
