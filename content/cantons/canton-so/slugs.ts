/**
 * Slug per locale degli articoli della sezione canton-so (Soletta).
 * Scritto da generator/scripts/create-article.mjs --section=canton-so.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'soletta-disoccupazione-settembre': { it: 'soletta-disoccupazione-settembre', en: 'solothurn-unemployment-september-2026', de: 'arbeitslosenquote-solothurn-september-2026', fr: 'chomage-soleure-septembre-2026' },
 'premi-malattia-soletta-2027': { it: 'premi-malattia-soletta-2027', en: 'solothurn-health-premiums-2027', de: 'solothurn-krankenkassenpraemien-2027', fr: 'primes-maladie-soleure-2027' },
 'luterbach-a5-rampe-notte': { it: 'luterbach-a5-rampe-notte', en: 'luterbach-a5-night-ramps', de: 'luterbach-a5-nachtsperren', fr: 'luterbach-a5-rampes-nuit' },
 'soletta-progetti-trasporto-governo': { it: 'soletta-progetti-trasporto-governo', en: 'solothurn-transport-projects-government', de: 'solothurn-verkehrsprojekte-regierung', fr: 'soleure-projets-transport-gouvernement' },
 'solothurn-pneumonia-suini': { it: 'solothurn-pneumonia-suini', en: 'solothurn-pig-pneumonia-cull', de: 'solothurn-schweinepneumonie-keulung', fr: 'soleure-pneumonie-porcine-abattage' },
 'furti-raggiro-soletta': { it: 'furti-raggiro-soletta', en: 'solothurn-trick-thefts-warning', de: 'solothurn-warnung-trickdiebstahle', fr: 'soleure-alerte-vols-par-ruse' },
 'soletta-parlamento-budget-2027-inchiesta-soh': { it: 'soletta-parlamento-budget-2027-inchiesta-soh', en: 'solothurn-parliament-budget-2027-soh-investigation', de: 'solothurn-parlament-budget-2027-untersuchung-soh', fr: 'soleure-parlement-budget-2027-enquete-soh' },
 'governo-soletta-ottobre-2026': { it: 'governo-soletta-ottobre-2026', en: 'solothurn-government-october-2026', de: 'solothurn-regierungsrat-oktober-2026', fr: 'gouvernement-soleure-octobre-2026' },
 'soletta-regierungsrat-attiparlamentari-2026': { it: 'soletta-regierungsrat-attiparlamentari-2026', en: 'solothurn-regierungsrat-parliamentary-items-october-2026', de: 'solothurn-regierungsrat-geschaefte-oktober-2026', fr: 'soleure-conseil-executif-objets-parlementaires-octobre-2026' },
 'a1-lavori-notturni-luterbach': { it: 'a1-lavori-notturni-luterbach', en: 'a1-night-work-luterbach', de: 'a1-nachtarbeiten-luterbach', fr: 'a1-travaux-nocturnes-luterbach' },
 'cambio-ora-incidenti-stradali-soletta': { it: 'cambio-ora-incidenti-stradali-soletta', en: 'time-change-road-accidents-solothurn', de: 'zeitumstellung-strassenunfaelle-solothurn', fr: 'changement-heure-accidents-route-soleure' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
