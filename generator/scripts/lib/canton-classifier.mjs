/**
 * canton-classifier.mjs — a quali cantoni appartiene un articolo, in modo
 * DETERMINISTICO (nessun LLM): il campo multi-label `canton` del registry
 * (D13 del piano sezioni cantonali). Gli articoli `frontaliere`/`svizzera` non
 * si spostano: ricevono `canton: ['TI', ...]` e gli hub cantonali (D17) li
 * elencano come link, filtrando il corpus per questo campo.
 *
 * ## Cosa riconosce, e con che peso
 *
 * I 24 gruppi URL di `generator/data/canton-url-slugs.json` (AI/AR ->
 * APPENZELLO, BL/BS -> BASILEA). Per ogni gruppo:
 *   - il NOME del cantone in italiano, tedesco, francese, inglese (e romancio
 *     per i Grigioni), con la maiuscola: «Ticino», «Graubünden», «Valais»;
 *   - i DEMONIMI italiani: «ticinese», «vallesano», «zurighese»;
 *   - i COMUNI con almeno `townMinPopulation` abitanti
 *     (`generator/data/canton-classifier-places.json`, popolazione BFS) piu' i
 *     loro esonimi («Zurigo», «Coira», «Sciaffusa») e un piccolo elenco di
 *     capoluoghi, regioni e localita' note sotto la soglia («Altdorf»,
 *     «Engadina», «Zermatt»);
 *   - i COMUNI MINORI dello snapshot BFS (e le localita' ticinesi di
 *     `ticino-municipalities.json`), SOLO in forma locativa e mai seguiti da
 *     un'altra parola maiuscola: «a Coldrerio», «comune di Stabio», non
 *     «Sessa Aurunca». E' la regola di `local-news.mjs` per i nomi ticinesi
 *     ambigui, qui estesa a tutti i comuni minori di tutti i cantoni.
 * Un segnale forte esterno al testo: il DOMINIO della fonte, quando e' una
 * testata o un ente `.ch` di un solo cantone fra le `newsSources` di
 * `generator/data/canton-sections.json`.
 *
 * ## Omonimi e falsi amici (precisione prima del richiamo)
 *
 *   - un nome di comune presente in piu' cantoni (Buchs, Gossau, Reinach,
 *     Wohlen…) non conta mai: non dice quale cantone;
 *   - «Berna» e' quasi sempre il governo federale («Berna non vuole creare
 *     attriti con l'Italia»): Berna/Bern/Berne contano solo come «Canton(e)
 *     (di) Berna» o «citta' di Berna». Stesso trattamento per «Giura»/«Jura»
 *     (anche il verbo «giura», il massiccio e il dipartimento francese),
 *     «Zug» (in tedesco anche «treno») e «Freiburg» (Friburgo in Brisgovia);
 *   - frasi che nominano il luogo senza parlarne vengono cancellate prima di
 *     leggere: «Convenzione di Ginevra», «Basilea III», «Comitato di
 *     Basilea», «Baden-Württemberg», «Friburgo in Brisgovia», «Parco del
 *     Ticino», «Boffalora sopra Ticino», «bovaro bernese», Davos quando il
 *     testo parla del WEF;
 *   - residenza e provenienza di una persona non sono il luogo della notizia:
 *     «una 68enne residente nel canton Zurigo» in un incidente a Coldrerio non
 *     fa dell'articolo un articolo zurighese. Una menzione preceduta da
 *     residente/domiciliato/originario/proveniente/nato/immatricolato/targato
 *     nella stessa frase non conta;
 *   - una citta' con l'articolo e' una squadra («il Lugano batte il San
 *     Gallo»), un demonimo con l'indeterminativo e' una persona («un ticinese
 *     alla guida di…»), una parentesi dice il cantone dell'omonimo
 *     («Pfäffikon (Kanton Schwyz)»), un'istituzione non e' la citta' che la
 *     ospita («l'ETH di Zurigo» sul Bedretto).
 *
 * ## Assegnazione (precisione prima del richiamo)
 *
 * Il punteggio di un cantone somma i pesi delle menzioni per campo (titolo x3,
 * excerpt e tag x2, corpo x1, al massimo `BODY_TERM_CAP` occorrenze per termine
 * nel corpo) piu' il dominio della fonte. Poi `selectAssigned`:
 *   1. se il TITOLO nomina dei cantoni, sono quelli (al massimo
 *      `MAX_CANTONS`, con punteggio >= `MIN_SCORE`): un confronto nel corpo
 *      non fa del permesso B di Uri un articolo ticinese;
 *   2. se il titolo nomina un luogo italiano, o titolo/excerpt/attacco
 *      dichiarano una portata nazionale, nessuno;
 *   3. altrimenti l'excerpt deve nominare UN solo cantone con un luogo (non
 *      solo un demonimo), con almeno due termini distinti e punteggio >=
 *      `BODY_ONLY_MIN_SCORE`. Il solo corpo non basta mai: e' li' che il
 *      generatore scrive il paragrafo «cosa cambia per i frontalieri in
 *      Ticino», e per la stessa ragione la cornice del sito («per i frontalieri
 *      che lavorano in Ticino», FRAMING_PHRASES) non conta fuori dal titolo.
 * Il dominio della fonte aggiunge punti ma non ancora mai da solo un cantone.
 *
 * Misura del 2026-10-05 (backfill sui 6741 articoli frontaliere+svizzera):
 * 3021 articoli con almeno un cantone, campione di 50 verificato a mano nella
 * PR che introduce questo modulo.
 *
 * Solo builtin e moduli puri del corpus: lo importano il backfill
 * (`generator/scripts/backfill-article-cantons.mjs`), i test `node --test`
 * senza `npm ci` e `create-article.mjs` alla registrazione di un articolo.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANTON_TOPONYMS } from './cantone-toponimi-coerenza.mjs';
import { AMBIGUOUS_TICINO_NAMES, GENERIC_ALONE_TICINO_NAMES } from './local-news.mjs';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');

export const MIN_SCORE = 8;
export const RELATIVE_SHARE = 0.35;
export const MAX_CANTONS = 3;
/** Occorrenze massime di uno stesso termine contate nel corpo. */
export const BODY_TERM_CAP = 3;
/**
 * Soglia per un cantone che NON compare nel titolo (regola 3 di
 * selectAssigned): molti articoli su fatti nazionali o italiani nominano un
 * cantone come esempio nell'excerpt («una famiglia a Zurigo») o chiudono con un
 * paragrafo «cosa cambia per i frontalieri in Ticino».
 */
export const BODY_ONLY_MIN_SCORE = 18;
/**
 * Caratteri iniziali del corpo che contano come attacco della notizia («In
 * breve», «Fatti chiave»): un cantone che non e' nel titolo deve comparire
 * nell'excerpt o qui, non solo nel paragrafo di servizio in fondo.
 */
export const LEAD_CHARS = 1200;

/**
 * Luoghi italiani della fascia di confine e dintorni che non sono comuni di
 * `generator/data/municipalities.ts` (citta' maggiori, province, regioni,
 * valli). Un titolo che nomina un luogo italiano e nessun cantone parla del
 * lato italiano: «Spaccio di droga a Busto», «Tragedia a Porlezza».
 */
const ITALIAN_AREA_NAMES = [
  'Lombardia', 'Piemonte', 'Valle d\'Aosta', 'Milano', 'Monza', 'Brianza', 'Bergamo', 'Brescia',
  'Torino', 'Novara', 'Verbania', 'Verbano', 'VCO', 'Ossola', 'Domodossola', 'Varese', 'Varesotto',
  'Como', 'Comasco', 'Lecco', 'Sondrio', 'Valtellina', 'Valchiavenna', 'Chiavenna', 'Livigno',
  'Busto Arsizio', 'Busto', 'Saronno', 'Gallarate', 'Legnano', 'Malpensa', 'Cantù', 'Erba',
  'Tradate', 'Luino', 'Aosta', 'Pavia', 'Vigevano', 'Biella', 'Vercelli', 'Bormio', 'Tirano',
  'Morbegno', 'Menaggio', 'Cernobbio', 'Olgiate Comasco', 'Lomazzo', 'Cassano Magnago',
  'Somma Lombardo', 'Sesto Calende', 'Angera', 'Laveno', 'Stresa', 'Omegna', 'Cannobio',
  // Il paese: «Trump valuta riduzione truppe in Italia e Spagna», «Detrazioni
  // fiscali per frontalieri in Italia». Un titolo che nomina anche un cantone
  // resta del cantone (regola 1 di selectAssigned).
  'Italia',
];

export const FIELD_WEIGHTS = Object.freeze({ title: 3, excerpt: 2, tags: 2, body: 1 });
export const KIND_WEIGHTS = Object.freeze({
  name: 3,
  demonym: 2,
  town: 2,
  region: 2,
  municipality: 1.5,
});
/** Punti del dominio della fonte, quando appartiene a un solo cantone. */
export const SOURCE_DOMAIN_WEIGHT = 3;

/**
 * Nomi del cantone (gruppo URL). `guarded` = contano solo come «Canton(e) di
 * X» / «citta' di X»: da soli nominano altro.
 */
const CANTON_NAMES = {
  AG: { names: ['Argovia', 'Aargau', 'Argovie'] },
  APPENZELLO: {
    names: ['Appenzello', 'Appenzell', 'Appenzello Interno', 'Appenzello Esterno',
      'Appenzell Innerrhoden', 'Appenzell Ausserrhoden', 'Appenzell Rhodes-Intérieures',
      'Appenzell Rhodes-Extérieures'],
  },
  BASILEA: {
    names: ['Basilea', 'Basel', 'Bâle', 'Basilea Città', 'Basilea Campagna', 'Basel-Stadt',
      'Basel-Landschaft', 'Baselland', 'Bâle-Ville', 'Bâle-Campagne'],
  },
  BE: { names: [], guarded: ['Berna', 'Bern', 'Berne'] },
  FR: { names: ['Friburgo', 'Fribourg'], guarded: ['Freiburg'] },
  GE: { names: ['Ginevra', 'Genève', 'Genf', 'Geneva'] },
  GL: { names: ['Glarona', 'Glarus', 'Glaris'] },
  GR: { names: ['Grigioni', 'Graubünden', 'Grisons', 'Grischun'] },
  JU: { names: [], guarded: ['Giura', 'Jura'] },
  LU: { names: ['Lucerna', 'Luzern', 'Lucerne'] },
  NE: { names: ['Neuchâtel', 'Neuenburg'] },
  NW: { names: ['Nidvaldo', 'Nidwalden', 'Nidwald'] },
  OW: { names: ['Obvaldo', 'Obwalden', 'Obwald'] },
  SG: { names: ['San Gallo', 'St. Gallen', 'Sankt Gallen', 'Saint-Gall'] },
  SH: { names: ['Sciaffusa', 'Schaffhausen', 'Schaffhouse'] },
  SO: { names: ['Soletta', 'Solothurn', 'Soleure'] },
  SZ: { names: ['Svitto', 'Schwyz', 'Schwytz'] },
  TG: { names: ['Turgovia', 'Thurgau', 'Thurgovie'] },
  TI: { names: ['Ticino', 'Tessin'] },
  UR: { names: ['Uri'] },
  VD: { names: ['Vaud', 'Waadt'] },
  VS: { names: ['Vallese', 'Valais', 'Wallis'] },
  ZG: { names: ['Zugo', 'Zoug'], guarded: ['Zug'] },
  ZH: { names: ['Zurigo', 'Zürich'] },
};

/** Demonimi italiani (regex su parola intera, minuscole). */
const CANTON_DEMONYMS = {
  AG: ['argovies[ei]'],
  APPENZELLO: ['appenzelles[ei]'],
  BASILEA: ['basiles[ei]'],
  BE: ['bernes[ei]'],
  FR: ['friburghes[ei]'],
  GE: ['ginevrin[oaie]'],
  GL: ['glarones[ei]'],
  GR: ['grigiones[ei]'],
  JU: ['giurassian[oaie]'],
  LU: ['lucernes[ei]'],
  NE: ['neocastellan[oaie]'],
  NW: ['nidvaldes[ei]'],
  OW: ['obvaldes[ei]'],
  SG: ['sangalles[ei]'],
  SH: ['sciaffusan[oaie]'],
  SO: ['solettes[ei]'],
  SZ: ['svittes[ei]'],
  TG: ['turgovies[ei]'],
  TI: ['ticines[ei]'],
  UR: ['urans[ei]'],
  VD: ['vodes[ei]'],
  VS: ['vallesan[oaie]'],
  ZG: ['zughes[ei]', 'zugues[ei]'],
  ZH: ['zurighes[ei]'],
};

/**
 * Esonimi dei comuni del file dati (nome BFS -> altri nomi) e localita' sotto
 * soglia che un lettore italiano riconosce come «di quel cantone».
 * `regions` = valli, regioni, capoluoghi piccoli e localita' turistiche.
 */
const TOWN_EXONYMS = {
  'Zürich': ['Zurigo'],
  'Genève': ['Ginevra', 'Genf', 'Geneva'],
  'Basel': ['Basilea', 'Bâle'],
  'Lausanne': ['Losanna'],
  'Bern': [],
  'Luzern': ['Lucerna', 'Lucerne'],
  'St. Gallen': ['San Gallo', 'Sankt Gallen'],
  'Biel/Bienne': ['Bienne', 'Biel'],
  'Neuchâtel': ['Neuenburg'],
  'Chur': ['Coira'],
  'Fribourg': ['Friburgo'],
  'Schaffhausen': ['Sciaffusa'],
  'Sion': ['Sitten'],
  'Sierre': ['Siders'],
  'Solothurn': ['Soletta'],
  'Delémont': ['Delsberg'],
  'Zug': ['Zugo'],
  'Brig-Glis': ['Briga', 'Brig'],
  'Murten': ['Morat'],
};

const CANTON_REGIONS = {
  AG: [],
  APPENZELLO: ['Herisau', 'Appenzello Interno'],
  BASILEA: ['Liestal'],
  BE: ['Oberland bernese', 'Berner Oberland', 'Interlaken', 'Grindelwald', 'Gstaad', 'Bienne'],
  FR: ['Bulle', 'Gruyère', 'Gruyères', 'Morat'],
  GE: [],
  GL: ['Näfels'],
  GR: ['Coira', 'Davos', 'St. Moritz', 'Sankt Moritz', 'Saint-Moritz', 'Engadina', 'Engadin',
    'Valposchiavo', 'Val Poschiavo', 'Poschiavo', 'Brusio', 'Bregaglia', 'Val Bregaglia', 'Mesolcina',
    'Valle Mesolcina', 'Calanca', 'Val Calanca', 'Moesano', 'Roveredo', 'Mesocco', 'Grono',
    'Val Müstair', 'Surselva', 'Prettigovia', 'Klosters', 'Arosa', 'Lenzerheide',
    'Flims', 'Laax', 'Scuol', 'Pontresina', 'Samedan', 'Maloja', 'Ilanz', 'Landquart'],
  JU: ['Delémont', 'Porrentruy', 'Saignelégier', 'Franches-Montagnes'],
  LU: [],
  NE: ['Le Locle', 'Val-de-Travers'],
  NW: ['Stans', 'Hergiswil', 'Buochs', 'Stansstad'],
  OW: ['Sarnen', 'Engelberg', 'Alpnach'],
  SG: ['Rapperswil', 'Rheintal', 'Toggenburg'],
  SH: ['Neuhausen am Rheinfall'],
  SO: ['Olten', 'Grenchen'],
  SZ: ['Einsiedeln', 'Küssnacht', 'Brunnen'],
  TG: [],
  TI: ['Mendrisiotto', 'Luganese', 'Locarnese', 'Bellinzonese', 'Leventina', 'Blenio',
    'Valle di Blenio', 'Malcantone', 'Vallemaggia', 'Valle Maggia', 'Verzasca', 'Valle Verzasca',
    'Gambarogno', 'Valle Riviera', 'Capriasca', 'Collina d\'Oro'],
  UR: ['Altdorf', 'Andermatt', 'Erstfeld', 'Göschenen', 'Flüelen', 'Urserental'],
  VD: ['Losanna', 'Montreux', 'Vevey', 'Nyon', 'Morges', 'Yverdon', 'Yverdon-les-Bains', 'Aigle',
    'Villars-sur-Ollon', 'Leysin', 'Vallée de Joux', 'Château-d\'Oex', 'Payerne', 'Rolle'],
  VS: ['Briga', 'Zermatt', 'Saas-Fee', 'Saas Fee', 'Crans-Montana', 'Verbier', 'Leukerbad',
    'Martigny', 'Monthey', 'Visp', 'Goms', 'Alto Vallese', 'Oberwallis',
    'Basso Vallese', 'Unterwallis', 'Val d\'Anniviers', 'Champéry', 'Fiesch', 'Aletsch'],
  ZG: ['Baar', 'Cham'],
  ZH: ['Winterthur', 'Kloten', 'Uster', 'Dübendorf', 'Dietikon', 'Wädenswil', 'Horgen',
    'Oerlikon', 'Altstetten', 'Glattbrugg'],
};

/**
 * Frasi che nominano un luogo senza parlarne: cancellate prima di leggere.
 * Applicate al testo con diacritici gia' piegati (Ue -> U, ecc.).
 */
const EXCLUDED_PHRASES = [
  /Convenzion[ei]\s+(?:\w+\s+){0,2}di\s+Ginevra/giu,
  /Lago\s+(?:di\s+)?(?:Ginevra|Lemano)/giu,
  /Basilea\s*(?:III|IV|3|4)\b/gu,
  /\b(?:Comitato|Accord[oi]|Regole|Norme|Requisiti|regole|norme|requisiti|accordi)\s+di\s+Basilea/gu,
  /Baden[-\s]+(?:Wurttemberg|Wuerttemberg|Baden)/giu,
  /Friburgo\s+(?:in|im)\s+Br(?:isgovia|eisgau)/giu,
  /Freiburg\s+(?:im|in)\s+Breisgau/giu,
  /\b(?:Parco|parco|Valle|valle|fiume|Fiume|sponda|sponde|Consorzio|consorzio)\s+(?:\w+\s+){0,2}(?:del|dal)\s+Ticino/gu,
  /\b(?:sopra|sul|lungo\s+il|del\s+fiume)\s+Ticino/gu,
  /\b(?:Oleggio|Boffalora|Robecco|Bernate|Cassolnovo|Turbigo|Vizzola|Sesto\s+Calende|Vigevano|Pavia)\s+(?:sul\s+|sopra\s+)?Ticino/gu,
  /\bbovar[oi]\s+bernes[ei]/giu,
  /\bGiura\s+(?:francese|svevo|bavarese)/gu,
  /\bBriga\s+(?:Novarese|Alta)/gu,
  // Istituzioni con sede in una citta' che fanno notizia altrove: la ricerca
  // dell'ETH sul Bedretto (TI) non e' un articolo zurighese.
  /\b(?:Politecnico(?:\s+federale)?|ETH|EPF|EPFL|Universit[aà]|Ospedale\s+universitario|[Bb]orsa|[Pp]iazza\s+finanziaria|Aeroporto|aeroporto|scalo)\s+(?:di\s+|de\s+)?(?:Zurigo|Zurich|Losanna|Lausanne|Ginevra|Geneve|Basilea|Basel|Berna|Bern|Lucerna|Luzern|San\s+Gallo|St\.?\s+Gallen|Friburgo|Fribourg)/gu,
];

/**
 * La cornice del sito, non il luogo della notizia: «per i frontalieri che
 * lavorano in Ticino», «i lavoratori frontalieri del Ticino». Ogni articolo
 * della sezione frontaliere la ripete nell'excerpt o nel paragrafo di servizio
 * anche quando parla della precompilata italiana o dei dazi di Trump. Si
 * cancella dall'excerpt e dal corpo, NON dal titolo: «Vivere a Porlezza e
 * lavorare in Ticino» e' una guida sul lavoro in Ticino.
 */
const FRAMING_CANTONS = '(?:Ticino|Grigioni|Vallese|Svizzera)';
const FRAMING_PHRASES = [
  new RegExp(`\\b(?:frontalier[ei]|pendolar[ei]|lavorator[ei]|dipendent[ei]|residenti)['"»]?\\s+(?:[\\p{L}']+\\s+){0,3}(?:in|del|dal|nel|dei|verso\\s+il|per\\s+il)\\s+${FRAMING_CANTONS}\\b`, 'gu'),
  new RegExp(`\\b(?:lavor[\\p{L}]*|impieg[\\p{L}]*|occupat[\\p{L}]*|assunt[\\p{L}]*|frontalier[\\p{L}]*)\\s+(?:[\\p{L}']+\\s+){0,2}in\\s+${FRAMING_CANTONS}\\b`, 'gu'),
  /\b(?:frontalier[ei]|frontiera)\s+ticines[ei]\b/gu,
  /\bin\s+Ticino\s+e\s+in\s+Svizzera\b|\bin\s+Svizzera\s+e\s+in\s+Ticino\b/gu,
  /\bfrontalier[ei]\s+Ticino\b/gu,
  /\b(?:(?:per|al|nel|del)\s+)?(?:il\s+)?Ticino\s+e\s+(?:per\s+)?(?:i\s+)?frontalier[ei]\b/gu,
  /\bpendolar[\p{L}]*\s+(?:[\p{L}']+\s+){0,2}(?:in|verso|per)\s+(?:il\s+)?Ticino\b/gu,
];

/**
 * Articoli e preposizioni articolate davanti a una citta' fanno della citta'
 * una SQUADRA: «il Lugano batte il San Gallo», «contro lo Zurigo». Le citta'
 * in italiano non prendono l'articolo («a Lugano», «di San Gallo»); i
 * cantoni si' («il Ticino»), quindi la regola vale solo per i comuni.
 */
const CLUB_LEADS = new Set([
  'il', 'lo', 'del', 'dello', 'al', 'allo', 'dal', 'dallo', 'col', 'contro', 'sul', 'sullo',
]);

/** Articoli indeterminativi: «un ticinese», «una vallesana» sono persone. */
const PERSON_ARTICLES = new Set(['un', 'una', 'uno']);

/**
 * Portata nazionale dichiarata nel titolo, nell'excerpt o nell'attacco: una
 * classifica dei comuni svizzeri, una votazione federale. Senza un cantone nel
 * titolo, il comune in testa alla classifica non fa dell'articolo un articolo
 * di quel cantone.
 */
const NATIONAL_SCOPE_HEADLINE_RE = /\b(?:(?:in|della|dalla|nella|alla|la|tutta\s+la)\s+Svizzera|svizzer[ei]|elvetic[aoh]e?|nazional[ei]|cantoni)\b/u;
const NATIONAL_SCOPE_LEAD_RE = /\b(?:tutti\s+i\s+cantoni|comuni\s+svizzeri|cantoni\s+svizzeri|citta\s+svizzere|in\s+tutta\s+la\s+Svizzera|a\s+livello\s+nazionale|economia\s+(?:elvetica|svizzera))\b/u;

/** Testi che parlano del WEF: «Davos» e' il forum, non i Grigioni. */
const WEF_RE = /\b(?:WEF|World\s+Economic\s+Forum|Forum\s+economico\s+mondiale|Forum\s+di\s+Davos)\b/iu;

/** Parole che dicono residenza o provenienza di una persona. */
const ORIGIN_STEMS = [
  'resident', 'domiciliat', 'originari', 'provenient', 'immatricolat', 'targat',
  'abitant', 'nativ',
];
const ORIGIN_WORDS = new Set(['nato', 'nata', 'nati', 'nate', 'targa', 'targhe']);
const ORIGIN_WINDOW = 6;

/** Preposizioni che introducono un comune minore. */
const LOCATIVE_WORDS = new Set([
  'a', 'ad', 'in', 'di', 'da', 'presso', 'tra', 'fra', 'verso', 'd',
]);

/** Parole che fanno di un nome «guardato» il cantone: «Canton Berna». */
const CANTON_WORDS = new Set(['canton', 'cantone', 'cantoni', 'kanton', 'kantons', 'cantonale', 'cantonali']);
const CANTON_LINK_WORDS = new Set(['di', 'del', 'dei', 'della', 'dello', 'de', 'du', 'des', 'd', 'of']);

/**
 * Nomi del BFS che sono anche parole comuni o luoghi noti fuori dalla
 * Svizzera: non contano neppure in forma locativa.
 */
const MUNICIPALITY_STOPLIST = new Set([
  'monti', 'borgo', 'riviera', 'paradiso', 'campo', 'bosco', 'sala', 'quinto', 'tenero', 'pura',
  'contra', 'vira', 'onsernone', 'lema', 'agra', 'rivera', 'serravalle', 'sessa', 'manno', 'gudo',
  'melano', 'comano', 'cadro', 'piotta', 'lamone', 'isone', 'castione', 'torricella', 'vernate',
  'carona', 'curio', 'lumino', 'moleno', 'contone', 'quartino', 'taverne', 'rodi', 'vaglio',
  'montagnola', 'muzzano', 'lodrino', 'tresa', 'agno',
  'berg', 'wald', 'egg', 'rain', 'root', 'muri', 'hof', 'horn', 'dorf', 'land', 'stein', 'thal',
  'au', 'lens', 'bex', 'ins', 'aesch', 'buch', 'laufen', 'schwanden', 'linden', 'lauterbrunnen',
  'mont', 'vals', 'sils', 'bever', 'roma', 'rome', 'ecublens', 'chavannes', 'villars', 'corcelles',
  'gland', 'orbe', 'onex', 'bussy', 'mies', 'echo', 'nova', 'santa maria', 'bella', 'grand',
  'savognin', 'vaz',
  // Omonimi di localita' che lo snapshot BFS non elenca piu' (ex comuni
  // fusi): Brienz/Brinzauls (GR, frana del 2023) e' oggi Albula/Alvra, e
  // «Brienz» nel corpus e' quasi sempre lui, non Brienz BE.
  'brienz',
  // Aziende: «Offerte di lavoro a Roche» e' la Roche di Basilea, non Roche VD.
  'roche',
]);

function readJson(file) {
  return JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

/** Diacritici piegati, maiuscole conservate: «Zürich» -> «Zurich». */
export function foldKeepCase(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/ß/gu, 'ss')
    .replace(/[’‘`´]/gu, "'");
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

function phraseKey(display) {
  return [...foldKeepCase(display).matchAll(WORD_RE)].map((m) => m[0].toLowerCase()).join(' ');
}

/** Il nome BFS senza la sigla di disambiguazione: «Arni (AG)» -> «Arni». */
function bareName(name) {
  return String(name).replace(/\s*\([^)]*\)\s*/gu, ' ').trim();
}

/** Il dominio registrabile `.ch` di un URL o di un host: `media.tio.ch` -> `tio.ch`. */
export function registrableHost(urlOrHost) {
  let host = String(urlOrHost || '').trim().toLowerCase();
  if (!host) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//u.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return '';
    }
  } else {
    host = host.split('/')[0];
  }
  const labels = host.split('.').filter(Boolean);
  return labels.slice(-2).join('.');
}

/**
 * Testate ticinesi di `NEWS_SOURCES` in `create-article.mjs` che D12 tiene
 * fuori da `canton-sections.json` (la sezione `canton-ti` usa solo le fonti TI
 * NON gia' scansionate da `frontaliere`). Senza di loro il dominio della fonte
 * non direbbe nulla proprio sugli articoli frontaliere. Il test verifica che
 * ognuno compaia davvero fra le NEWS_SOURCES: una sorgente sola.
 */
export const FRONTALIERE_TICINO_SOURCE_HOSTS = Object.freeze([
  'ti.ch', 'ticinonews.ch', 'cdt.ch',
]);

/** Tipi di fonte che dicono il cantone: un sindacato nazionale o una camera no. */
const LOCAL_SOURCE_KINDS = new Set(['media', 'istituzionale', 'polizia']);

/**
 * Dominio registrabile -> gruppo, solo per i `.ch` di un solo cantone fra le
 * `newsSources` di canton-sections.json. Le testate estere della fascia di
 * confine (laprovinciadivarese.it, hochrhein-zeitung.de) parlano del lato
 * estero e non contano; un dominio di piu' cantoni (nau.ch, 20min.ch,
 * laregione.ch) neppure.
 */
export function buildSourceDomainMap(cantonSections) {
  const seen = new Map();
  for (const profile of cantonSections?.cantons || []) {
    for (const source of profile.newsSources || []) {
      const host = registrableHost(source.url);
      if (!host) continue;
      if (!seen.has(host)) seen.set(host, { cantons: new Set(), local: true });
      const entry = seen.get(host);
      entry.cantons.add(profile.code);
      if (!LOCAL_SOURCE_KINDS.has(source.kind)) entry.local = false;
    }
  }
  const out = new Map();
  for (const [host, { cantons, local }] of seen) {
    if (!host.endsWith('.ch') || !local || cantons.size !== 1) continue;
    out.set(host, [...cantons][0]);
  }
  for (const host of FRONTALIERE_TICINO_SOURCE_HOSTS) {
    if (!out.has(host)) out.set(host, 'TI');
  }
  return out;
}

/**
 * Costruisce il classificatore sui dati iniettati (stesso schema di
 * `cantonResolvers.mjs` del sito: puro, nessun fs qui dentro).
 *
 * @param {{ cantonSlugFile: any, placesFile: any, ticinoFile?: any, cantonSections?: any,
 *   italianComuni?: string[] }} data
 */
export function createCantonClassifier({
  cantonSlugFile, placesFile, ticinoFile = null, cantonSections = null, italianComuni = [],
}) {
  const groups = Object.keys(cantonSlugFile.cantons);
  const memberToGroup = {};
  for (const [group, info] of Object.entries(cantonSlugFile.cantonGroups || {})) {
    for (const member of info.members) memberToGroup[member] = group;
  }
  const toGroup = (code) => {
    const up = String(code || '').toUpperCase().trim();
    return memberToGroup[up] || (groups.includes(up) ? up : null);
  };

  /** phrase -> [{ group, kind, display, guarded, locativeOnly }] */
  const lexicon = new Map();
  let maxTokens = 1;
  const add = (display, group, kind, opts = {}) => {
    const key = phraseKey(display);
    if (!key) return;
    const list = lexicon.get(key) || [];
    if (list.some((e) => e.group === group && KIND_WEIGHTS[e.kind] >= KIND_WEIGHTS[kind])) return;
    const kept = list.filter((e) => !(e.group === group && KIND_WEIGHTS[e.kind] < KIND_WEIGHTS[kind]));
    kept.push({ group, kind, display, guarded: Boolean(opts.guarded), locativeOnly: Boolean(opts.locativeOnly) });
    lexicon.set(key, kept);
    maxTokens = Math.max(maxTokens, key.split(' ').length);
  };

  // Nomi dei cantoni (gruppi) e i toponimi del gate di coerenza (una sorgente).
  const TOPONYM_GROUP = { ticino: 'TI', grigioni: 'GR', vallese: 'VS' };
  for (const group of groups) {
    const spec = CANTON_NAMES[group] || { names: [] };
    for (const n of spec.names) add(n, group, 'name');
    for (const n of spec.guarded || []) add(n, group, 'name', { guarded: true });
  }
  for (const [key, toponyms] of Object.entries(CANTON_TOPONYMS)) {
    const group = TOPONYM_GROUP[key];
    if (!group) continue;
    for (const t of toponyms) {
      const display = t.charAt(0).toUpperCase() + t.slice(1);
      const isName = (CANTON_NAMES[group].names || []).some((n) => phraseKey(n) === phraseKey(display))
        || ['graubunden', 'graubuenden', 'tessin', 'wallis', 'valais', 'grisons'].includes(phraseKey(display));
      add(display === 'Graubuenden' ? 'Graubünden' : display, group, isName ? 'name' : 'town');
    }
  }
  for (const group of groups) {
    for (const n of CANTON_REGIONS[group] || []) add(n, group, 'region');
  }

  // Omonimi: un nome nudo presente in piu' cantoni (gruppi) non dice quale.
  const bareToGroups = new Map();
  const noteBare = (name, group) => {
    const key = phraseKey(bareName(name));
    if (!key) return;
    if (!bareToGroups.has(key)) bareToGroups.set(key, new Set());
    bareToGroups.get(key).add(group);
  };
  for (const [code, names] of Object.entries(placesFile.municipalities || {})) {
    const group = toGroup(code);
    if (!group) continue;
    for (const n of names) noteBare(n, group);
  }
  const ambiguousAcrossCantons = (key) => (bareToGroups.get(key)?.size || 0) > 1;

  // Comuni sopra soglia, con i loro esonimi. `cityKeys`: i nomi che sono
  // (anche) una citta', per la regola delle squadre (CLUB_LEADS).
  const cityKeys = new Set();
  const minPop = Number(placesFile.townMinPopulation) || 10000;
  for (const town of placesFile.towns || []) {
    if (!(Number(town.population) >= minPop)) continue;
    const group = toGroup(town.canton);
    if (!group) continue;
    const names = new Set([bareName(town.name), ...String(town.name).split('/').map(bareName)]);
    for (const n of names) {
      const key = phraseKey(n);
      if (ambiguousAcrossCantons(key)) continue;
      const isGuardedName = (CANTON_NAMES[group]?.guarded || []).some((g) => phraseKey(g) === key);
      add(n, group, 'town', { guarded: isGuardedName });
      cityKeys.add(key);
    }
    for (const exo of TOWN_EXONYMS[town.name] || []) {
      add(exo, group, 'town');
      cityKeys.add(phraseKey(exo));
    }
  }

  // Comuni minori: solo in forma locativa.
  const italian = new Set(italianComuni.map((n) => phraseKey(n)));
  const italianPlaces = new Set([...italian, ...ITALIAN_AREA_NAMES.map(phraseKey)]);
  let italianMaxTokens = 1;
  for (const k of italianPlaces) italianMaxTokens = Math.max(italianMaxTokens, k.split(' ').length);
  const stop = new Set([...MUNICIPALITY_STOPLIST,
    ...[...AMBIGUOUS_TICINO_NAMES].map(phraseKey), ...[...GENERIC_ALONE_TICINO_NAMES].map(phraseKey)]);
  const addMinor = (name, group) => {
    const base = bareName(name);
    for (const part of new Set([base, ...base.split('/')])) {
      const key = phraseKey(part);
      if (key.length < 5 || stop.has(key) || italian.has(key) || ambiguousAcrossCantons(key)) continue;
      if (lexicon.has(key) && lexicon.get(key).some((e) => !e.locativeOnly)) continue;
      add(part.trim(), group, 'municipality', { locativeOnly: true });
    }
  };
  for (const [code, names] of Object.entries(placesFile.municipalities || {})) {
    const group = toGroup(code);
    if (!group) continue;
    for (const n of names) addMinor(n, group);
  }
  for (const n of ticinoFile?.aliases || []) {
    const key = phraseKey(bareName(n));
    if ((bareToGroups.get(key)?.size || 0) > 0 && !bareToGroups.get(key).has('TI')) continue;
    addMinor(n, 'TI');
  }

  // Demonimi.
  const demonymRes = [];
  for (const group of groups) {
    for (const stem of CANTON_DEMONYMS[group] || []) {
      demonymRes.push({ group, re: new RegExp(`^(?:${stem})$`, 'u') });
    }
  }

  const sourceDomains = cantonSections ? buildSourceDomainMap(cantonSections) : new Map();

  function prepare(text, { framing = false } = {}) {
    let t = foldKeepCase(text)
      .replace(/\]\([^)]*\)/gu, '] ')
      .replace(/\b(?:https?:\/\/|www\.)\S+/giu, ' ');
    for (const re of EXCLUDED_PHRASES) t = t.replace(re, (m) => ' '.repeat(m.length));
    if (framing) for (const re of FRAMING_PHRASES) t = t.replace(re, (m) => ' '.repeat(m.length));
    if (WEF_RE.test(t)) t = t.replace(/\bDavos\b/gu, '     ');
    return t;
  }

  function tokensOf(text) {
    return [...text.matchAll(WORD_RE)].map((m) => ({
      raw: m[0],
      norm: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
      upper: /^\p{Lu}/u.test(m[0]),
    }));
  }

  /** Separatore fra due token: un punto o un a capo chiude la frase. */
  const sentenceBreak = (text, a, b) => /[.!?;:\n]/u.test(text.slice(a.end, b.start));

  function isOriginContext(text, tokens, i) {
    for (let k = i - 1; k >= 0 && k >= i - ORIGIN_WINDOW; k -= 1) {
      if (sentenceBreak(text, tokens[k], tokens[k + 1])) return false;
      const w = tokens[k].norm;
      if (ORIGIN_WORDS.has(w) || ORIGIN_STEMS.some((s) => w.startsWith(s))) return true;
    }
    return false;
  }

  function isCantonContext(text, tokens, i) {
    let k = i - 1;
    if (k >= 0 && CANTON_LINK_WORDS.has(tokens[k].norm) && !sentenceBreak(text, tokens[k], tokens[i])) k -= 1;
    if (k < 0 || sentenceBreak(text, tokens[k], tokens[k + 1])) return false;
    if (CANTON_WORDS.has(tokens[k].norm)) return true;
    // «citta' di Berna», «Stadt Bern», «ville de Berne»
    return ['citta', 'stadt', 'ville', 'city'].includes(tokens[k].norm);
  }

  /**
   * «Pfäffikon (Kanton Schwyz)», «Birsfelden (BL)»: la parentesi dice il
   * cantone del luogo. Se e' un altro cantone, il nome omonimo non conta.
   */
  function explicitOtherCanton(text, end, group) {
    const m = /^\s*\(\s*(?:(?:Kanton|Cantone?|canton|cantone?)\s+(?:(?:di|del|de|du)\s+)?)?([^()]{2,40})\)/u.exec(text.slice(end));
    if (!m) return false;
    const label = m[1].trim();
    const byCode = /^[A-Z]{2}$/u.test(label) ? toGroup(label) : null;
    const byName = byCode || (lexicon.get(phraseKey(label)) || []).find((e) => e.kind === 'name')?.group || null;
    return Boolean(byName) && byName !== group;
  }

  /** «un ticinese alla guida di…»: una persona, non un luogo (local-news.mjs). */
  function isPersonDemonym(text, tokens, i) {
    const k = i - 1;
    if (k < 0 || sentenceBreak(text, tokens[k], tokens[i])) return false;
    return PERSON_ARTICLES.has(tokens[k].norm);
  }

  function isClubContext(text, tokens, i) {
    const k = i - 1;
    if (k < 0 || sentenceBreak(text, tokens[k], tokens[i])) return false;
    return CLUB_LEADS.has(tokens[k].norm);
  }

  function isLocative(text, tokens, i) {
    const k = i - 1;
    if (k < 0 || sentenceBreak(text, tokens[k], tokens[i])) return false;
    return LOCATIVE_WORDS.has(tokens[k].norm);
  }

  /** «Gordola: revocato…», «Stabio, la dogana…»: il nome apre la frase. */
  function isDateline(text, tokens, i, j) {
    const opens = i === 0 || sentenceBreak(text, tokens[i - 1], tokens[i]);
    return opens && /^\s*[:,\u2013\u2014]/u.test(text.slice(tokens[j].end));
  }

  function followedByCapital(text, tokens, j) {
    const next = tokens[j + 1];
    if (!next || !next.upper) return false;
    const gap = text.slice(tokens[j].end, next.start);
    return /^[\s'-]+$/u.test(gap);
  }

  /**
   * Menzioni di un testo: [{ group, kind, term, start }].
   * @param {string} rawText
   */
  function mentionsIn(rawText, { framing = false, keepUnconfirmed = false } = {}) {
    const text = prepare(rawText, { framing });
    const tokens = tokensOf(text);
    const out = [];
    for (let i = 0; i < tokens.length; i += 1) {
      // demonimi: minuscole o inizio frase
      for (const { group, re } of demonymRes) {
        if (re.test(tokens[i].norm) && !isOriginContext(text, tokens, i) && !isPersonDemonym(text, tokens, i)) {
          out.push({ group, kind: 'demonym', term: tokens[i].norm, start: tokens[i].start });
        }
      }
      if (!tokens[i].upper) continue;
      // frase piu' lunga che combacia, a partire da i
      let best = null;
      for (let n = Math.min(maxTokens, tokens.length - i); n >= 1; n -= 1) {
        let ok = true;
        for (let k = i; k < i + n - 1; k += 1) {
          if (!/^[\s.'/-]+$/u.test(text.slice(tokens[k].end, tokens[k + 1].start))) { ok = false; break; }
        }
        if (!ok) continue;
        const key = tokens.slice(i, i + n).map((t) => t.norm).join(' ');
        if (lexicon.has(key)) { best = { key, n }; break; }
      }
      if (!best) continue;
      const j = i + best.n - 1;
      const origin = isOriginContext(text, tokens, i);
      for (const entry of lexicon.get(best.key)) {
        if (origin) continue;
        const unconfirmed = entry.guarded && !isCantonContext(text, tokens, i);
        if (unconfirmed && !keepUnconfirmed) continue;
        if (entry.locativeOnly
          && ((!isLocative(text, tokens, i) && !isDateline(text, tokens, i, j)) || followedByCapital(text, tokens, j))) continue;
        if (cityKeys.has(best.key) && isClubContext(text, tokens, i)) continue;
        if (entry.kind !== 'name' && explicitOtherCanton(text, tokens[j].end, entry.group)) continue;
        if (entry.kind === 'name' && entry.group === 'UR' && followedByCapital(text, tokens, j)) continue;
        out.push({
          group: entry.group, kind: entry.kind, term: entry.display, start: tokens[i].start,
          ...(unconfirmed ? { unconfirmed: true } : {}),
        });
      }
      i = j;
    }
    return out;
  }

  /** Il testo nomina (con la maiuscola) un luogo italiano? */
  function mentionsItalianPlace(rawText) {
    const tokens = tokensOf(prepare(rawText));
    for (let i = 0; i < tokens.length; i += 1) {
      if (!tokens[i].upper) continue;
      for (let n = Math.min(italianMaxTokens, tokens.length - i); n >= 1; n -= 1) {
        if (italianPlaces.has(tokens.slice(i, i + n).map((t) => t.norm).join(' '))) return true;
      }
    }
    return false;
  }

  /**
   * Punteggi per tutti i gruppi menzionati, ordinati per punteggio.
   * @returns {Array<{canton: string, score: number, anchored: boolean, assigned: boolean,
   *   evidence: Array<{term: string, field: string, kind: string, count: number}>}>}
   */
  function scoreCantons({ title = '', excerpt = '', body = '', sourceUrl = '', tags = [] } = {}) {
    const fields = {
      title: String(title || ''),
      excerpt: String(excerpt || ''),
      tags: Array.isArray(tags) ? tags.join('. ') : String(tags || ''),
      body: String(body || ''),
    };
    const per = new Map();
    const slot = (group) => {
      if (!per.has(group)) per.set(group, { score: 0, evidence: new Map(), headline: false, inTitle: false, inExcerpt: false, excerptPlace: false, lead: false, terms: new Set(), bodyTerms: new Set(), bodyCount: 0 });
      return per.get(group);
    };
    // «Asilo nido Berna: tariffe…»: nel titolo un nome «guardato» senza
    // «Canton(e)» conta se l'excerpt o l'attacco del corpo nominano lo stesso
    // cantone come cantone («nel Cantone di Berna»). Senza conferma resta il
    // governo federale («Berna non vuole creare attriti»).
    const perField = Object.entries(fields).map(([field, text]) => [
      field,
      text ? mentionsIn(text, { framing: field !== 'title', keepUnconfirmed: field === 'title' }) : [],
    ]);
    const confirmedNames = new Set(perField.flatMap(([field, ms]) => ms
      .filter((m) => m.kind === 'name' && !m.unconfirmed && (field !== 'body' || m.start < LEAD_CHARS))
      .map((m) => m.group)));
    for (const [field, mentions] of perField) {
      const counts = new Map();
      for (const m of mentions) {
        if (m.unconfirmed && !confirmedNames.has(m.group)) continue;
        const key = `${m.group}\u0000${m.term}\u0000${m.kind}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        if (field === 'body' && m.start < LEAD_CHARS) slot(m.group).lead = true;
      }
      for (const [key, count] of counts) {
        const [group, term, kind] = key.split('\u0000');
        const s = slot(group);
        const counted = field === 'body' ? Math.min(count, BODY_TERM_CAP) : Math.min(count, 1);
        s.score += KIND_WEIGHTS[kind] * FIELD_WEIGHTS[field] * counted;
        const evKey = `${field}\u0000${term}`;
        const prev = s.evidence.get(evKey);
        s.evidence.set(evKey, { term, field, kind, count: (prev?.count || 0) + count });
        s.terms.add(phraseKey(term));
        if (field === 'body') {
          s.bodyTerms.add(phraseKey(term));
          s.bodyCount += count;
        } else {
          s.headline = true;
          if (field === 'title') s.inTitle = true;
          else {
            s.inExcerpt = true;
            if (kind !== 'demonym') s.excerptPlace = true;
          }
        }
      }
    }
    const host = registrableHost(sourceUrl);
    const domainGroup = host ? sourceDomains.get(host) : undefined;
    if (domainGroup) {
      const s = slot(domainGroup);
      s.score += SOURCE_DOMAIN_WEIGHT;
      s.evidence.set(`source\u0000${host}`, { term: host, field: 'source', kind: 'domain', count: 1 });
    }

    const rows = [...per.entries()].map(([canton, s]) => ({
      canton,
      score: Math.round(s.score * 10) / 10,
      headline: s.headline,
      inTitle: s.inTitle,
      inExcerpt: s.inExcerpt,
      excerptPlace: s.excerptPlace,
      distinctTerms: s.terms.size,
      lead: s.headline || s.lead,
      anchored: s.headline || s.bodyTerms.size >= 2,
      evidence: [...s.evidence.values()].sort((a, b) => FIELD_ORDER[a.field] - FIELD_ORDER[b.field] || b.count - a.count),
      assigned: false,
    })).sort((a, b) => b.score - a.score || a.canton.localeCompare(b.canton));

    const foreignTitle = mentionsItalianPlace(fields.title);
    const nationalScope = NATIONAL_SCOPE_HEADLINE_RE.test(foldKeepCase(`${fields.title}\n${fields.excerpt}`))
      || NATIONAL_SCOPE_LEAD_RE.test(foldKeepCase(fields.body.slice(0, LEAD_CHARS)));
    for (const r of selectAssigned(rows, { foreignTitle, nationalScope })) r.assigned = true;
    return rows;
  }

  /**
   * Quali righe assegnare (vedi l'intestazione, «Assegnazione»).
   *   1. Il titolo nomina dei cantoni: sono quelli, e solo quelli. Un
   *      confronto nel corpo («a differenza del Ticino…») non fa del permesso B
   *      di Uri un articolo ticinese. Piu' di MAX_CANTONS nel titolo = elenco
   *      nazionale: nessuno.
   *   2. Il titolo nomina un luogo italiano e nessun cantone: l'articolo
   *      parla del lato italiano, qualunque cosa dica il corpo. Lo stesso se
   *      titolo, excerpt o attacco dichiarano una portata nazionale
   *      (NATIONAL_SCOPE_*): una classifica dei comuni svizzeri non e'
   *      l'articolo del comune in testa.
   *   3. Altrimenti l'excerpt (o i tag) deve nominare UN solo cantone, con un
   *      luogo e non solo un demonimo («l'economia ticinese» e' spesso la
   *      cornice), almeno due termini distinti nell'articolo e la soglia piu' alta
   *      BODY_ONLY_MIN_SCORE. Il solo corpo non basta mai: e' li' che il
   *      generatore aggiunge il paragrafo «cosa cambia per i frontalieri in
   *      Ticino»; piu' cantoni nell'excerpt sono un confronto.
   */
  function selectAssigned(rows, { foreignTitle = false, nationalScope = false } = {}) {
    const strong = (r) => r.anchored && r.score >= MIN_SCORE;
    const titled = rows.filter((r) => r.inTitle);
    if (titled.length > 0) {
      if (titled.length > MAX_CANTONS) return [];
      return titled.filter(strong);
    }
    if (foreignTitle || nationalScope) return [];
    // Un excerpt che nomina piu' cantoni senza che il titolo ne nomini uno e'
    // un confronto o una rassegna («in molti cantoni», «Ticino e Grigioni»).
    const excerpted = rows.filter((r) => r.inExcerpt);
    if (excerpted.length !== 1) return [];
    const top = rows[0]?.score || 0;
    const eligible = excerpted.filter((r) => strong(r) && r.excerptPlace && r.distinctTerms >= 2
      && r.score >= Math.max(MIN_SCORE, BODY_ONLY_MIN_SCORE) && r.score >= RELATIVE_SHARE * top);
    if (eligible.length <= MAX_CANTONS) return eligible;
    return eligible[0].score >= 2 * eligible[1].score ? [eligible[0]] : [];
  }

  function classifyCantons(input) {
    return scoreCantons(input)
      .filter((r) => r.assigned)
      .map(({ canton, score, evidence }) => ({ canton, score, evidence }));
  }

  /**
   * Il testo nomina un luogo del cantone (gruppo URL o codice membro)?
   * Generalizza `isInLocalNewsArea` di local-news.mjs, cablata su TI.
   */
  function isInCantonArea(canton, text) {
    const group = toGroup(canton);
    if (!group || !text) return false;
    return mentionsIn(String(text)).some((m) => m.group === group);
  }

  return {
    classifyCantons, scoreCantons, isInCantonArea, mentionsIn, mentionsItalianPlace, groups: Object.freeze([...groups]),
  };
}

const FIELD_ORDER = { title: 0, excerpt: 1, tags: 2, source: 3, body: 4 };

/** I nomi dei comuni italiani di confine (`generator/data/municipalities.ts`, letto come testo). */
export function readItalianComuni(source) {
  return [...String(source || '').matchAll(/\bname:\s*'((?:[^'\\]|\\.)*)'/gu)].map((m) => m[1].replace(/\\'/gu, "'"));
}

let _default = null;

/** Il classificatore sui dati committati del corpus (caricati una volta). */
export function defaultCantonClassifier() {
  if (_default) return _default;
  let italianComuni = [];
  try {
    italianComuni = readItalianComuni(readFileSync(path.join(DATA_DIR, 'municipalities.ts'), 'utf8'));
  } catch {
    italianComuni = [];
  }
  _default = createCantonClassifier({
    cantonSlugFile: readJson('canton-url-slugs.json'),
    placesFile: readJson('canton-classifier-places.json'),
    ticinoFile: readJson('ticino-municipalities.json'),
    cantonSections: readJson('canton-sections.json'),
    italianComuni,
  });
  return _default;
}

/**
 * Gli input del classificatore da un articolo nella forma del generatore
 * (`data.content.it` con title, excerpt, body1..bodyN).
 */
export function cantonInputFromArticle(data, sourceUrl = '') {
  const it = data?.content?.it || {};
  const body = Object.keys(it)
    .filter((k) => /^body\d+$/u.test(k) && typeof it[k] === 'string')
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    .map((k) => it[k])
    .join('\n\n');
  return {
    title: String(it.title || ''),
    excerpt: String(it.excerpt || ''),
    body,
    sourceUrl: String(sourceUrl || data?.sourceUrl || ''),
  };
}

/**
 * I codici `canton` da scrivere nel registry per un articolo nuovo.
 * @returns {string[]}
 */
export function registryCantonsForArticle(data, sourceUrl = '', classifier = defaultCantonClassifier()) {
  return classifier.classifyCantons(cantonInputFromArticle(data, sourceUrl)).map((c) => c.canton);
}

/**
 * @param {{title?: string, excerpt?: string, body?: string, sourceUrl?: string, tags?: string[]}} input
 * @returns {Array<{canton: string, score: number, evidence: Array<{term: string, field: string, kind: string, count: number}>}>}
 */
export function classifyCantons(input) {
  return defaultCantonClassifier().classifyCantons(input);
}

/**
 * @param {string} canton codice gruppo URL (TI, BASILEA) o membro (BL, AI)
 * @param {string} text
 * @returns {boolean}
 */
export function isInCantonArea(canton, text) {
  return defaultCantonClassifier().isInCantonArea(canton, text);
}
