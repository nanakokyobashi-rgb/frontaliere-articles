/**
 * Slug per locale degli articoli della sezione canton-ge (Ginevra).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ge.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'economia-ginevrina-ripresa-globale': { it: 'economia-ginevrina-ripresa-globale', en: 'geneva-economy-global-recovery', de: 'genfer-wirtschaft-globale-erholung', fr: 'economie-genevoise-reprise-mondiale' },
 'accordo-cure-oncologiche-ginevra': { it: 'accordo-cure-oncologiche-ginevra', en: 'geneva-france-pediatric-cancer-care', de: 'grenzueberschreitende-kinderkrebsversorgung-genf', fr: 'cooperation-transfrontaliere-cancer-geneve' },
 'salario-minimo-ginevra-2027': { it: 'salario-minimo-ginevra-2027', en: 'geneva-minimum-wage-2027', de: 'mindestlohn-genf-2027', fr: 'salaire-minimum-geneve-2027' },
 'ginevra-stop-autostrada-a412': { it: 'ginevra-stop-autostrada-a412', en: 'geneva-stop-a412-highway', de: 'genf-stopp-autobahn-a412', fr: 'geneve-arret-travaux-a412' },
 'comunicato-consiglio-stato-ginevra': { it: 'comunicato-consiglio-stato-ginevra', en: 'geneva-state-council-communique', de: 'mitteilung-genfer-staatsrat', fr: 'communique-conseil-etat-geneve' },
 'unige-natura-equilibrio-mentale': { it: 'unige-natura-equilibrio-mentale', en: 'unige-nature-mental-wellbeing', de: 'unige-natur-psychisches-wohlbefinden', fr: 'unige-nature-sante-mentale' },
 'cantieri-mobilita-ginevra': { it: 'cantieri-mobilita-ginevra', en: 'geneva-mobility-construction', de: 'genf-mobilitaetsbaustellen', fr: 'chantiers-mobilite-geneve' },
 'indagini-imprese-ginevrine': { it: 'indagini-imprese-ginevrine', en: 'geneva-business-surveys', de: 'konjunkturumfragen-genfer-unternehmen', fr: 'enquetes-conjoncture-entreprises-genevoises' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
