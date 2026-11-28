/**
 * section-demand-query-filter.mjs — filtro di privacy e di qualita' delle query
 * di Search Console che entrano nel vocabolario di domanda per sezione (F6.2).
 *
 * Le query sono digitate da persone: possono contenere nomi di persone private,
 * telefoni, email, codici, operatori di scraping. Il vocabolario e' versionato
 * e le query finirebbero nei log CI, quindi qui si SCARTA (mai si anonimizza)
 * tutto cio' che non e' dimostrabilmente domanda di dominio.
 *
 * Contratto: una query si tiene SOLO se
 *  - non contiene contatti, URL, sequenze di cifre, sintassi da operatore,
 *    pattern su persone (stipendio di X, coniuge, necrologio...);
 *  - contiene almeno un termine di DOMINIO (fisco, permessi, lavoro, salari per
 *    professione, sanita', mobilita', scuola, casa, eventi, carburanti, cambio);
 *  - OGNI altro token e' un toponimo/istituzione noto, una parola generica o
 *    funzionale. Un token sconosciuto potrebbe essere un cognome: la query va
 *    scartata. Le query «nome cognome» senza dominio non passano mai.
 *
 * Lo stesso filtro gira nel builder (prima dell'aggregazione) e nel loader a
 * runtime, cosi' un JSON vecchio non riporta dati personali nei log.
 *
 * Funzioni pure salvo il caricamento (una volta) dei toponimi dal repo.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUERY_FILTER_VERSION = 1;
export const MAX_QUERY_TOKENS = 12;

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

export function foldText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Riferimento breve e stabile di una query per i log (mai la query intera). */
export function queryRef(query) {
  return `q-${crypto.createHash('sha1').update(String(query ?? '')).digest('hex').slice(0, 8)}`;
}

const words = (text) => text.split(/\s+/).filter(Boolean);

/** Stem di dominio per categoria (gia' in forma foldata). */
const DOMAIN_STEMS = {
  fisco: ['impost*', 'tass*', 'fisc*', 'steuer', 'tax*', 'dichiaraz', 'deduz', 'deduc', 'abzug', 'aliquot', 'moltiplicator', 'ahv', 'avs', 'lpp', 'bvg', 'iva', 'mwst', 'tva', 'pension', 'rendit', 'vorsorge', 'previdenz', 'pilastro', 'saule', 'pillar', 'prevoyance', 'retraite', 'contribut', 'beitrag', 'cotisation', 'ucc', 'ruling', 'quellensteuer', 'riscossione'],
  permessi: ['permess', 'permit', 'bewilligung', 'aufenthalt', 'grenzgang', 'frontalier', 'cross border', 'permis', 'autorizzaz', 'autorisation', 'cittadinanz', 'naturalizz', 'einburger', 'visto', 'domicil', 'wohnsitz', 'residenz'],
  lavoro: ['lavor', 'arbeit', 'travail', 'emploi', 'impiego', 'stellen', 'offerte di lavoro', 'salar', 'stipend', 'lohn*', 'gehalt', 'contratt', 'vertrag', 'contrat', 'disoccup', 'arbeitslos', 'chomage', 'indennit', 'assunz', 'licenzi', 'kundigung', 'concors', 'ferie', 'urlaub', 'assicurazione infortuni', 'infortun', 'job*', 'karriere', 'career', 'recruit', 'azienda'],
  professioni: ['infermier', 'medico', 'medici', 'ingegner', 'insegnant', 'docent', 'cuoc', 'muratore', 'elettricist', 'autist', 'camerier', 'commess', 'operaio', 'magazzinier', 'pflege', 'arzt', 'lehrer', 'koch', 'elektriker', 'informatic', 'developer', 'krankenschwester', 'infirmi', 'enseignant', 'meccanic', 'idraulic', 'giardinier', 'parrucchier', 'contabil', 'avvocat', 'architett', 'farmacist', 'dentist', 'educator', 'badante', 'segretari', 'ristorazione', 'gastronomia', 'hotel', 'cuisinier', 'maurer', 'schreiner', 'falegnam', 'saldator', 'carpentier'],
  sanita: ['lamal', 'kvg', 'krankenkass', 'cassa malati', 'cassamalati', 'assicuraz', 'versicher', 'assurance', 'ospedal', 'spital', 'hopital', 'sanit', 'gesundheit', 'sante', 'pramie', 'premi', 'franchigia', 'franchise', 'medic', 'farmac', 'apothek', 'pharmac', 'cura', 'pflegeversicherung', 'invalidit', 'pronto soccorso', 'notfall', 'vaccin', 'impf', 'sussidio', 'prestazion', 'verbilligung'],
  mobilita: ['traffic', 'verkehr', 'trafic', 'autostrad', 'autobahn', 'autoroute', 'valic', 'grenzubergang', 'dogana', 'zoll*', 'douane', 'strada', 'strasse', 'route', 'cantier', 'baustelle', 'chiusur', 'sperrung', 'gottardo', 'gotthard', 'tunnel', 'treno', 'train', 'bahn', 'tilo', 'ffs', 'sbb', 'cff', 'vignett', 'bus', 'trasport', 'transport', 'mobilit', 'parcheggio', 'parking', 'parkplatz', 'cod*', 'stau', 'bouchon', 'patente', 'fuhrerschein', 'permis de conduire', 'targa', 'veicol', 'fahrzeug', 'incident', 'unfall', 'accident', 'tram', 'metro', 'funivia', 'aeroporto', 'flughafen', 'aeroport', 'monopattin', 'bici*', 'velo', 'abbonament', 'billett', 'biglietto', 'ticket', 'halbtax', 'mezzo pubblic', 'cantonale', 'kantonsstrasse', 'ciclabil'],
  scuola: ['scuol', 'schul', 'ecole', 'universit', 'hochschule', 'studi*', 'kita', 'asilo', 'nido', 'maturit', 'formazion', 'ausbildung', 'formation', 'apprendist', 'lehre', 'borsa di studio', 'stipendio di studio', 'ferien scolast', 'calendario scolast', 'supsi', 'usi', 'eth', 'epfl', 'liceo', 'gymnasium', 'lycee'],
  casa: ['affitt', 'miete*', 'loyer', 'locazion', 'cas*', 'wohnung', 'immobil', 'appartament', 'logement', 'alloggi', 'mutuo', 'hypothek', 'hypotheque', 'eigenmiet', 'sfratto', 'condomin', 'bolletta', 'strom', 'elettricit', 'energia', 'energie', 'riscaldament', 'rifiuti', 'abfall', 'dechet', 'acqua potabile', 'internet', 'fibra', 'comparator', 'agenzia immobiliare'],
  eventi: ['event*', 'veranstalt', 'concert', 'festiv', 'fest*', 'mercat', 'markt', 'marche', 'carnevale', 'fiera', 'sagra', 'spettacol', 'mostra', 'museo', 'museum', 'musee', 'cinema', 'teatro', 'theater', 'gita', 'escursion', 'wanderung', 'weihnacht', 'natale', 'capodanno', 'feiertag', 'festivit', 'giorni festiv', 'meteo', 'wetter', 'previsioni', 'neve', 'schnee', 'piste', 'sci', 'lido', 'piscina', 'bagno', 'badi', 'sport', 'calcio', 'hockey'],
  carburanti: ['benzin', 'carburant', 'diesel', 'tankstell', 'essence', 'gasolio', 'distributor', 'stazione di servizio', 'prezzo carburant', 'elettric', 'ricarica', 'colonnina', 'lade*', 'gpl', 'metano'],
  cambio: ['cambio*', 'wechselkurs', 'kurs*', 'franco', 'chf', 'franc', 'euro', 'eur', 'change', 'devise', 'valuta', 'tasso', 'zins*', 'taux', 'cripto', 'bitcoin', 'banca', 'bank*', 'banque', 'conto', 'konto', 'twint', 'bonifico', 'iban', 'carta di credito', 'kreditkarte'],
  famiglia: ['assegni', 'familiar', 'kinderzulage', 'zulage', 'allocation', 'congedo', 'mutterschaft', 'maternit', 'paternit', 'alimenti', 'divorzio', 'scheidung', 'matrimonio', 'heirat', 'successione', 'erb', 'eredit', 'testament', 'adozione', 'anziani', 'senioren', 'ems', 'spitex', 'bonus', 'sussid', 'aiuti', 'sozialhilfe', 'assistenza'],
  burocrazia: ['ufficio', 'amt*', 'office', 'registro', 'handelsregister', 'registre', 'anagrafe', 'einwohner', 'tribunale', 'gericht', 'tribunal', 'polizia', 'polizei', 'police', 'multa', 'bussa', 'busse', 'amende', 'legge', 'gesetz', 'verordnung', 'ordinanza', 'concorso', 'bando', 'ausschreibung', 'gara', 'appalto', 'sondaggio', 'votazion', 'abstimmung', 'votation', 'elezion', 'wahl*', 'election', 'iniziativa', 'referendum', 'consiglio', 'regierung', 'gouvernement', 'governo', 'municipio', 'gemeinde', 'commune', 'dipartimento', 'departement', 'cantone', 'kanton', 'canton', 'cantonal', 'kantonal'],
};
const foldStem = (stem) => (stem.endsWith('*') ? `${foldText(stem.slice(0, -1))}*` : foldText(stem));
const DOMAIN_STEM_LIST = [...new Set(Object.values(DOMAIN_STEMS).flat().map(foldStem).filter(Boolean))];
const DOMAIN_SINGLE = DOMAIN_STEM_LIST.filter((s) => !s.includes(' '));
const DOMAIN_PHRASES = DOMAIN_STEM_LIST.filter((s) => s.includes(' ') && !s.endsWith('*'));

/** Parole generiche o funzionali: non portano dominio ne' identificano persone. */
const GENERIC_STEMS = [
  // IT
  'ann*', 'annual', 'nuov*', 'novit', 'quant*', 'cost*', 'come', 'funzion', 'calcol', 'tabell', 'tariff', 'scadenz', 'richiest', 'domand', 'modul', 'orari', 'apertur', 'numero', 'indirizz', 'contatt', 'sit*', 'ufficial', 'online', 'guida', 'requisit', 'durata', 'import', 'limit', 'massim', 'minim', 'aument', 'riduzion', 'oggi', 'domani', 'settiman', 'mes*', 'mesi', 'giorn', 'tempo', 'tempi', 'attesa', 'quando', 'dove', 'cosa', 'qual*', 'regol', 'ultim', 'font*', 'ancora', 'sempre', 'ogni', 'tutto', 'tutti', 'senza', 'sotto', 'sopra', 'oltre', 'vicino', 'nord', 'sud', 'est', 'ovest', 'centro', 'piano', 'differenz', 'diritt', 'obblig', 'possibil', 'valid', 'automatic', 'esempio', 'simulat', 'privat', 'professional', 'person', 'second', 'prim*', 'general', 'pubblic', 'special', 'lungo', 'breve', 'medio', 'media', 'medie', 'totale', 'netto', 'lordo', 'base', 'dopo', 'durante', 'entro', 'verso', 'fino', 'dal', 'alla', 'alle', 'allo', 'agli', 'sul', 'sulla',
  // DE
  'jahr*', 'neue*', 'wie', 'viel', 'hoch', 'hohe*', 'berechn', 'rechner', 'tabelle', 'tarif', 'frist*', 'antrag', 'formular', 'offnungszeit', 'adresse', 'kontakt', 'anleitung', 'voraussetzung', 'dauer', 'betrag', 'maximal', 'minimal', 'erhohung', 'heute', 'morgen', 'woche', 'monat', 'tage', 'wartezeit', 'wann', 'welche', 'regel', 'unterschied', 'zwischen', 'beruflich', 'privat', 'ohne', 'nach', 'unter', 'uber', 'vor', 'bei', 'beim', 'fur', 'gegen', 'durch', 'alle', 'aktuell', 'letzte', 'mitte', 'norden', 'suden', 'osten', 'westen', 'allgemein', 'brutto', 'netto', 'gultig', 'beispiel', 'kosten', 'preis', 'preise', 'liste', 'ubersicht', 'bedeutet', 'gilt', 'muss', 'kann', 'darf', 'wird', 'sind', 'nicht', 'oder', 'und', 'auch',
  // FR
  'annee', 'nouve*', 'combien', 'cout', 'calcul', 'tableau', 'tarif', 'delai', 'demande', 'formulaire', 'horaire', 'adresse', 'contact', 'guide', 'condition', 'duree', 'montant', 'maximum', 'minimum', 'augmentation', 'aujourd', 'demain', 'semaine', 'mois', 'jours', 'attente', 'quand', 'quel', 'regle', 'difference', 'sans', 'sous', 'apres', 'avant', 'pour', 'avec', 'dans', 'entre', 'tous', 'tout', 'brut', 'net', 'valable', 'exemple', 'liste', 'prix',
  // EN
  'year*', 'new', 'how', 'much', 'cost', 'calculat', 'table', 'rate*', 'deadline', 'applic', 'form*', 'hours', 'address', 'guide', 'requirement', 'duration', 'amount', 'maximum', 'minimum', 'increase', 'today', 'tomorrow', 'week', 'month', 'days', 'waiting', 'when', 'where', 'what', 'which', 'rules', 'law', 'swiss', 'switzerland', 'border', 'worker', 'workers', 'cross', 'without', 'with', 'after', 'before', 'between', 'near', 'gross', 'valid', 'example', 'list', 'price', 'prices', 'rates', 'latest', 'current', 'average', 'median', 'total',
];
const GENERIC_STEM_LIST = [...new Set(GENERIC_STEMS.map(foldStem).filter(Boolean))];

/** Parole funzionali brevi (anche di 3 lettere) che non pesano mai. */
const FUNCTION_WORDS = new Set([
  'del', 'dei', 'della', 'delle', 'degli', 'dello', 'dal', 'dalla', 'dalle', 'nel', 'nella', 'nelle', 'sul', 'sulla', 'con', 'per', 'tra', 'fra', 'che', 'una', 'uno', 'gli', 'non', 'piu', 'sono', 'come', 'cosa', 'chi', 'dove',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'how', 'are', 'was', 'has', 'have', 'will', 'into', 'about', 'per', 'vs',
  'der', 'die', 'das', 'und', 'mit', 'von', 'fur', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'ist', 'sind', 'auf', 'bei', 'wie', 'wird', 'zum', 'zur', 'aus', 'im', 'am',
  'les', 'des', 'une', 'dans', 'pour', 'avec', 'sur', 'par', 'est', 'sont', 'qui', 'que', 'aux', 'du', 'de', 'la', 'le', 'en', 'un', 'et',
]);

/** Prenomi frequenti (IT/DE/FR/EN): un token cosi' fuori dal dominio e' un indizio di persona. */
const FIRST_NAMES = new Set([
  'mario', 'luca', 'marco', 'paolo', 'giuseppe', 'giovanni', 'antonio', 'francesco', 'andrea', 'alessandro', 'roberto', 'stefano', 'matteo', 'davide', 'simone', 'fabio', 'daniele', 'michele', 'claudio', 'giorgio', 'angelo', 'massimo', 'riccardo', 'enrico', 'sergio', 'pietro', 'carlo', 'luigi', 'lorenzo', 'gabriele', 'federico', 'nicola', 'maurizio', 'franco', 'gianni', 'flavio', 'diego', 'emanuele', 'salvatore', 'vincenzo', 'domenico', 'raffaele', 'alberto', 'bruno', 'danilo', 'elia', 'samuele', 'thomas', 'tommaso', 'filippo', 'cristian', 'christian', 'dario', 'fabrizio', 'gianluca', 'ivan', 'manuel', 'mattia', 'moreno', 'renato', 'rocco', 'silvio', 'tiziano', 'valerio', 'walter',
  'maria', 'anna', 'giulia', 'francesca', 'sara', 'laura', 'chiara', 'elena', 'paola', 'silvia', 'valentina', 'alessandra', 'roberta', 'federica', 'martina', 'elisa', 'monica', 'barbara', 'daniela', 'stefania', 'cristina', 'simona', 'claudia', 'patrizia', 'rita', 'giovanna', 'carla', 'lucia', 'angela', 'teresa', 'giuseppina', 'antonella', 'manuela', 'sabrina', 'serena', 'veronica', 'michela', 'nadia', 'ilaria', 'irene', 'marta', 'greta', 'alice', 'beatrice', 'caterina', 'eleonora', 'jessica', 'noemi', 'rosa', 'loredana', 'luisa', 'fiorella', 'graziella',
  'hans', 'peter', 'urs', 'markus', 'thomas', 'daniel', 'martin', 'stefan', 'andreas', 'christoph', 'michael', 'werner', 'walter', 'ernst', 'fritz', 'heinz', 'rolf', 'bruno', 'beat', 'kurt', 'reto', 'roland', 'jurg', 'jorg', 'klaus', 'dieter', 'matthias', 'patrick', 'simon', 'lukas', 'nico', 'noah', 'jan', 'tim', 'felix', 'florian', 'sebastian', 'tobias', 'manfred', 'erika', 'ursula', 'monika', 'sabine', 'susanne', 'brigitte', 'heidi', 'verena', 'renate', 'barbara', 'katharina', 'andrea', 'nicole', 'sandra', 'petra', 'silvia', 'franziska', 'anja', 'julia', 'lea', 'lena', 'sophie', 'sophia', 'emma', 'mia', 'lara', 'nina', 'sarah', 'melanie', 'claudine', 'esther', 'ruth', 'margrit', 'gisela',
  'jean', 'pierre', 'jacques', 'michel', 'philippe', 'alain', 'bernard', 'louis', 'andre', 'marcel', 'rene', 'daniel', 'olivier', 'nicolas', 'laurent', 'julien', 'david', 'eric', 'pascal', 'sylvain', 'cedric', 'fabrice', 'gilles', 'thierry', 'yves', 'francois', 'christophe', 'frederic', 'stephane', 'marie', 'nathalie', 'isabelle', 'sylvie', 'catherine', 'christine', 'martine', 'monique', 'francoise', 'sophie', 'camille', 'celine', 'aurelie', 'valerie', 'veronique', 'brigitte', 'jeanne', 'odile',
  'john', 'james', 'robert', 'william', 'richard', 'charles', 'joseph', 'george', 'edward', 'henry', 'paul', 'mark', 'steven', 'kevin', 'brian', 'jason', 'ryan', 'jacob', 'mary', 'patricia', 'jennifer', 'linda', 'elizabeth', 'susan', 'margaret', 'dorothy', 'lisa', 'nancy', 'karen', 'betty', 'helen', 'sandy', 'donna', 'carol', 'emily', 'olivia', 'amanda',
]);

const INSTITUTION_STEMS = ['ufficio', 'amt', 'kanton', 'canton', 'cantone', 'cantonal', 'kantonal', 'gemeinde', 'commune', 'comune', 'comuni', 'municipio', 'regierung', 'governo', 'gouvernement', 'dipartimento', 'departement', 'prefettura', 'tribunale', 'gericht', 'svizzera', 'suisse', 'schweiz', 'switzerland', 'swiss', 'svizzer', 'schweizer', 'italia', 'italy', 'italien', 'italie', 'italian', 'lombardia', 'piemonte', 'varese', 'como', 'verbania', 'sondrio', 'lecco', 'novara', 'frontiera', 'frontier', 'grenze', 'confine', 'ticinese', 'zurigo', 'lucerna', 'vallese', 'friburgo', 'ginevra', 'grigioni', 'sangallo', 'berna', 'soletta', 'turgovia', 'sciaffusa', 'argovia', 'giura', 'neuchatel', 'nidvaldo', 'obvaldo', 'svitto', 'uri', 'zugo', 'glarona', 'basilea', 'appenzello', 'vaud', 'geneve', 'genf', 'valais', 'wallis', 'fribourg', 'freiburg', 'jura', 'tessin', 'graubunden', 'grisons', 'zurich', 'luzern', 'lucerne', 'bern', 'berne', 'solothurn', 'thurgau', 'schaffhausen', 'aargau', 'argovie', 'basel', 'bale', 'zug', 'glarus', 'schwyz', 'obwalden', 'nidwalden', 'appenzell', 'neuenburg'].map(foldText);

let placeCache = null;

/** Toponimi dal repo: comuni BFS, citta', cantoni e capoluoghi nelle 4 lingue. */
function loadPlaceTokens() {
  if (placeCache) return placeCache;
  const tokens = new Set();
  const add = (name) => {
    const folded = foldText(String(name ?? '').replace(/\([^)]*\)/g, ' '));
    for (const w of words(folded)) if (w.length >= 3) tokens.add(w);
  };
  try {
    const places = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'canton-classifier-places.json'), 'utf8'));
    for (const list of Object.values(places.municipalities || {})) for (const name of list || []) add(name);
    for (const town of places.towns || []) add(town?.name);
  } catch { /* file assente: restano gli altri toponimi (piu' stretto, mai piu' largo) */ }
  try {
    const topo = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'localized-toponyms.json'), 'utf8'));
    for (const entity of topo.entities || []) {
      for (const kind of ['canton', 'capital']) {
        for (const list of Object.values(entity?.[kind] || {})) for (const name of list || []) add(name);
      }
    }
  } catch { /* idem */ }
  try {
    const ti = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ticino-municipalities.json'), 'utf8'));
    for (const m of ti.municipalities || []) add(typeof m === 'string' ? m : (m?.name || m?.comune));
  } catch { /* idem */ }
  placeCache = tokens;
  return tokens;
}

/** Stem: `x*` = prefisso, >= 5 caratteri = contenuto nel token (composti tedeschi), altrimenti token esatto. */
function stemMatcher(stem) {
  if (stem.endsWith('*')) { const p = stem.slice(0, -1); return (t) => t.startsWith(p); }
  if (stem.length >= 5) return (t) => t.includes(stem);
  return (t) => t === stem;
}
const compileStems = (list) => list.map(stemMatcher);
const DOMAIN_MATCHERS = compileStems(DOMAIN_SINGLE);
const GENERIC_MATCHERS = compileStems(GENERIC_STEM_LIST);

function isDomainToken(token) { return DOMAIN_MATCHERS.some((m) => m(token)); }
function isGenericToken(token) { return FUNCTION_WORDS.has(token) || GENERIC_MATCHERS.some((m) => m(token)); }
function isInstitutionToken(token) {
  return INSTITUTION_STEMS.some((stem) => token === stem || (stem.length >= 5 && token.startsWith(stem)));
}

const CONTACT_RE = /@|https?|www\.|\.(?:ch|com|net|org|it|de|fr|eu)\b/;
const DIGIT_RUN_RE = /\d[\d\s./-]{6,}\d|\d{5,}/;
const SYNTAX_RE = /[;"“”„«»()[\]{}<>|\\*=]|\bintitle:|\binurl:|\bsite:|\bfiletype:|\bAND\b|\bOR\b|:/;
const INCOME_RE = /\b(stipendio|stipendi|salario|salari|salaire|salaires|gehalt|gehaelter|lohn|loehne|reddito|redditi|patrimonio|income|salary|wage)\b/;
const FAMILY_RE = /\b(ehemann|ehefrau|moglie|marito|frau von|mann von|femme de|mari de|figlio|figlia|necrologio|obituary|morto|morta|deceduto|deceduta|todesanzeige|traueranzeige|verstorben|gestorben|decede|deces|compagno|compagna|fidanzat[oa])\b/;
const PERSON_CONTEXT_RE = /\b(di|von|de|of|du|des)\s+[a-z]+\s+[a-z]+\s*$/;

/**
 * @param {string} rawQuery  query GSC cosi' com'e'
 * @returns {{keep: boolean, reason: string|null}}
 */
export function classifyDemandQuery(rawQuery) {
  const raw = String(rawQuery ?? '').toLowerCase().trim();
  if (!raw) return { keep: false, reason: 'empty' };
  if (CONTACT_RE.test(raw)) return { keep: false, reason: 'contact' };
  if (DIGIT_RUN_RE.test(raw)) return { keep: false, reason: 'digits' };
  if (SYNTAX_RE.test(String(rawQuery ?? ''))) return { keep: false, reason: 'syntax' };
  const folded = foldText(raw);
  const tokens = words(folded);
  if (tokens.length > MAX_QUERY_TOKENS) return { keep: false, reason: 'too_long' };
  const letters = (folded.match(/[a-z]/g) || []).length;
  if (letters < 2) return { keep: false, reason: 'too_short' };
  if (!tokens.some((t) => /^[a-z]{4,}$/.test(t))) return { keep: false, reason: 'generic' };

  const placeTokens = loadPlaceTokens();
  const isPlace = (t) => placeTokens.has(t) || isInstitutionToken(t);
  if (FAMILY_RE.test(folded)) return { keep: false, reason: 'person_pattern' };

  // I token coperti da una frase di dominio («cassa malati») non contano come sconosciuti.
  let residual = ` ${folded} `;
  for (const phrase of DOMAIN_PHRASES) residual = residual.split(` ${phrase} `).join(' ');
  const alpha = words(residual).filter((t) => /[a-z]/.test(t) && t.length >= 3);
  const domainHit = alpha.some(isDomainToken) || DOMAIN_PHRASES.some((p) => ` ${folded} `.includes(` ${p} `));
  const unknown = alpha.filter((t) => !isDomainToken(t) && !isPlace(t) && !isGenericToken(t));
  const hasFirstName = alpha.some((t) => FIRST_NAMES.has(t) && !isDomainToken(t));

  if (INCOME_RE.test(folded) && (hasFirstName || unknown.length > 0)) return { keep: false, reason: 'person_pattern' };
  if (PERSON_CONTEXT_RE.test(folded) && (hasFirstName || unknown.length > 0)) return { keep: false, reason: 'person_pattern' };
  if (hasFirstName) return { keep: false, reason: 'unknown_token' };
  if (!domainHit) return { keep: false, reason: 'no_domain' };
  if (unknown.length > 0) return { keep: false, reason: 'unknown_token' };

  // Una query a un solo token e' domanda su un argomento solo se il token e' un
  // composto specifico (>= 10 caratteri); i generici («benzina», «carburant»,
  // «frontaliere») e i toponimi soli no.
  if (tokens.length === 1 && (tokens[0].length < 10 || GENERIC_SINGLES.has(tokens[0]) || isPlace(tokens[0]))) {
    return { keep: false, reason: 'generic' };
  }
  return { keep: true, reason: null };
}

const GENERIC_SINGLES = new Set(['carburante', 'carburant', 'frontaliere', 'frontalieri', 'frontaliers', 'frontalier', 'grenzgaenger', 'grenzganger', 'benzina', 'benzin', 'diesel', 'ticino', 'svizzera', 'lavoro', 'steuern', 'tasse', 'imposte', 'meteo', 'eventi', 'events', 'cambio', 'franco', 'euro']);

/** `true` se la query puo' restare nel vocabolario. */
export const isAllowedDemandQuery = (query) => classifyDemandQuery(query).keep;
