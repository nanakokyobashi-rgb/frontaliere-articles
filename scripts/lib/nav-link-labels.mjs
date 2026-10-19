/**
 * Canonical labels for the article navigation links.
 *
 * The table below is a checked-in snapshot of the most frequent labels found
 * in the article body fields under `content/blog-body` and
 * `content/blog-body-ch` on 2026-10-19.  It is deliberately static: a
 * translation must not change its result because a partially checked-out or
 * concurrently written corpus happened to be present at runtime.
 */

const NAV_LINK_LABELS_RAW = {
  calculator: {
    it: ['calcolatore stipendio netto', 'calcolatore stipendio', 'calcolatore fiscale', 'calcolatore', 'calcolatore di stipendio'],
    de: 'Nettolohnrechner',
    fr: 'calculateur de salaire',
    en: 'net salary calculator',
  },
  exchange: {
    it: ['cambio CHF-EUR', 'comparatore cambio CHF-EUR', 'comparatore CHF/EUR', 'tasso di cambio CHF/EUR', 'calcolatore di viaggio'],
    de: 'CHF-EUR-Wechseloptionen',
    fr: 'change CHF-EUR',
    en: 'CHF-EUR exchange options',
  },
  'cost-of-living': {
    it: ['costo della vita in Svizzera', 'costo della vita', 'calcolatore del costo della vita', 'comparatore costo della vita', 'costo della vita Ticino vs Italia'],
    de: 'Lebenshaltungskosten',
    fr: 'coût de la vie',
    en: 'cost of living',
  },
  'permit-compare': {
    it: ['comparatore di permessi', 'comparatore permessi', 'comparatore Permesso G vs B', 'Comparatore permessi', 'Comparatore di permessi'],
    de: 'Vergleich der Bewilligungen',
    fr: 'comparateur de permis',
    en: 'permit comparator',
  },
  pension: {
    it: ['pianificatore pensionistico', 'previdenza', 'calcolatore pensioni', 'calcolatore pensionistico', 'comparatore pensioni'],
    de: 'Rentenplaner',
    fr: 'planificateur retraite',
    en: 'pension planner',
  },
  pillar3: {
    it: ['simulatore 3° pilastro', 'terzo pilastro', 'terzo pilastro 3a', 'pilastro 3a', 'terzo pilastro (3a)'],
    de: 'Säule-3-Simulator',
    fr: 'simulateur 3e pilier',
    en: 'pillar 3 simulator',
  },
  banks: {
    it: ['banche per frontalieri', 'conti bancari in Svizzera', 'banche', 'banche svizzere', 'calcolatore di confronto banche'],
    de: 'Banken für Grenzgänger',
    fr: 'banques pour frontaliers',
    en: 'banks for cross-border workers',
  },
  health: {
    it: ['comparatore di assicurazioni', 'cassa malati', 'comparatore assicurazioni', 'comparatore di assicurazioni sanitarie', 'assicurazione malattia'],
    de: 'Versicherungsvergleich',
    fr: "comparateur d'assurances",
    en: 'insurance comparator',
  },
  'traffic-history': {
    it: ['calcolatore di traffico', 'calcolatore del traffico', 'calcolatore di percorso', 'storico del traffico ai valichi', 'storico del traffico e delle code ai valichi'],
    de: 'Verkehrsrechner',
    fr: 'calculateur de trafic',
    en: 'traffic calculator',
  },
  transport: {
    it: ['mezzi pubblici', 'mezzi pubblici Ticino', 'comparatore di trasporti', 'calcolatore di viaggio', 'mezzi pubblici in Ticino'],
    de: 'Transportrechner',
    fr: 'comparateur de transports',
    en: 'transport comparator',
  },
  'border-map': {
    it: ['mappa dei valichi', 'comparatore di percorsi', 'mappa dei comuni', 'mappa valichi', 'border-map'],
    de: 'Karte der Grenzübergänge',
    fr: "comparateur d'itinéraires",
    en: 'route comparator',
  },
  ristorni: {
    it: ['ristorni', 'ristorni Ticino-Italia', 'calcolatore dei ristorni', 'guida ai ristorni', 'ristorni fiscali'],
    de: 'Rückerstattungsrechner',
    fr: 'comparateur de remboursements',
    en: 'refund comparator',
  },
  calendar: {
    it: ['calendario degli eventi', 'scadenze fiscali', 'calendario fiscale', 'calendario delle scadenze', 'calendario elettorale'],
    de: 'Steuerfristen',
    fr: 'échéances fiscales',
    en: 'tax deadlines',
  },
  border: {
    it: ['tempi di attesa ai valichi', 'tempi attesa valichi', 'tempi di attesa', 'Verifica i tempi di attesa ai valichi', 'Verifica i tempi d\'attesa ai valichi'],
    de: 'Wartezeiten an den Grenzübergängen',
    fr: "temps d'attente aux postes-frontières",
    en: 'border waiting times',
  },
  jobs: {
    it: ['annunci di lavoro', 'offerte di lavoro in Ticino', 'annunci lavoro', 'offerte di lavoro', 'opportunità di lavoro'],
    de: 'Stellenangebote im Tessin',
    fr: "offres d'emploi au Tessin",
    en: 'Ticino job offers',
  },
  'car-cost': {
    it: ['costo auto pendolare', 'calcolatore costi auto', 'costi auto pendolare', 'calcolatore dei costi auto', 'calcolatore del costo del carburante'],
    de: 'Autokostenrechner',
    fr: 'calculateur du coût du carburant',
    en: 'car cost calculator',
  },
  'tax-return': {
    it: ['guida dichiarazione redditi', 'dichiarazione delle imposte', 'dichiarazione dei redditi', 'guida alla dichiarazione dei redditi', 'calcolatore fiscale'],
    de: 'Leitfaden zur Steuererklärung',
    fr: 'guide déclaration fiscale',
    en: 'tax return guide',
  },
  'salary-compare': {
    it: ['comparatore di stipendi', 'calcolatore stipendio', 'comparatore stipendi', 'calcolatore stipendi', 'Confronto stipendi'],
    de: 'Lohnvergleicher',
    fr: 'comparateur de salaires',
    en: 'salary comparator',
  },
  payslip: {
    it: ['busta paga netta', 'busta paga svizzera', 'simulatore busta paga', 'busta paga', 'calcolatore busta paga'],
    de: 'Netto-Gehaltsabrechnung',
    fr: 'fiche de paie nette',
    en: 'net payslip',
  },
  'car-transfer': {
    it: ['calcolatore di sicurezza auto', 'guida al trasferimento targa', 'Assicurazione veicolo', 'comparatore di auto', 'comparatore veicoli'],
    de: 'Auto-Sicherheitsrechner',
    fr: 'calculateur de sécurité auto',
    en: 'car security calculator',
  },
  unemployment: {
    it: ['disoccupazione frontalieri', 'disoccupazione dei frontalieri', 'disoccupazione', 'guida alla disoccupazione per frontalieri', 'guida alla disoccupazione dei frontalieri'],
    de: 'Arbeitslosigkeit',
    fr: 'chômage',
    en: 'cross-border unemployment',
  },
  permits: {
    it: ['permesso G', 'Permesso G', 'Permesso G/B', 'comparatore di permessi', 'permesso G/B'],
    de: 'G-Bewilligung',
    fr: 'permis G',
    en: 'G permit',
  },
  companies: {
    it: ['aziende che assumono', 'aziende', 'Dipartimento del territorio', 'aziende che assumono frontalieri', 'SECO'],
    de: 'Arbeitgeber',
    fr: 'entreprises qui recrutent',
    en: 'hiring companies',
  },
  residency: {
    it: ['Guida alla residenza', 'Frontaliere Ticino', 'guida alla residenza', 'Servizi di assistenza', 'Guida al reinserimento sociale'],
    de: 'Wohnsitzführer',
    fr: 'Guide de résidence',
    en: 'Residency guide',
  },
  municipalities: {
    it: ['Mappa dei comuni ticinesi', 'servizi comunali', 'mappa dei comuni ticinesi', 'Canton Ticino', 'Elenco uffici sociali comunali'],
    de: 'Karte der Tessiner Gemeinden',
    fr: 'Carte des communes tessinoises',
    en: 'Ticino municipalities map',
  },
  'living-ch': {
    it: ['vivere in Svizzera', 'Vivere in Ticino', 'guida per frontalieri', 'Guida completa alla vita in Svizzera', 'corsi di lingua'],
    de: 'Leben in der Schweiz',
    fr: 'Vivre en Suisse',
    en: 'living in Switzerland',
  },
  'first-day': {
    it: ['guida pratica', 'checklist primo giorno', 'Guida al telelavoro', 'Lavorare in Svizzera', 'primo giorno'],
    de: 'praktischer Leitfaden',
    fr: 'guide pratique',
    en: 'practical guide',
  },
  nursery: {
    it: ['asilo nido', 'asili nido', 'Guida ai servizi scolastici', 'La mappa degli asili nido nel Cantone', "comparatore di asili nido e servizi per l'infanzia"],
    de: 'Karte der Kinderkrippen im Kanton',
    fr: 'La carte des crèches dans le canton',
    en: 'Map of daycare centres in the canton',
  },
  'job-board': {
    it: ['posti di lavoro', 'bacheca lavoro', 'le offerte di lavoro in Ticino', 'job board', 'job board interno'],
    de: 'Jobbörse',
    fr: "bourse de l'emploi",
    en: 'job board',
  },
  'living-it': {
    it: ['Frontaliere Ticino', 'guida agli alloggi', 'Guida vivere in Italia'],
    de: 'Leitfaden zum Leben in Italien',
    fr: 'guide des hébergements',
    en: 'accommodation guide',
  },
  'parental-leave': {
    it: ['congedo parentale', 'calcolatore congedo', 'calcolatore di congedo parentale', 'calcolatore congedo parentale', 'prestazioni familiari come il congedo parentale'],
    de: 'Elternurlaub',
    fr: 'congé parental',
    en: 'parental leave',
  },
  mobile: {
    it: ['comparatore di telefonia', 'telefonia mobile', 'comparatore di offerte telefoniche', 'offerte mobile'],
    de: 'Mobilfunkvergleich',
    fr: 'comparateur de téléphonie',
    en: 'mobile phone comparator',
  },
  livability: {
    it: ['qualità della vita', 'indice di vivibilità', 'calcolatore di impatto sociale', 'comparatore di vivibilità', 'guida alla vivibilità dei comuni ticinesi'],
    de: 'Lebensqualität',
    fr: 'qualité de vie',
    en: 'quality of life',
  },
  'jobs-observatory': {
    it: ['mercato del lavoro'],
    de: 'Arbeitsmarkt',
    fr: 'marché du travail',
    en: 'labor market',
  },
  whatif: {
    it: ['Dipartimento del territorio', 'iniziative popolari', 'fondo di emergenza', 'come presentare una petizione al Municipio'],
    de: 'Notfallfonds',
    fr: 'comment déposer une pétition à la Municipalité',
    en: 'emergency fund',
  },
  renovation: {
    it: ['calcolatore ristrutturazione casa', 'calcolatore di ristrutturazione', "guida all'acquisto di immobili in Svizzera", "guida all'acquisto di una casa", 'Guida all’acquisto immobiliare in Ticino'],
    de: 'Renovierungsrechner',
    fr: 'calculateur de rénovation',
    en: 'home renovation calculator',
  },
  shopping: {
    it: ['comparatore spesa e shopping', 'guida allo shopping'],
    de: 'Einkaufsvergleich',
    fr: 'comparateur courses et shopping',
    en: 'shopping comparator',
  },
};

function freezeNavEntry(entry) {
  return Object.freeze({ ...entry, it: Object.freeze([...entry.it]) });
}
export const NAV_LINK_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(NAV_LINK_LABELS_RAW).map(([target, entry]) => [target, freezeNavEntry(entry)])),
);

const ITALIAN_WORDS = new Set([
  'calcolatore', 'calcolatori', 'calcolatrice', 'calcolo', 'cambio', 'cassa',
  'comuni', 'congedo', 'costi', 'costo', 'dichiarazione', 'dichiarazioni',
  'disoccupazione', 'frontaliera', 'frontaliere', 'frontalieri',
  'guida', 'imposte', 'infanzia', 'iniziative', 'lavoro', 'malati', 'mappa', 'mercato',
  'mezzi', 'nido', 'offerte', 'paga', 'pensionistico', 'permesso', 'permessi',
  'pilastro', 'primo', 'pubblici', 'redditi', 'residenza', 'ristorni', 'ristrutturazione',
  'salari', 'scadenze', 'simulatore', 'stipendi', 'stipendio', 'tasse',
  'telefonia', 'tempi', 'trasporti', 'traffico', 'valichi', 'vita', 'vivibilità',
  'aziende', 'banche', 'banca', 'busta', 'comparatore', 'confronto', 'della', 'delle',
  'degli', 'dichiarazione', 'fondo', 'pianificatore', 'pensioni', 'pubblico', 'sanitarie',
  'assicurazione', 'assicurazioni', 'attesa', 'attese',
  'calendario', 'carburante', 'comunali', 'dati', 'eventi', 'lavorare', 'municipio',
  'parentale', 'pensione', 'pratica', 'scolastici', 'servizi', 'sicurezza', 'telefoniche',
  'terzo', 'uffici', 'veicolo',
]);

// `fiscale` is a strong Italian signal in German and English, but is a valid
// French feminine adjective in labels such as `guide déclaration fiscale`.
const ITALIAN_WORDS_BY_LOCALE = Object.freeze({
  de: new Set([...ITALIAN_WORDS, 'fiscale', 'fiscali']),
  en: new Set([...ITALIAN_WORDS, 'fiscale', 'fiscali']),
  fr: ITALIAN_WORDS,
  it: ITALIAN_WORDS,
});

const NAV_LINK_RE = /\[([^\]\n]+)\]\((nav:([a-z0-9-]+)[^)]*)\)/giu;

function normalizedWords(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('it')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function italianWords(value, locale = 'it') {
  const vocabulary = ITALIAN_WORDS_BY_LOCALE[locale] ?? ITALIAN_WORDS;
  return new Set(normalizedWords(value).filter((word) => vocabulary.has(word)));
}

function sourceItalianWordsByTarget(itBody) {
  const wordsByTarget = new Map();
  if (!itBody) return wordsByTarget;
  for (const match of String(itBody).matchAll(NAV_LINK_RE)) {
    const target = match[3].toLowerCase();
    const words = italianWords(match[1], 'it');
    if (!words.size) continue;
    if (!wordsByTarget.has(target)) wordsByTarget.set(target, new Set());
    for (const word of words) wordsByTarget.get(target).add(word);
  }
  return wordsByTarget;
}

function isItalianNavLabel(label, target, sourceWordsByTarget, locale) {
  const words = italianWords(label, locale);
  if (words.size) return true;
  const known = NAV_LINK_LABELS[target]?.it ?? [];
  if (known.some((candidate) => (
    candidate.trim().toLocaleLowerCase('it') === String(label).trim().toLocaleLowerCase('it')
      && italianWords(candidate, 'it').size > 0
  ))) {
    return true;
  }
  const sourceWords = sourceWordsByTarget.get(target);
  return Boolean(sourceWords?.size && normalizedWords(label).some((word) => sourceWords.has(word)));
}

/**
 * Returns Italian-looking `nav:` labels in a translated body.  The optional
 * Italian body supplies article-specific lexical evidence for a hybrid label
 * such as `costo della vita Tessin vs Italia`.
 */
export function findItalianNavLinkLabels(markdown, locale, { itBody = '' } = {}) {
  if (locale === 'it') return [];
  const sourceWordsByTarget = sourceItalianWordsByTarget(itBody);
  const hits = [];
  for (const match of String(markdown ?? '').matchAll(NAV_LINK_RE)) {
    const target = match[3].toLowerCase();
    if (!isItalianNavLabel(match[1], target, sourceWordsByTarget, locale)) continue;
    hits.push({
      index: match.index ?? 0,
      label: match[1],
      target,
      canonicalLabel: NAV_LINK_LABELS[target]?.[locale] ?? null,
    });
  }
  return hits;
}

/**
 * Replace only labels with Italian lexical evidence.  The complete target
 * syntax is copied byte-for-byte, so titles and future target suffixes cannot
 * be changed by this helper.
 */
export function localizeNavLinkLabels(markdown, locale, { itBody = '' } = {}) {
  const source = String(markdown ?? '');
  if (locale === 'it') return source;
  const sourceWordsByTarget = sourceItalianWordsByTarget(itBody);
  return source.replace(NAV_LINK_RE, (whole, label, targetSyntax, target) => {
    const action = target.toLowerCase();
    const canonical = NAV_LINK_LABELS[action]?.[locale];
    if (!canonical || !isItalianNavLabel(label, action, sourceWordsByTarget, locale)) return whole;
    return `[${canonical}](${targetSyntax})`;
  });
}
