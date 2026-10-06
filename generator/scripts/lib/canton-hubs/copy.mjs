/**
 * copy.mjs — l'intro EVERGREEN di ogni hub (cantone, tema) nelle 4 locali.
 *
 * Template deterministico, nessun LLM: il testo dipende solo da dati stabili
 * e committati — la locuzione di luogo del cantone, i Paesi confinanti
 * (`canton-hub-topics.json`) e le lingue ufficiali del profilo
 * (`canton-sections.json`). Non contiene cifre: quelle stanno nei fatti chiave
 * e nei blocchi, ciascuna con fonte e data. Per questo l'intro non cambia
 * quando un dataset manca o si aggiorna, e l'hub resta sopra le 50 parole
 * reali che il renderer pretende anche senza un solo blocco dati.
 *
 * Il nome del cantone compare solo dentro la locuzione «in <cantone>»
 * (`place`): italiano, tedesco e francese legano articoli e preposizioni al
 * nome (nei Grigioni, im Aargau, aux Grisons) e un template non li indovina
 * per 24 gruppi. La tabella e' quella dei digest eventi cantonali, una sola.
 */
import { CANTON_DIGEST_ARTICLES } from '../events-digest-content.mjs';
import { findForeignCantonToponyms } from '../cantone-toponimi-coerenza.mjs';
import { HUB_LOCALES, joinList } from './format.mjs';

/** Il Ticino non e' in `CANTON_DIGEST_ARTICLES` (il suo digest e' quello storico). */
const TICINO_PLACE = Object.freeze({ it: 'in Ticino', en: 'in Ticino', de: 'im Tessin', fr: 'au Tessin' });

/** «in <cantone>» per locale; lancia su un gruppo senza locuzione. */
export function cantonPlace(canton, locale) {
  const place = canton === 'TI' ? TICINO_PLACE : CANTON_DIGEST_ARTICLES[canton]?.place;
  const value = place?.[locale];
  if (typeof value !== 'string' || !value) throw new Error(`canton-hubs: locuzione di luogo mancante per ${canton}/${locale}`);
  return value;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const COUNTRY = {
  it: { IT: 'l’Italia', FR: 'la Francia', DE: 'la Germania', AT: 'l’Austria', LI: 'il Liechtenstein' },
  en: { IT: 'Italy', FR: 'France', DE: 'Germany', AT: 'Austria', LI: 'Liechtenstein' },
  de: { IT: 'Italien', FR: 'Frankreich', DE: 'Deutschland', AT: 'Österreich', LI: 'Liechtenstein' },
  fr: { IT: 'l’Italie', FR: 'la France', DE: 'l’Allemagne', AT: 'l’Autriche', LI: 'le Liechtenstein' },
};

const LANGUAGE = {
  it: { it: 'italiano', de: 'tedesco', fr: 'francese', rm: 'romancio', en: 'inglese' },
  en: { it: 'Italian', de: 'German', fr: 'French', rm: 'Romansh', en: 'English' },
  de: { it: 'Italienisch', de: 'Deutsch', fr: 'Französisch', rm: 'Rätoromanisch', en: 'Englisch' },
  fr: { it: 'italien', de: 'allemand', fr: 'français', rm: 'romanche', en: 'anglais' },
};

/** Primo paragrafo per tema: `P` e' la locuzione di luogo con l'iniziale maiuscola. */
const LEAD = {
  it: {
    carburanti: (P) => `${P}, benzina e diesel sono una voce fissa nel bilancio di chi usa l’auto per andare al lavoro. Questa pagina riunisce i prezzi medi rilevati alla pompa, il confronto con le aree oltreconfine quando esiste un dato pubblico e gli articoli della redazione su carburanti ed energia.`,
    fisco: (P) => `${P}, imposte sul reddito, imposta alla fonte e scadenze dipendono dalle regole cantonali oltre che da quelle federali. Questa pagina riunisce l’onere fiscale di riferimento, le aliquote dell’imposta alla fonte, gli avvisi dell’autorità fiscale e gli articoli della redazione sul fisco.`,
    mobilita: (P) => `${P}, spostarsi per lavoro significa fare i conti con cantieri, chiusure, trasporto pubblico e, dove c’è un confine, con le attese ai valichi. Questa pagina riunisce le limitazioni in corso, i tempi di attesa rilevati e gli articoli della redazione su traffico e trasporti.`,
    eventi: (P) => `${P}, il calendario di fiere, concerti, mercati e manifestazioni cambia ogni settimana. Questa pagina riunisce i prossimi appuntamenti dell’agenda eventi del sito e gli articoli della redazione su che cosa fare sul territorio, dal fine settimana alle ricorrenze dell’anno.`,
    pensioni: (P) => `${P}, la previdenza poggia sui tre pilastri svizzeri: AVS, cassa pensione e risparmio privato. Questa pagina riunisce i parametri federali dell’anno, le casse di riferimento, l’imposta sul prelievo del capitale e gli articoli della redazione su pensioni e previdenza.`,
    servizi: (P) => `${P}, i servizi di tutti i giorni passano da cassa malati, farmacie, uffici cantonali e sportelli pubblici. Questa pagina riunisce i premi dell’assicurazione di base, i servizi utili seguiti dal sito, gli avvisi ufficiali e gli articoli della redazione.`,
  },
  en: {
    carburanti: (P) => `${P}, petrol and diesel are a fixed item in the budget of anyone who drives to work. This page brings together the average pump prices on record, the comparison with the other side of the border where public data exists, and our articles on fuel and energy.`,
    fisco: (P) => `${P}, income tax, withholding tax and deadlines depend on cantonal rules as well as federal ones. This page brings together the reference tax burden, the withholding tax rates, notices from the tax authority and our articles on tax.`,
    mobilita: (P) => `${P}, getting to work means dealing with roadworks, closures, public transport and, where there is a border, waiting times at the crossings. This page brings together current restrictions, measured waiting times and our articles on traffic and transport.`,
    eventi: (P) => `${P}, the calendar of fairs, concerts, markets and festivals changes every week. This page brings together the upcoming dates from the site’s events calendar and our articles on what to do locally, from the weekend to the yearly fixtures.`,
    pensioni: (P) => `${P}, retirement provision rests on the three Swiss pillars: AHV, the occupational pension fund and private savings. This page brings together this year’s federal parameters, the funds of reference, the tax on lump-sum withdrawals and our articles on pensions.`,
    servizi: (P) => `${P}, everyday services run through health insurance, pharmacies, cantonal offices and public counters. This page brings together basic insurance premiums, the useful services the site tracks, official notices and our articles.`,
  },
  de: {
    carburanti: (P) => `${P} sind Benzin und Diesel ein fester Posten im Budget aller, die mit dem Auto zur Arbeit fahren. Diese Seite bündelt die erhobenen Durchschnittspreise an der Zapfsäule, den Vergleich mit dem Gebiet jenseits der Grenze, sofern öffentliche Daten vorliegen, und die Artikel der Redaktion zu Treibstoff und Energie.`,
    fisco: (P) => `${P} hängen Einkommenssteuern, Quellensteuer und Fristen von den kantonalen Regeln ebenso ab wie von den eidgenössischen. Diese Seite bündelt die Steuerbelastung als Referenz, die Quellensteuersätze, die Mitteilungen der Steuerbehörde und die Artikel der Redaktion zu Steuern.`,
    mobilita: (P) => `${P} bedeutet der Arbeitsweg, mit Baustellen, Sperrungen, dem öffentlichen Verkehr und – wo es eine Grenze gibt – mit Wartezeiten an den Übergängen zu rechnen. Diese Seite bündelt die laufenden Einschränkungen, die gemessenen Wartezeiten und die Artikel der Redaktion zu Verkehr und Mobilität.`,
    eventi: (P) => `${P} ändert sich der Kalender mit Messen, Konzerten, Märkten und Festen jede Woche. Diese Seite bündelt die nächsten Termine aus dem Veranstaltungskalender der Website und die Artikel der Redaktion dazu, was vor Ort los ist – vom Wochenende bis zu den festen Terminen des Jahres.`,
    pensioni: (P) => `${P} ruht die Vorsorge auf den drei Schweizer Säulen: AHV, Pensionskasse und privates Sparen. Diese Seite bündelt die eidgenössischen Eckwerte des Jahres, die zuständigen Kassen, die Steuer auf Kapitalbezügen und die Artikel der Redaktion zu Renten und Vorsorge.`,
    servizi: (P) => `${P} laufen die Dienstleistungen des Alltags über Krankenkasse, Apotheken, kantonale Ämter und öffentliche Schalter. Diese Seite bündelt die Prämien der Grundversicherung, die nützlichen Dienste, die die Website verfolgt, die amtlichen Mitteilungen und die Artikel der Redaktion.`,
  },
  fr: {
    carburanti: (P) => `${P}, l’essence et le diesel sont un poste fixe du budget de celles et ceux qui prennent la voiture pour aller travailler. Cette page réunit les prix moyens relevés à la pompe, la comparaison avec l’autre côté de la frontière lorsqu’une donnée publique existe et les articles de la rédaction sur les carburants et l’énergie.`,
    fisco: (P) => `${P}, l’impôt sur le revenu, l’impôt à la source et les échéances dépendent des règles cantonales autant que des règles fédérales. Cette page réunit la charge fiscale de référence, les taux de l’impôt à la source, les avis de l’autorité fiscale et les articles de la rédaction sur la fiscalité.`,
    mobilita: (P) => `${P}, se déplacer pour le travail, c’est composer avec les chantiers, les fermetures, les transports publics et, là où il y a une frontière, l’attente aux postes-frontières. Cette page réunit les restrictions en cours, les temps d’attente mesurés et les articles de la rédaction sur le trafic et les transports.`,
    eventi: (P) => `${P}, le calendrier des foires, concerts, marchés et manifestations change chaque semaine. Cette page réunit les prochains rendez-vous de l’agenda du site et les articles de la rédaction sur ce qu’il y a à faire sur place, du week-end aux rendez-vous de l’année.`,
    pensioni: (P) => `${P}, la prévoyance repose sur les trois piliers suisses : l’AVS, la caisse de pension et l’épargne privée. Cette page réunit les paramètres fédéraux de l’année, les caisses de référence, l’impôt sur le retrait en capital et les articles de la rédaction sur les retraites.`,
    servizi: (P) => `${P}, les services du quotidien passent par l’assurance-maladie, les pharmacies, les offices cantonaux et les guichets publics. Cette page réunit les primes de l’assurance de base, les services utiles suivis par le site, les avis officiels et les articles de la rédaction.`,
  },
};

const CONTEXT = {
  it: {
    border: (list) => `Il territorio confina con ${list}: per chi attraversa il confine ogni giorno contano le regole e i prezzi di entrambi i lati.`,
    interior: 'Il territorio non ha un confine nazionale: i temi che contano sono quelli di chi vive e lavora in Svizzera.',
    languages: (list) => `Le fonti ufficiali pubblicano in ${list}; dati, avvisi e articoli sono raccolti qui e aggiornati quando cambiano.`,
  },
  en: {
    border: (list) => `The area borders ${list}: for those who cross the border every day, the rules and prices on both sides matter.`,
    interior: 'The area has no national border: the topics that matter are those of people living and working in Switzerland.',
    languages: (list) => `Official sources publish in ${list}; data, notices and articles are collected here and updated when they change.`,
  },
  de: {
    border: (list) => `Das Gebiet grenzt an ${list}: Wer täglich die Grenze überquert, muss Regeln und Preise auf beiden Seiten kennen.`,
    interior: 'Das Gebiet hat keine Landesgrenze: Es zählen die Themen jener, die in der Schweiz leben und arbeiten.',
    languages: (list) => `Die offiziellen Quellen publizieren auf ${list}; Daten, Mitteilungen und Artikel werden hier gesammelt und bei Änderungen aktualisiert.`,
  },
  fr: {
    border: (list) => `Le territoire a une frontière avec ${list} : pour celles et ceux qui la franchissent chaque jour, les règles et les prix des deux côtés comptent.`,
    interior: 'Le territoire n’a pas de frontière nationale : les thèmes qui comptent sont ceux des personnes qui vivent et travaillent en Suisse.',
    languages: (list) => `Les sources officielles publient en ${list} ; données, avis et articles sont réunis ici et mis à jour lorsqu’ils changent.`,
  },
};

/**
 * L'intro di un hub: due paragrafi separati da una riga vuota (la forma che
 * `renderCantonTopicHub` si aspetta).
 *
 * @param {{ canton: string, topic: string, locale: string, neighbours: string[], languages: string[] }} args
 */
export function buildHubIntro({ canton, topic, locale, neighbours, languages }) {
  if (!HUB_LOCALES.includes(locale)) throw new Error(`canton-hubs: locale non supportata "${locale}"`);
  const lead = LEAD[locale][topic];
  if (!lead) throw new Error(`canton-hubs: tema sconosciuto "${topic}"`);
  const c = CONTEXT[locale];
  const countries = neighbours.map((code) => {
    const name = COUNTRY[locale][code];
    if (!name) throw new Error(`canton-hubs: Paese confinante sconosciuto "${code}" per ${canton}`);
    return name;
  });
  const langs = languages.map((code) => {
    const name = LANGUAGE[locale][code];
    if (!name) throw new Error(`canton-hubs: lingua sconosciuta "${code}" per ${canton}`);
    return name;
  });
  if (langs.length === 0) throw new Error(`canton-hubs: nessuna lingua nel profilo di ${canton}`);
  const context = [
    countries.length ? c.border(joinList(countries, locale)) : c.interior,
    c.languages(joinList(langs, locale)),
  ].join(' ');
  return `${lead(capitalize(cantonPlace(canton, locale)))}\n\n${context}`;
}

/** I tre cantoni di cui `cantone-toponimi-coerenza.mjs` conosce i toponimi. */
const TOPONYM_KEY = Object.freeze({ TI: 'ticino', GR: 'grigioni', VS: 'vallese' });

/**
 * Coerenza toponimi/cantone del testo EVERGREEN scritto da questo producer
 * (intro, titoli e descrizioni dei blocchi, etichette dei fatti chiave): un
 * hub del Ticino non deve nominare i Grigioni o il Vallese per un errore di
 * template. Non si applica ai titoli di news, eventi e avvisi, che arrivano
 * dai dataset e possono legittimamente citare altri cantoni.
 *
 * @returns {Array<{ canton: string, toponym: string }>} i toponimi estranei trovati
 */
export function foreignToponymsInCopy(canton, texts) {
  const declaredCanton = TOPONYM_KEY[canton];
  if (!declaredCanton) return [];
  return findForeignCantonToponyms({ declaredCanton, title: '', body: texts.filter(Boolean).join('\n') });
}
