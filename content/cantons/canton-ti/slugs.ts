/**
 * Slug per locale degli articoli della sezione canton-ti (Ticino).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ti.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'a2-mendrisio-melano-risanamento': { it: 'a2-mendrisio-melano-risanamento', en: 'a2-mendrisio-melano-renovation', de: 'a2-mendrisio-melano-sanierung', fr: 'a2-mendrisio-melano-renovation' },
 'scambio-dati-salariali-2027': { it: 'scambio-dati-salariali-2027', en: 'salary-data-exchange-2027', de: 'lohndatenaustausch-2027', fr: 'echange-donnees-salaires-2027' },
 'decreto-tassa-salute-frontalieri-pubblicato-via-libera-regioni': { it: 'decreto-tassa-salute-frontalieri-pubblicato-via-libera-regioni', en: 'healthcare-tax-decree-for-cross-border-workers-approved', de: 'gesundheitsabgabe-fur-grenzganger-dekret-publiziert', fr: 'decret-sur-la-taxe-sante-des-frontaliers-publie-feu-vert-des-regions' },
 'capitale-lpp-rimborso-imposta-fonte': { it: 'capitale-lpp-rimborso-imposta-fonte', en: 'lpp-capital-withholding-tax-refund', de: 'lpp-kapital-quellensteuer-rueckerstattung', fr: 'capital-lpp-remboursement-impot-source' },
 'autobus-elettrici-mendrisiotto-amsa': { it: 'autobus-elettrici-mendrisiotto-amsa', en: 'electric-buses-mendrisiotto-amsa', de: 'elektrobusse-mendrisiotto-amsa', fr: 'bus-electriques-mendrisiotto-amsa' },
 'nuovi-spazi-ambulatoriali-bellinzona': { it: 'nuovi-spazi-ambulatoriali-bellinzona', en: 'new-outpatient-spaces-bellinzona', de: 'neue-ambulante-raeume-bellinzona', fr: 'nouveaux-espaces-ambulatoires-bellinzona' },
 'frontalieri-disoccupazione-criterio-lavoro': { it: 'frontalieri-disoccupazione-criterio-lavoro', en: 'cross-border-unemployment-work-country-criterion', de: 'grenzgaenger-arbeitslosigkeit-arbeitsstaat-kriterium', fr: 'frontaliers-chomage-criteret-pays-travail' },
 'uscita-svizzera-schengen-controlli': { it: 'uscita-svizzera-schengen-controlli', en: 'switzerland-exit-schengen-border-controls', de: 'schweiz-schengen-austritt-grenzkontrollen', fr: 'suisse-sortie-schengen-controles-frontaliers' },
 'sala-risveglio-bellinzona': { it: 'sala-risveglio-bellinzona', en: 'bellinzona-recovery-room', de: 'aufwachraum-bellinzona', fr: 'salle-reveil-bellinzona' },
 'commissione-scuola-ticino': { it: 'commissione-scuola-ticino', en: 'ticino-school-commission-hearing', de: 'tessin-schulkommission-anhoerung', fr: 'commission-ecole-tessin-audition' },
 'gottardo-quadri-cupra-berna': { it: 'gottardo-quadri-cupra-berna', en: 'gottardo-quadri-questions-bern-about-cupra', de: 'gotthard-quadri-befragt-bern-zur-cupra', fr: 'gothard-quadri-interroge-berne-sur-la-cupra' },
 'sovranita-fiscale-accordo-ue': { it: 'sovranita-fiscale-accordo-ue', en: 'fiscal-sovereignty-eu-agreement', de: 'steuerhoheit-eu-abkommen', fr: 'souverainete-fiscale-accord-ue' },
 'frontalieri-tassa-salute-omnibus-giugno-2026': { it: 'frontalieri-tassa-salute-omnibus-giugno-2026', en: 'commuters-health-tax-omnibus-june-2026', de: 'grenzganger-gesundheit-steuer-omnibus-juni-2026', fr: 'frontaliers-taxe-sante-omnibus-juin-2026' },
 'multa-rifiuti-bizzarone': { it: 'multa-rifiuti-bizzarone', en: 'bizzarone-waste-dumping-fine', de: 'busse-fuer-abfall-in-bizzarone', fr: 'amende-dechets-bizzarone' },
 'radar-ticino-ottobre-2026': { it: 'radar-ticino-ottobre-2026', en: 'radar-ticino-october-2026', de: 'radar-tessin-oktober-2026', fr: 'radar-tessin-octobre-2026' },
 'mozione-gran-consiglio-tassa-salute': { it: 'mozione-gran-consiglio-tassa-salute', en: 'grand-council-motion-health-tax', de: 'grossrat-moeglicherweise-gesundheitssteuer', fr: 'motion-grand-conseil-taxe-sante' },
 'rapporto-consiglio-federale-schengen': { it: 'rapporto-consiglio-federale-schengen', en: 'federal-council-schengen-report', de: 'bundesrat-schengen-bericht', fr: 'rapport-conseil-federal-schengen' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
