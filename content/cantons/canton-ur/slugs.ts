/**
 * Slug per locale degli articoli della sezione canton-ur (Uri).
 * Scritto da generator/scripts/create-article.mjs --section=canton-ur.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'uri-misure-energia-clima': { it: 'uri-misure-energia-clima', en: 'uri-energy-measures-climate', de: 'uri-energiemassnahmen-klimaschutz', fr: 'uri-mesures-energetiques-climat' },
 'uri-chiusura-passhoehe': { it: 'uri-chiusura-passhoehe', en: 'uri-night-road-closure', de: 'uri-nachtsperrung-passhoehe', fr: 'uri-fermeture-nocturne-route' },
 'uri-budget-avanzo-2027': { it: 'uri-budget-avanzo-2027', en: 'uri-budget-surplus-2027', de: 'uri-budget-ueberschuss-2027', fr: 'budget-uri-excedent-2027' },
 'uri-budget-2027-surplus': { it: 'uri-budget-2027-surplus', en: 'uri-2027-budget-with-a-surplus-of-chf-1-1-million', de: 'uri-budget-2027-ueberschuss', fr: 'uri-budget-2027-excedent' },
 'eventi-weekend-uri': { it: 'eventi-weekend-uri', en: 'weekend-events-uri', de: 'wochenend-veranstaltungen-uri', fr: 'evenements-week-end-uri' },
 'silenen-muri-secco': { it: 'silenen-muri-secco', en: 'silenen-dry-stone-walls', de: 'silenen-trockenmauern-sanierung', fr: 'silenen-murs-pierre-seche' },
 'axenstrasse-chiusa-quattro-notti': { it: 'axenstrasse-chiusa-quattro-notti', en: 'axenstrasse-closed-four-nights', de: 'axenstrasse-vier-naechte-gesperrt', fr: 'axenstrasse-fermee-quatre-nuits' },
 'bristenstrasse-regimi-traffico-2026': { it: 'bristenstrasse-regimi-traffico-2026', en: 'bristenstrasse-traffic-rules-2026', de: 'bristenstrasse-verkehrsregime-2026', fr: 'bristenstrasse-regimes-circulation-2026' },
 'andermatt-fisco-wyden': { it: 'andermatt-fisco-wyden', en: 'andermatt-tax-wyden-postponed', de: 'andermatt-steuern-wyden', fr: 'andermatt-impots-wyden' },
 'felix-gisler-pensione-uri': { it: 'felix-gisler-pensione-uri', en: 'felix-gisler-uri-retirement', de: 'felix-gisler-uri-pensionierung', fr: 'felix-gisler-uri-retraite' },
 'axenstrasse-chiusa-novembre-2026': { it: 'axenstrasse-chiusa-novembre-2026', en: 'axenstrasse-closed-november-2026', de: 'axenstrasse-geschlossen-november-2026', fr: 'axenstrasse-fermee-novembre-2026' },
 'conteggio-traffico-uri-novembre': { it: 'conteggio-traffico-uri-novembre', en: 'uri-traffic-count-november', de: 'verkehrszaehlung-uri-november', fr: 'comptage-trafic-uri-novembre' },
 'susten-furka-chiusura-invernale': { it: 'susten-furka-chiusura-invernale', en: 'susten-furka-winter-closure', de: 'susten-furka-wintersperre', fr: 'fermeture-hivernale-susten-furka' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
