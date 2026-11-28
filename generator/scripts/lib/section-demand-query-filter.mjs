/**
 * section-demand-query-filter.mjs — filtro di privacy e di qualita' delle query
 * di Search Console che entrano nel vocabolario di domanda per sezione (F6.2).
 *
 * Le query sono digitate da persone: possono contenere nomi di persone private,
 * telefoni, email, codici, operatori di scraping. Il vocabolario e' versionato
 * e le query finirebbero nei log CI, quindi qui si SCARTA (mai si anonimizza)
 * tutto cio' che non e' dimostrabilmente domanda di dominio.
 *
 * GRAMMATICA CHIUSA A TOKEN ESATTI (versione 2). Una query si tiene SOLO se e'
 * una sequenza di token ciascuno dei quali e' presente in un elenco ESATTO:
 *  - termini di dominio (fisco, permessi, lavoro, professioni, sanita',
 *    mobilita', scuola, casa, eventi, carburanti, cambio, famiglia, burocrazia),
 *    con una lista chiusa di suffissi di plurale/variante applicata SOLO a
 *    questi (mai ai toponimi ne' ai generici);
 *  - parole generiche o funzionali (elenco esplicito);
 *  - anni 2020-2035 e pochi codici (permesso G, autostrada A2, pilastro 3a);
 *  - toponimi: SOLO i comuni e i nomi del cantone della sezione, al massimo un
 *    toponimo (comune o cantone, anche in sigla) per query; restano fuori i toponimi
 *    corti (<= 4 lettere, per i comuni) o uguali a un prenome, un cognome
 *    frequente o una parola di dominio/generica.
 * e contiene almeno un termine di dominio. Nessun `startsWith`/`includes`: un
 * cognome che inizia come una parola di dominio, o che coincide con un comune
 * di un altro cantone, non passa. Le query «nome cognome» senza dominio non
 * passano mai.
 *
 * Lo stesso filtro gira nel builder (prima dell'aggregazione), nel loader a
 * runtime e nella modalita' `--verify` del builder, cosi' un JSON vecchio non
 * riporta dati personali nei log.
 *
 * Funzioni pure salvo il caricamento (una volta) dei toponimi dal repo.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recognizeFirstName } from './first-name-recognition.mjs';

export const QUERY_FILTER_VERSION = 2;
export const MAX_QUERY_TOKENS = 8;

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

/** Sale per processo: i riferimenti nei log non sono invertibili per dizionario ne' confrontabili tra run. */
const RUN_SALT = crypto.randomBytes(16);

/** Riferimento breve di una query per i log (mai la query intera), valido solo dentro questo processo. */
export function queryRef(query, salt = RUN_SALT) {
  return `q-${crypto.createHmac('sha256', salt).update(String(query ?? '')).digest('hex').slice(0, 8)}`;
}

const words = (text) => text.split(/\s+/).filter(Boolean);
const list = (text) => words(foldText(text));

/** Suffissi ammessi per le sole parole di dominio lunghe (>= 5 lettere): plurali/varianti. */
export const DOMAIN_SUFFIXES = Object.freeze(['', 's', 'e', 'n', 'en', 'i']);

const DOMAIN_LEMMAS = `
imposta imposte tassa tasse tassazione fisco fiscale fiscali fiscalita dichiarazione dichiarazioni deduzione deduzioni detrazione detrazioni aliquota aliquote moltiplicatore iva pensione pensioni rendita rendite previdenza previdenziale pilastro pilastri contributi contributo cassa casse malati cassamalati ruling riscossione imponibile avs lpp ucc
steuer steuern steuerfuss steuerfusse steuererklarung steuersatz steuersatze steuertarif steuerrechner steuerabzug steuerabzuge steuerausweis steuerbetrag steuerrechnung steuervergleich quellensteuer einkommenssteuer einkommensteuer vermogenssteuer mehrwertsteuer mwst abzug abzuge ahv bvg rente renten altersrente maximalrente minimalrente pensionskasse vorsorge saule beitrag beitrage
impot impots taxe taxes fiscalite deduction deductions tva prevoyance retraite cotisation cotisations pilier
tax taxes taxation pension pillar vat withholding
permesso permessi frontaliere frontalieri frontaliera frontaliers frontalier grenzganger grenzgangerin grenzgangerbewilligung bewilligung bewilligungen aufenthalt aufenthaltsbewilligung niederlassungsbewilligung arbeitsbewilligung permis autorisation autorisations cittadinanza naturalizzazione einburgerung visto visti domicilio wohnsitz residenza residenz permit permits
lavoro lavori lavorare lavoratore lavoratori arbeit arbeiten arbeitsstelle arbeitsstellen arbeitsvertrag arbeitgeber arbeitnehmer travail emploi emplois impiego impieghi stellen stellenangebote stelle jobs job salario salari stipendio stipendi lohn lohne gehalt gehalter salaire salaires mindestlohn mindestlohne contratto contratti vertrag vertrage contrat contrats disoccupazione arbeitslos arbeitslosigkeit arbeitslosengeld arbeitslosenversicherung chomage indennita assunzione assunzioni licenziamento licenziamenti kundigung concorso concorsi ferie urlaub vacances infortuni infortunio karriere career recruiting azienda aziende unternehmen entreprise entreprises
infermiere infermieri infermiera infermiere medico ingegnere ingegneri insegnante insegnanti docente docenti cuoco cuochi muratore muratori elettricista elettricisti autista autisti cameriere camerieri commesso commessa operaio operai magazziniere magazzinieri pflege pflegefachfrau pflegefachmann pflegefachperson arzt arzte lehrer lehrerin elektriker informatiker informatica developer krankenschwester infirmier infirmiere enseignant meccanico meccanici idraulico giardiniere parrucchiere contabile avvocato architetto farmacista dentista zahnarzt educatore educatrice badante segretaria ristorazione gastronomia hotel cuisinier falegname saldatore carpentier ingenieur
lamal kvg krankenkasse krankenkassen krankenversicherung assicurazione assicurazioni versicherung versicherungen assurance assurances ospedale ospedali spital spitaler hopital hopitaux sanita gesundheit sante pramie pramien premi premio pramienverbilligung franchigia franchise medicina medicinali farmacia farmacie apotheke apotheken pharmacie cura cure pflegeversicherung invalidita soccorso notfall vaccino vaccini impfung sussidio sussidi prestazioni prestazione verbilligung pediatra ambulatorio
traffico verkehr trafic autostrada autostrade autobahn autoroute valico valichi grenzubergang grenzubergange dogana dogane zoll douane strada strade strasse strassen route routes cantiere cantieri baustelle baustellen chiusura chiusure sperrung gottardo gotthard tunnel treno treni train trains bahn tilo ffs sbb cff vignetta vignette autobus bus trasporti trasporto transport mobilita parcheggio parcheggi parking parkplatz coda stau bouchon patente fuhrerschein targa veicolo veicoli fahrzeug incidente incidenti unfall unfalle accident tram metro funivia aeroporto flughafen aeroport monopattino bici velo abbonamento abbonamenti billett biglietto biglietti ticket halbtax ciclabile ciclabili ferrovia bahnhof gare fahrplan
scuola scuole schule schulen ecole ecoles universita hochschule studio studi studium kita asilo nido maturita formazione ausbildung formation apprendistato lehre supsi usi eth epfl liceo gymnasium lycee scolastico scolastici scolastiche scolastica schulferien ferien
affitto affitti miete mieten loyer loyers locazione casa case wohnung wohnungen immobile immobili immobilien appartamento appartamenti logement alloggio alloggi mutuo mutui hypothek hypotheken hypotheque eigenmietwert sfratto condominio bolletta bollette strom elettricita energia energie riscaldamento rifiuti abfall dechets internet fibra comparatore immobiliare
eventi evento events event veranstaltungen veranstaltung concerto concerti concert festival fest feste markt mercato mercati marche carnevale fiera fiere sagra sagre spettacolo spettacoli mostra mostre museo musei museum musee cinema teatro theater gita escursione escursioni wanderung weihnachten weihnachtsmarkt natale capodanno feiertag feiertage festivita meteo wetter previsioni neve schnee piste sci lido piscina bagno badi sport calcio hockey
benzina benzin carburante carburanti carburant diesel tankstelle tankstellen essence gasolio distributore distributori ricarica colonnina lade gpl metano elettrico elettrica
cambio wechselkurs kurs franchi chf franc francs euro eur change devise valuta tasso tassi zins zinsen taux cripto bitcoin banca banche bank banken banque conto konto twint bonifico iban kreditkarte
assegni assegno familiari familiare kinderzulage kinderzulagen familienzulagen zulage zulagen allocation allocations congedo mutterschaft maternita paternita alimenti divorzio scheidung matrimonio heirat successione erbschaft eredita testamento adozione anziani senioren ems spitex bonus aiuti sozialhilfe assistenza
ufficio uffici amt amter office registro handelsregister registre anagrafe einwohnerkontrolle tribunale gericht tribunal polizia polizei police multa multe busse bussen amende legge leggi gesetz verordnung ordinanza bando ausschreibung gara appalto sondaggio votazione votazioni abstimmung votation elezioni wahlen election iniziativa referendum consiglio regierung gouvernement governo municipio gemeinde gemeinden commune communes dipartimento departement cantone kanton canton cantonale kantonal
`;

/** Parole generiche o funzionali: elenco ESATTO, niente prefissi ne' suffissi. */
const GENERIC_WORDS = `
anno anni annuale nuovo nuova nuovi nuove novita quanto quanti quanta costo costi come funziona funzionamento calcolo calcolare calcolatore tabella tabelle tariffa tariffe scadenza scadenze richiesta domanda modulo moduli orario orari apertura numero indirizzo contatti contatto sito ufficiale online guida requisiti durata importo limite limiti massimo massima minimo minima aumento riduzione oggi domani settimana mese mesi giorno giorni tempo tempi attesa quando dove cosa quale quali regole regola ultime ultimi fonte ancora sempre ogni tutto tutti senza sotto sopra oltre vicino nord sud est ovest centro piano differenza differenze diritto diritti obbligo possibile valido valida automatico esempio simulatore privato professionale personale secondo prima primo generale pubblico pubblica speciale lungo breve medio media totale netto lordo base dopo durante entro verso fino mezzo servizio servizi carta credito pronto offerte acqua potabile stazione borsa libero prezzo prezzi migliore migliori ticinese svizzera svizzero svizzeri svizzere italia italiano italiani frontiera confine comune comuni
jahr jahre jahres neue neuer neues neu wie viel wieviel hoch hohe hoher berechnen berechnung rechner tabelle tabellen tarif tarife frist fristen antrag antrage formular formulare offnungszeiten adresse kontakt anleitung voraussetzung voraussetzungen dauer betrag maximal minimal erhohung heute morgen woche wochen monat monate tage tag wartezeit wann welche regel regeln unterschied zwischen beruflich privat ohne nach unter uber vor bei beim fur gegen durch alle aktuell aktuelle aktuelles letzte mitte norden suden osten westen allgemein brutto netto gultig beispiel kosten preis preise liste ubersicht bedeutet gilt muss kann darf wird sind nicht oder und auch schweiz schweizer schweizerische italien
annee annees nouveau nouvelle nouveaux combien cout couts calcul calculer tableau delai delais demande formulaire horaire horaires contact guide condition conditions duree montant maximum minimum augmentation aujourd hui demain semaine mois jours jour attente quand quel quelle quels regle regles difference sans sous apres avant pour avec dans entre tous tout brut net valable exemple prix suisse italie
year years new how much cost costs calculator calculation table rate rates deadline application form hours address requirement requirements duration amount increase today tomorrow week month days waiting when where what which rules law swiss switzerland border cross worker workers without with after before between near gross valid example list price prices latest current average median total italy frontier
del dei della delle degli dello dal dalla dalle nel nella nelle sul sulla sulle con per tra fra che una uno gli non piu sono chi alla alle allo agli al da di in su il lo la le a e o ad ma dell dall nell sull all l d un
the and for from that this are was has have will into about of to on at by vs
der die das und mit von den dem des ein eine einer ist auf im am zum zur aus zu
les des une dans pour avec sur par est sont qui que aux du de la le en un et
`;

/** Anni ammessi (2020-2035) e pochi codici brevi di dominio. */
const YEAR_TOKENS = new Set(Array.from({ length: 16 }, (_, i) => String(2020 + i)));
const CODE_TOKENS = new Set(['b', 'c', 'g', 'l', 'ci', '1', '2', '3', '3a', '2a', 'a1', 'a2', 'a3', 'a4', 'a9', 'a13', 'a28']);

/** Cognomi molto frequenti (IT/DE/FR/EN): un toponimo uguale a uno di questi non entra nell'elenco dei luoghi. */
const COMMON_SURNAMES = new Set(list(`
rossi russo ferrari esposito bianchi romano colombo ricci marino greco bruno gallo conti de luca mancini costa giordano rizzo lombardi moretti barbieri fontana santoro mariani rinaldi caruso ferrara galli martini leone longo gentile martinelli vitale lombardo serra coppola desantis damico palumbo bernardi villa fiore ferri parisi bellini basile riva farina orlando sala sanna monti grasso pellegrini silvestri guidi
mueller muller meier meyer schmid schmidt schneider fischer weber huber keller wagner steiner moser baumann brunner gerber frei zimmermann hofmann hoffmann lehmann koch bauer richter klein wolf schroeder neumann schwarz zimmer braun krueger hartmann lang werner schulz becker maurer schreiner graf roth gasser kaufmann berger vogel bachmann ammann baumgartner favre fuchs ackermann suter widmer wyss weiss winkler arnold jung mayer
martin bernard dubois thomas robert richard petit durand leroy moreau simon laurent lefebvre michel garcia david bertrand roux vincent fournier morel girard andre mercier dupont lambert bonnet francois martinez
smith johnson williams brown jones miller davis wilson anderson taylor moore jackson white harris clark lewis walker hall allen young king wright scott green baker adams nelson hill campbell mitchell roberts carter phillips evans turner parker collins edwards stewart morris murphy cook rogers morgan cooper peterson reed bailey bell kelly howard ward cox
`));

const FIRST_NAME_EXTRA = new Set(list('mario luca marco paolo giuseppe giovanni antonio francesco andrea alessandro roberto stefano matteo davide simone fabio daniele michele claudio giorgio angelo massimo riccardo enrico sergio pietro carlo luigi lorenzo gabriele federico nicola maurizio gianni flavio diego emanuele salvatore vincenzo domenico raffaele alberto danilo elia samuele maria anna giulia francesca sara laura chiara elena paola silvia valentina alessandra roberta federica martina elisa monica barbara daniela stefania cristina simona claudia patrizia rita giovanna carla lucia angela teresa hans peter urs markus daniel martin stefan andreas christoph michael werner ernst fritz heinz rolf beat kurt reto roland jurg jorg klaus dieter matthias patrick lukas jean pierre jacques philippe alain louis marcel rene olivier nicolas julien eric pascal gilles yves marie nathalie isabelle sylvie catherine christine john james robert william paul mark kevin brian'));
const isFirstName = (token) => FIRST_NAME_EXTRA.has(token) || recognizeFirstName(token) !== null;
const isSurname = (token) => COMMON_SURNAMES.has(token);

function expandDomain(lemmas) {
  const out = new Set();
  for (const lemma of lemmas) {
    out.add(lemma);
    if (lemma.length >= 5) for (const suffix of DOMAIN_SUFFIXES) out.add(`${lemma}${suffix}`);
  }
  return out;
}

const FUNCTION_AND_GENERIC = new Set(list(GENERIC_WORDS));
/** Parole di dominio che sono anche un cognome frequente o un prenome della lista corta: tolte. Un prenome raro non basta a comporre una persona: serve anche un cognome, che qui non e' mai un token ammesso. */
const DOMAIN_NAME_COLLISIONS = [];
const DOMAIN_WORDS = (() => {
  const set = expandDomain(list(DOMAIN_LEMMAS));
  for (const token of [...set]) {
    if (token.length >= 3 && (isSurname(token) || FIRST_NAME_EXTRA.has(token))) { set.delete(token); DOMAIN_NAME_COLLISIONS.push(token); }
  }
  return set;
})();

/** Esposto per i test: elenchi chiusi (nessun testo di utente). */
export const FILTER_LISTS = Object.freeze({
  domainWordCount: DOMAIN_WORDS.size,
  genericWordCount: FUNCTION_AND_GENERIC.size,
  domainNameCollisions: DOMAIN_NAME_COLLISIONS,
  isDomainWord: (token) => DOMAIN_WORDS.has(token),
  isGenericWord: (token) => FUNCTION_AND_GENERIC.has(token),
});

const isDomainToken = (token) => DOMAIN_WORDS.has(token);
const isGenericToken = (token) => FUNCTION_AND_GENERIC.has(token) || YEAR_TOKENS.has(token) || CODE_TOKENS.has(token);

/** Codici cantone ammessi come riferimento al cantone (esclusi quelli che sono anche parole comuni). */
const AMBIGUOUS_CANTON_CODES = new Set(['so', 'be', 'ne', 'fr', 'lu', 'ur', 'ai', 'ar', 'bl', 'bs', 'vd']);
/** Sezione -> codici cantone coperti. */
const SECTION_CANTON_CODES = { 'canton-appenzello': ['AI', 'AR'], 'canton-basilea': ['BS', 'BL'] };
export const sectionCantonCodes = (section) => {
  if (SECTION_CANTON_CODES[section]) return SECTION_CANTON_CODES[section];
  const m = /^canton-([a-z]{2})$/.exec(String(section ?? ''));
  return m ? [m[1].toUpperCase()] : [];
};

const placeCache = new Map();

function loadJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return null; }
}

/** Una parola di un toponimo che lo renderebbe ambiguo (nome, cognome, dominio, generica). */
function placeWordIsAmbiguous(word, { dataset = true } = {}) {
  if (word.length < 3) return false; // particelle («sur», «bad») non decidono
  const firstName = dataset ? isFirstName(word) : FIRST_NAME_EXTRA.has(word);
  return isDomainToken(word) || FUNCTION_AND_GENERIC.has(word) || firstName || isSurname(word);
}

/**
 * Toponimi ammessi per UNA sezione: comuni del/dei suo/suoi cantoni (4 lingue
 * per i capoluoghi) e nomi del cantone. Mai i comuni di altri cantoni.
 * @returns {{communes: Set<string>, cantonRefs: Set<string>}}
 */
export function sectionPlaces(section) {
  if (placeCache.has(section)) return placeCache.get(section);
  const codes = sectionCantonCodes(section);
  const communes = new Set();
  const cantonRefs = new Set();
  const eligibleCommune = (phrase, dataset) => {
    const ws = words(phrase);
    if (ws.length === 0 || ws.length > 4) return false;
    if (ws.length === 1 && phrase.length <= 4) return false;
    return !ws.some((w) => placeWordIsAmbiguous(w, { dataset }));
  };
  // I capoluoghi sono nomi ufficiali del cantone: non vanno contro il dataset dei prenomi (es. «Basel»).
  const addCommune = (name, { dataset = true } = {}) => {
    const phrase = foldText(String(name ?? '').replace(/\([^)]*\)/g, ' '));
    if (phrase && eligibleCommune(phrase, dataset)) communes.add(phrase);
  };
  const addCanton = (name) => {
    const phrase = foldText(name);
    const ws = words(phrase);
    if (ws.length > 0 && ws.length <= 3 && !ws.some((w) => placeWordIsAmbiguous(w, { dataset: false }))) cantonRefs.add(phrase);
  };
  if (codes.length > 0) {
    const places = loadJson('canton-classifier-places.json');
    for (const code of codes) for (const name of places?.municipalities?.[code] || []) addCommune(name);
    for (const town of places?.towns || []) if (codes.includes(town?.canton)) addCommune(town?.name);
    const topo = loadJson('localized-toponyms.json');
    for (const entity of topo?.entities || []) {
      if (!codes.includes(entity?.code)) continue;
      for (const names of Object.values(entity?.canton || {})) for (const name of names || []) addCanton(name);
      for (const names of Object.values(entity?.capital || {})) for (const name of names || []) addCommune(name, { dataset: false });
    }
    for (const code of codes) {
      const lower = code.toLowerCase();
      if (!AMBIGUOUS_CANTON_CODES.has(lower)) cantonRefs.add(lower);
    }
    if (codes.includes('TI')) {
      const ti = loadJson('ticino-municipalities.json');
      for (const m of ti?.municipalities || []) addCommune(typeof m === 'string' ? m : (m?.name || m?.comune));
      cantonRefs.add('ticino');
    }
  }
  // Un nome di cantone non e' mai anche un comune da contare due volte.
  for (const ref of cantonRefs) communes.delete(ref);
  const result = { communes, cantonRefs };
  placeCache.set(section, result);
  return result;
}

const CONTACT_RE = /@|https?|www\.|\.(?:ch|com|net|org|it|de|fr|eu)\b/;
const DIGIT_RUN_RE = /\d[\d\s./-]{6,}\d|\d{5,}/;
const SYNTAX_RE = /[;"“”„«»()[\]{}<>|\\*=]|\bintitle:|\binurl:|\bsite:|\bfiletype:|\bAND\b|\bOR\b|:/;
const INCOME_RE = /\b(stipendio|stipendi|salario|salari|salaire|salaires|gehalt|gehaelter|lohn|loehne|reddito|redditi|patrimonio|income|salary|wage)\b/;
const FAMILY_RE = /\b(ehemann|ehefrau|moglie|marito|frau von|mann von|femme de|mari de|figlio|figlia|necrologio|obituary|morto|morta|deceduto|deceduta|todesanzeige|traueranzeige|verstorben|gestorben|decede|deces|compagno|compagna|fidanzat[oa])\b/;
const PERSON_CONTEXT_RE = /\b(di|von|de|of|du|des)\s+[a-z]+\s+[a-z]+\s*$/;

/**
 * @param {string} rawQuery  query GSC cosi' com'e'
 * @param {{section?: string}} [opts]  sezione di appartenenza: senza di essa nessun toponimo e' ammesso
 * @returns {{keep: boolean, reason: string|null}}
 */
export function classifyDemandQuery(rawQuery, { section = null } = {}) {
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
  if (FAMILY_RE.test(folded)) return { keep: false, reason: 'person_pattern' };

  const places = section ? sectionPlaces(section) : { communes: new Set(), cantonRefs: new Set() };
  let domainHit = false;
  let communeCount = 0;
  let cantonCount = 0;
  let unknown = 0;
  let firstNameHit = false;
  for (let i = 0; i < tokens.length;) {
    let matched = 0;
    for (let n = Math.min(4, tokens.length - i); n >= 1 && !matched; n -= 1) {
      const phrase = tokens.slice(i, i + n).join(' ');
      if (places.communes.has(phrase)) { communeCount += 1; matched = n; }
      else if (places.cantonRefs.has(phrase)) { cantonCount += 1; matched = n; }
    }
    if (matched) { i += matched; continue; }
    const token = tokens[i];
    if (isDomainToken(token)) domainHit = true;
    else if (!isGenericToken(token)) { unknown += 1; if (isFirstName(token)) firstNameHit = true; }
    i += 1;
  }

  const suspicious = unknown > 0 || firstNameHit;
  if (INCOME_RE.test(folded) && suspicious) return { keep: false, reason: 'person_pattern' };
  if (PERSON_CONTEXT_RE.test(folded) && suspicious) return { keep: false, reason: 'person_pattern' };
  if (firstNameHit) return { keep: false, reason: 'unknown_token' };
  if (unknown > 0) return { keep: false, reason: 'unknown_token' };
  if (communeCount + cantonCount > 1) return { keep: false, reason: 'toponym_excess' };
  if (!domainHit) return { keep: false, reason: 'no_domain' };

  // Una query a un solo token e' domanda su un argomento solo se il token e' un
  // composto specifico (>= 10 caratteri); i generici («benzina», «carburant»,
  // «frontaliere») e i toponimi soli no.
  if (tokens.length === 1 && (tokens[0].length < 10 || GENERIC_SINGLES.has(tokens[0]))) {
    return { keep: false, reason: 'generic' };
  }
  return { keep: true, reason: null };
}

const GENERIC_SINGLES = new Set(['carburante', 'carburant', 'frontaliere', 'frontalieri', 'frontaliers', 'frontalier', 'grenzgaenger', 'grenzganger', 'benzina', 'benzin', 'diesel', 'ticino', 'svizzera', 'lavoro', 'steuern', 'tasse', 'imposte', 'meteo', 'eventi', 'events', 'cambio', 'franco', 'euro']);

/** `true` se la query puo' restare nel vocabolario della sezione. */
export const isAllowedDemandQuery = (query, opts) => classifyDemandQuery(query, opts).keep;
