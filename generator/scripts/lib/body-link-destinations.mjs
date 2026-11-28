/**
 * Destinazioni dei link nel corpo degli articoli verso il resto del sito (F6.3b):
 * landing lavoro del cantone o della Svizzera, landing per professione e
 * professione x cantone. Le URL vengono SOLO da
 * `generator/data/body-link-destinations.json`, generato e verificato (200 +
 * canonical) da `scripts/ci/build-body-link-destinations.mjs` sulle sitemap
 * pubblicate: nessun percorso si scrive a mano e nessuna rete serve a
 * tempo di generazione.
 *
 * Precisione prima della copertura: l'ancora e' sempre il testo che c'e' gia'
 * nell'articolo e contiene la keyword della destinazione (il cantone insieme a
 * un termine di lavoro, oppure la professione). Se l'articolo non ha una
 * frase del genere non si aggiunge nessun link.
 */
import '../../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANTON_DISPLAY_NAMES } from '../../../engine/shared/cantonDisplayNames.mjs';
import { cantonTopicMatches, cantonTopicPaths } from './body-link-canton-topics.mjs';

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'body-link-destinations.json');
const LOCALES = ['it', 'en', 'de', 'fr'];

let cached = null;
export function loadBodyLinkDestinations(file = DATA_FILE) {
  if (file !== DATA_FILE) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cached) {
    try { cached = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { cached = null; }
  }
  return cached;
}

const L = '\\p{L}';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+').replace(/['’]/g, "['’]");
const alt = (list) => list.map(esc).join('|');
// Confini di parola che vedono anche le lettere accentate (\b no).
// Il trattino seguito da lettera esclude i composti («Basel-Landschaft» non e' «Basel»).
const word = (src) => new RegExp(`(?<![${L}\\p{N}])(?:${src})(?![${L}\\p{N}]|-[${L}])`, 'giu');

// ---------------------------------------------------------------- lavoro + cantone

// Solo locuzioni di ricerca di lavoro: «lavoro in Svizzera» nudo, «work in» o «lavorare»
// sono prosa generica (ex lavoratori, cronaca) e non meritano un link alla ricerca lavoro.
const JOB_HEAD = {
  it: ['offerte di lavoro', 'annunci di lavoro', 'posti di lavoro', 'opportunità di lavoro', 'ricerca di lavoro', 'cercare lavoro', 'trovare lavoro'],
  en: ['job offers', 'job vacancies', 'job openings', 'job search', 'jobs', 'vacancies'],
  de: ['Stellenangebote', 'Stellensuche', 'Jobsuche', 'Jobs'],
  fr: ['offres d’emploi', 'recherche d’emploi', 'chercher un emploi', 'trouver un emploi', 'emplois'],
};
const JOB_PREP = {
  it: '(?:in|a|nel|nella|nello|del|dello|della)\\s+(?:(?:il\\s+)?canton[ei]\\s+(?:di\\s+|del\\s+)?)?(?:il\\s+)?',
  en: '(?:in|across|within)\\s+(?:the\\s+)?(?:canton\\s+(?:of\\s+)?)?',
  de: '(?:in|im)\\s+(?:der\\s+)?(?:Kanton\\s+)?',
  fr: '(?:à|au|en|aux|dans\\s+le\\s+canton\\s+(?:de|du|d[’\'])\\s*)\\s*(?:l[’\']|le\\s+|la\\s+)?',
};
// «Svizzera» come destinazione nazionale; gli altri nomi vengono dalla tabella dei cantoni.
const COUNTRY_NAME = { it: ['Svizzera'], en: ['Switzerland'], de: ['der Schweiz', 'Schweiz'], fr: ['Suisse'] };

function cantonNames(code, locale) {
  const base = CANTON_DISPLAY_NAMES[code]?.[locale];
  const names = new Set(base ? [base] : []);
  if (code === 'ZH') ['Zurigo', 'Zurich', 'Zürich'].forEach((n) => names.add(n));
  if (code === 'NE') ['Neuchâtel', 'Neuchatel'].forEach((n) => names.add(n));
  if (code === 'SG') ['St. Gallen', 'St.Gallen', 'San Gallo', 'Saint-Gall'].forEach((n) => names.add(n));
  if (code === 'TI' && locale !== 'it') names.add('Ticino');
  return [...names];
}

// Livello OPZIONALE, SPENTO di default e da non accendere cosi' com'e': «Cantone di X» /
// «Kanton X» come ancora verso la landing lavoro di X. Condivide l'entita' (il cantone) ma
// non una locuzione di lavoro. Misurato il 2026-11-28 su 240 articoli recenti: porta la
// copertura da 3,8% a 44,6% ma la maggior parte degli esempi giudicati non e' pertinente
// (neve nei Grigioni, prezzi delle case, atti del Consiglio di Stato -> «cerca lavoro»).
// Resta per rendere riproducibile la misura (`measure-body-link-coverage --entity-anchors`).
const CANTON_PHRASE = {
  it: '(?:il\\s+)?(?:canton[ei]|Canton)\\s+(?:di\\s+|del\\s+)?',
  en: '(?:the\\s+)?canton\\s+(?:of\\s+)?',
  de: '(?:der\\s+)?Kanton\\s+',
  fr: '(?:le\\s+)?canton\\s+(?:de\\s+|du\\s+|d[’\'])\\s*',
};
const compiledEntity = new Map();
function entityMatchers(locale) {
  if (!compiledEntity.has(locale)) {
    compiledEntity.set(locale, Object.keys(CANTON_DISPLAY_NAMES).map((code) => ({
      id: `jobs-landing:${code}`, re: word(`${CANTON_PHRASE[locale]}(?:${alt(cantonNames(code, locale))})`),
    })));
  }
  return compiledEntity.get(locale);
}

const compiledJobs = new Map();
function jobsMatchers(locale) {
  if (compiledJobs.has(locale)) return compiledJobs.get(locale);
  const entries = [];
  for (const code of Object.keys(CANTON_DISPLAY_NAMES)) {
    entries.push({ id: `jobs-landing:${code}`, names: cantonNames(code, locale) });
  }
  entries.push({ id: 'jobs-landing:CH', names: COUNTRY_NAME[locale] });
  const head = alt(JOB_HEAD[locale]);
  const out = entries.map(({ id, names }) => ({
    id,
    re: word(`(?:${head})\\s+${JOB_PREP[locale]}(?:${alt(names)})`),
  }));
  compiledJobs.set(locale, out);
  return out;
}

// ---------------------------------------------------------------- professioni

// strong = il nome del mestiere non e' ambiguo e basta una frase di lavoro nella
// stessa frase; weak = nomi comuni («operai», «autisti», «impiegati») che
// compaiono in cronaca: servono solo con la formula esplicita «lavoro come ...».
const PROFESSIONS = [
  ['infermiere', true, { it: ['infermiere', 'infermieri', 'infermiera', 'infermiere', 'personale infermieristico'], en: ['nurse', 'nurses'], de: ['Krankenpfleger', 'Krankenpflegern', 'Krankenpflegerin', 'Krankenpflegerinnen', 'Pflegefachperson', 'Pflegefachpersonen', 'Pflegefachfrau', 'Pflegefachmann'], fr: ['infirmier', 'infirmiers', 'infirmière', 'infirmières'] }],
  ['operaio', false, { it: ['operaio', 'operai', 'operaia'], en: ['factory worker', 'factory workers', 'production worker', 'production workers'], de: ['Fabrikarbeiter', 'Produktionsmitarbeiter'], fr: ['ouvrier', 'ouvriers', 'ouvrière', 'ouvrières'] }],
  ['impiegato', false, { it: ['impiegato', 'impiegati', 'impiegata'], en: ['office clerk', 'office clerks'], de: ['Sachbearbeiter', 'Sachbearbeiterin'], fr: ['employé de bureau', 'employés de bureau'] }],
  ['ingegnere', true, { it: ['ingegnere', 'ingegneri'], en: ['engineer', 'engineers'], de: ['Ingenieur', 'Ingenieure', 'Ingenieuren', 'Ingenieurin'], fr: ['ingénieur', 'ingénieurs'] }],
  ['educatore', false, { it: ['educatore', 'educatori', 'educatrice', 'educatrici'], en: ['educator', 'educators'], de: ['Erzieher', 'Erzieherin', 'Erzieherinnen'], fr: ['éducateur', 'éducateurs', 'éducatrice', 'éducatrices'] }],
  ['autista', false, { it: ['autista', 'autisti'], en: ['driver', 'drivers'], de: ['Fahrer', 'Chauffeur', 'Chauffeure'], fr: ['chauffeur', 'chauffeurs'] }],
  ['muratore', true, { it: ['muratore', 'muratori'], en: ['mason', 'masons', 'bricklayer', 'bricklayers'], de: ['Maurer', 'Maurern'], fr: ['maçon', 'maçons'] }],
  ['cuoco', true, { it: ['cuoco', 'cuochi', 'cuoca'], en: ['cook', 'cooks'], de: ['Koch', 'Köche', 'Köchen', 'Köchin'], fr: ['cuisinier', 'cuisiniers', 'cuisinière', 'cuisinières'] }],
  ['cameriere', false, { it: ['cameriere', 'camerieri', 'cameriera'], en: ['waiter', 'waiters', 'waitress', 'waitresses'], de: ['Kellner', 'Kellnerin', 'Kellnerinnen'], fr: ['serveur', 'serveurs', 'serveuse', 'serveuses'] }],
  ['elettricista', true, { it: ['elettricista', 'elettricisti'], en: ['electrician', 'electricians'], de: ['Elektriker', 'Elektrikern', 'Elektrikerin'], fr: ['électricien', 'électriciens'] }],
  ['fisioterapista', true, { it: ['fisioterapista', 'fisioterapisti', 'fisioterapiste'], en: ['physiotherapist', 'physiotherapists'], de: ['Physiotherapeut', 'Physiotherapeuten', 'Physiotherapeutin'], fr: ['physiothérapeute', 'physiothérapeutes'] }],
  ['ostetrica', true, { it: ['ostetrica', 'ostetriche'], en: ['midwife', 'midwives'], de: ['Hebamme', 'Hebammen'], fr: ['sage-femme', 'sages-femmes'] }],
  ['oss', true, { it: ['operatore socio sanitario', 'operatori socio sanitari', 'operatore sociosanitario', 'operatori sociosanitari', 'operatore socio-sanitario', 'operatori socio-sanitari'], en: ['healthcare assistant', 'healthcare assistants'], de: ['Fachfrau Gesundheit', 'Fachmann Gesundheit', 'Fachpersonen Gesundheit'], fr: ['assistant en soins et santé communautaire', 'assistante en soins et santé communautaire'] }],
  ['ottico-optometrista', true, { it: ['ottico', 'ottici', 'optometrista', 'optometristi'], en: ['optician', 'opticians', 'optometrist', 'optometrists'], de: ['Optiker', 'Optikern', 'Optikerin', 'Optometrist', 'Optometristen'], fr: ['opticien', 'opticiens', 'optométriste', 'optométristes'] }],
  ['contabile', true, { it: ['contabile', 'contabili'], en: ['accountant', 'accountants'], de: ['Buchhalter', 'Buchhaltern', 'Buchhalterin'], fr: ['comptable', 'comptables'] }],
  ['assistente-sociale', true, { it: ['assistente sociale', 'assistenti sociali'], en: ['social worker', 'social workers'], de: ['Sozialarbeiter', 'Sozialarbeitern', 'Sozialarbeiterin', 'Sozialarbeitende'], fr: ['assistant social', 'assistante sociale', 'assistants sociaux'] }],
  ['macellaio', true, { it: ['macellaio', 'macellai'], en: ['butcher', 'butchers'], de: ['Metzger', 'Metzgern', 'Metzgerin'], fr: ['boucher', 'bouchers'] }],
  ['saldatore', true, { it: ['saldatore', 'saldatori'], en: ['welder', 'welders'], de: ['Schweisser', 'Schweissern', 'Schweißer', 'Schweißern'], fr: ['soudeur', 'soudeurs'] }],
  // Solo per le pagine «stipendio per professione» (F6.3d): nessuna landing lavoro a questi nomi.
  ['farmacista', false, { it: ['farmacista', 'farmacisti', 'farmacista'], en: ['pharmacist', 'pharmacists'], de: ['Apotheker', 'Apothekern', 'Apothekerin', 'Apothekerinnen'], fr: ['pharmacien', 'pharmaciens', 'pharmacienne'] }],
  ['psicologo', false, { it: ['psicologo', 'psicologi', 'psicologa', 'psicologhe'], en: ['psychologist', 'psychologists'], de: ['Psychologe', 'Psychologen', 'Psychologin', 'Psychologinnen'], fr: ['psychologue', 'psychologues'] }],
  ['architetto', true, { it: ['architetto', 'architetti', 'architetta'], en: ['architect', 'architects'], de: ['Architekt', 'Architekten', 'Architektin'], fr: ['architecte', 'architectes'] }],
];

const PROFESSION_HEAD = {
  it: '(?:lavoro|lavorare|posti?\\s+di\\s+lavoro|offerte\\s+di\\s+lavoro|annunci\\s+di\\s+lavoro|assunzion[ei]|ricerca)\\s+(?:di|da|come|per)\\s+(?:(?:un|uno|una|gli|le|i|dei|degli|delle)\\s+)?',
  en: '(?:jobs?|work|working|hiring|vacancies|openings|positions)\\s+(?:as|for)\\s+(?:an?\\s+|the\\s+)?',
  de: '(?:Arbeit|Jobs?|Stellen|Stelle|Stellenangebote|arbeiten)\\s+(?:als|für)\\s+(?:(?:einen|eine|ein|die|den)\\s+)?',
  fr: '(?:travail|travailler|emplois?|postes?|offres\\s+d[’\']emploi|recrutement)\\s+(?:comme|de|d[’\']|pour)\\s*(?:(?:un|une|des|les|l[’\'])\\s*)?',
};
// Contesto di lavoro nella stessa frase, richiesto agli alias «strong» nudi.
const JOB_CONTEXT = {
  it: /(?<!\p{L})(?:lavor|assun|post[io]\s+di|offert|stipend|salar|personale|professionist|carenza|impieg|occupaz|candidat|reclut|ricerc|contratt|formazione|diplom)/iu,
  en: /(?<!\p{L})(?:job|work|hire|hiring|recruit|vacanc|salar|wage|shortage|staff|employ|profession|career|training|contract)/iu,
  de: /(?<!\p{L})(?:arbeit|job|stelle|lohn|löhne|gehalt|fachkräft|personal|mangel|beruf|anstell|rekrut|ausbildung|vertrag)/iu,
  fr: /(?<!\p{L})(?:travail|emploi|embauch|recrut|poste|salaire|pénurie|personnel|profession|métier|carrière|formation|contrat)/iu,
};

// «poste comptable», «formation infirmière», «sistema contabile»: il nome del mestiere e' qui un
// aggettivo, non una persona. Misurato sugli articoli cantonali (F6.3d).
const ADJECTIVAL_PRECEDER = {
  it: /(?<!\p{L})(?:ufficio|uffici|servizio|servizi|sistema|sistemi|documento|documenti|bilancio|scrittura|scritture|registrazione|registrazioni|formazione|settore|ambito)\s+$/iu,
  en: /(?<!\p{L})(?:cook|engineer)ing\s+$/iu,
  de: /(?<!\p{L})(?:Pflege|Fach)\s+$/iu,
  fr: /(?<!\p{L})(?:médicale?s?\s+(?:et|ou)|soignante?s?\s+(?:et|ou)|poste|postes|formation|formations|soins|pièce|pièces|écriture|écritures|système|systèmes|norme|normes|service|services|équipe|équipes|activité|activités)\s+$/iu,
};

const compiledProfessions = new Map();
function professionMatchers(locale) {
  if (compiledProfessions.has(locale)) return compiledProfessions.get(locale);
  const out = PROFESSIONS.map(([slug, strong, aliases]) => {
    const names = alt([...new Set(aliases[locale])].sort((a, b) => b.length - a.length));
    return {
      slug, strong,
      phrase: word(`${PROFESSION_HEAD[locale]}(?:${names})`),
      bare: strong ? word(names) : null,
    };
  });
  compiledProfessions.set(locale, out);
  return out;
}

// Pagine tematiche per cantone: l'ancora e' la locuzione del tema (che c'e' gia'
// nel testo); il cantone viene dalla frase, poi dalla sezione, poi dall'hub nazionale.
const TOPIC_PHRASES = {
  'health-premiums': {
    it: ['premi di cassa malati', 'premi della cassa malati', 'premi delle casse malati', 'premi cassa malati', 'premi dell’assicurazione malattia', 'premi di assicurazione malattia', 'premi assicurazione malattia', 'premi malattia', 'premi LAMal', 'premi di LAMal'],
    en: ['health insurance premiums', 'health premiums', 'LAMal premiums', 'KVG premiums'],
    de: ['Krankenkassenprämien', 'Krankenkassenprämie', 'Krankenversicherungsprämien', 'Krankenversicherungsprämie', 'Prämien der Krankenkasse'],
    fr: ['primes d’assurance maladie', 'primes d’assurance-maladie', 'primes de caisse maladie', 'primes maladie', 'primes LAMal'],
  },
  'minimum-wage': {
    it: ['salario minimo', 'salari minimi'],
    en: ['minimum wage', 'minimum wages'],
    de: ['Mindestlohn', 'Mindestlöhne'],
    fr: ['salaire minimum', 'salaires minimaux'],
  },
};
const topicCtx = {
  word, alt, cantonNames, sentenceAround: (...a) => sentenceAround(...a),
  cantonCodes: Object.keys(CANTON_DISPLAY_NAMES),
  professionSlugs: PROFESSIONS.map(([slug]) => slug),
  professionAliases: (slug, locale) => PROFESSIONS.find(([s]) => s === slug)[2][locale],
};
const compiledTopics = new Map();
function topicMatchers(locale) {
  if (!compiledTopics.has(locale)) {
    compiledTopics.set(locale, Object.entries(TOPIC_PHRASES).map(([topic, byLocale]) => ({
      topic, re: word(alt([...byLocale[locale]].sort((a, b) => b.length - a.length))),
    })));
  }
  return compiledTopics.get(locale);
}
const compiledCantonMentions = new Map();
/** Primo cantone (con pagina del tema) nominato nella frase, altrimenti null. */
function cantonInSentence(sentence, locale, available) {
  if (!compiledCantonMentions.has(locale)) {
    compiledCantonMentions.set(locale, Object.keys(CANTON_DISPLAY_NAMES).map((code) => ({ code, re: word(alt(cantonNames(code, locale))) })));
  }
  let best = null;
  for (const { code, re } of compiledCantonMentions.get(locale)) {
    if (!available[code]) continue;
    re.lastIndex = 0;
    const m = re.exec(sentence);
    if (m && (!best || m.index < best.index)) best = { code, index: m.index };
  }
  return best?.code || null;
}

// Frasi che negano o escludono un effetto («non sono documentati effetti su salario
// minimo», «né con ...»): l'argomento e' citato per dire che NON c'entra, non e' un rinvio.
const DISCLAIMER = {
  it: /(?<!\p{L})(?:né|nè|non\s+(?:sono|è|risultano|viene|vengono)\s+(?:documentat|confermat|dimostrat|collegat|riportat)|non\s+(?:possono|può)\s+essere|non\s+(?:misura|cita|tratta|quantifica|presenta|contiene|offre|fornisce|include|comprende|riporta|indica|calcola|stima|dimostra|collega|chiarisce|specifica|menziona|mostra)|non\s+descrive|senza\s+(?:indicare|specificare|quantificare|precisare)|nemmeno|neppure|neanche|lascia\s+fuori|fuori\s+dal\s+testo|restano?\s+fuori|esclus[aeio](?!\p{L}))/iu,
  en: /(?<!\p{L})(?:nor|neither|not\s+(?:documented|confirmed|linked|reported)|no\s+documented|cannot\s+be|can\s?not\s+be|(?:does|do|did)\s+not\s+(?:measure|cite|mention|quantif|present|contain|offer|provide|include|cover|report|indicate|calculate|estimate|link|clarify|specify|show)|without\s+(?:specifying|stating|giving|quantifying|indicating)|not\s+even|leaves?\s+out|left\s+out|out\s+of\s+the\s+(?:text|scope)|outside\s+the\s+(?:text|scope)|excluded)/iu,
  de: /(?<!\p{L})(?:weder|noch|nicht\s+(?:dokumentiert|belegt|bestätigt|misst|nennt|beziffert|enthält|liefert|umfasst|berücksichtigt|erwähnt|behandelt|quantifiziert)|keine\s+dokumentierten|können\s+nicht|ausserhalb|ausgeklammert|nicht\s+einmal|aussen\s+vor|ohne\s+(?:anzugeben|zu\s+\p{L}+)|nicht\s+von\b[^.!?\n]*\bdie\s+Rede|(?:beziffert|nennt|misst|enthält|liefert|erwähnt|behandelt|quantifiziert|berücksichtigt)\b[^.!?\n]*\bnicht(?![\p{L}]))/iu,
  fr: /(?<!\p{L})(?:ni\s|pas\s+(?:documenté|confirmé|établi)|non\s+documenté|ne\s+peuvent\s+pas|ne\s+(?:mesure|cite|chiffre|contient|fournit|couvre|traite|mentionne|précise|présente|quantifie|donne)\s+pas|sans\s+(?:préciser|indiquer|quantifier)|pas\s+même|hors\s+du\s+texte|laisse\s+de\s+côté|exclu)/iu,
};
// Il salario minimo ha una pagina per cantone solo per alcuni cantoni: nelle altre
// sezioni cantonali il termine compare quasi solo in elenchi di temi o in contesti diversi.
const MINIMUM_WAGE_SECTIONS = new Set(['frontaliere', 'svizzera', 'canton-ge', 'canton-ne', 'canton-ju']);

function sentenceAround(text, start, end) {
  let a = start;
  while (a > 0 && !/[.!?\n]/.test(text[a - 1])) a -= 1;
  let b = end;
  while (b < text.length && !/[.!?\n]/.test(text[b])) b += 1;
  return text.slice(a, b);
}

export function cantonCodeOfSection(sectionName) {
  const m = /^canton-([a-z]+)$/.exec(sectionName || '');
  const code = m && m[1].toUpperCase();
  return code && CANTON_DISPLAY_NAMES[code] ? code : null;
}

/** id -> percorso nella lingua, per tutte le destinazioni dell'elenco. */
export function destinationPaths(locale, destinations = loadBodyLinkDestinations()) {
  const out = {};
  if (!destinations) return out;
  for (const [code, quad] of Object.entries(destinations.cantonLanding || {})) out[`jobs-landing:${code}`] = quad[locale];
  if (destinations.nationalLanding) out['jobs-landing:CH'] = destinations.nationalLanding[locale];
  for (const [slug, quad] of Object.entries(destinations.professionLanding || {})) out[`profession:TI/${slug}`] = quad[locale];
  for (const [key, quad] of Object.entries(destinations.professionCantonLanding || {})) out[`profession:${key}`] = quad[locale];
  for (const [topic, table] of Object.entries(destinations.topicLanding || {})) {
    for (const [code, quad] of Object.entries(table)) out[`topic:${topic}:${code}`] = quad[locale];
  }
  Object.assign(out, cantonTopicPaths(destinations, locale));
  return out;
}

/**
 * Matcher compatibile con `linkContentKeywords({ matcher })`: restituisce
 * {id, start, end, target}. `sectionName` decide quale landing di professione e'
 * pertinente: la sezione cantonale usa quello del PROPRIO cantone, la sezione
 * frontaliere quello del Ticino, le altre nessuno (un lettore svizzero generico
 * non ha un cantone).
 */
export function createBodyLinkMatcher({ sectionName = 'frontaliere', destinations = loadBodyLinkDestinations(), entityAnchors = false } = {}) {
  const cantonCode = cantonCodeOfSection(sectionName);
  const professionCode = cantonCode || (sectionName === 'frontaliere' ? 'TI' : null);
  return (text, locale) => {
    if (!destinations || !LOCALES.includes(locale) || !text) return [];
    const paths = destinationPaths(locale, destinations);
    const matches = [];
    for (const { id, re } of jobsMatchers(locale)) {
      const target = paths[id];
      if (!target) continue;
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) matches.push({ id, start: m.index, end: m.index + m[0].length, target });
    }
    if (entityAnchors) {
      for (const { id, re } of entityMatchers(locale)) {
        const target = paths[id];
        if (!target) continue;
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) matches.push({ id, start: m.index, end: m.index + m[0].length, target });
      }
    }
    if (professionCode) {
      for (const p of professionMatchers(locale)) {
        const id = `profession:${professionCode}/${p.slug}`;
        const target = paths[id];
        if (!target) continue;
        for (const m of text.matchAll(p.phrase)) matches.push({ id, start: m.index, end: m.index + m[0].length, target });
        if (!p.bare) continue;
        for (const m of text.matchAll(p.bare)) {
          const start = m.index; const end = start + m[0].length;
          if (!JOB_CONTEXT[locale].test(sentenceAround(text, start, end))) continue;
          if (ADJECTIVAL_PRECEDER[locale].test(text.slice(Math.max(0, start - 24), start))) continue;
          matches.push({ id, start, end, target });
        }
      }
    }
    for (const { topic, re } of topicMatchers(locale)) {
      const available = Object.fromEntries(Object.keys(CANTON_DISPLAY_NAMES).filter((c) => paths[`topic:${topic}:${c}`]).map((c) => [c, true]));
      for (const m of text.matchAll(re)) {
        const start = m.index; const end = start + m[0].length;
        const code = cantonInSentence(sentenceAround(text, start, end), locale, available)
          || (cantonCode && available[cantonCode] ? cantonCode : null)
          || (sectionName === 'frontaliere' && available.TI ? 'TI' : null)
          || 'CH';
        const id = `topic:${topic}:${code}`;
        if (paths[id]) matches.push({ id, start, end, target: paths[id] });
      }
    }
    if (cantonCode) matches.push(...cantonTopicMatches(text, locale, cantonCode, paths, topicCtx));
    const kept = matches.filter((m) => !DISCLAIMER[locale].test(sentenceAround(text, m.start, m.end))
      && (!m.id.startsWith('topic:minimum-wage:') || MINIMUM_WAGE_SECTIONS.has(sectionName)));
    // Priorita' al budget di link: ricerca lavoro e pagine tematiche prima dei mestieri.
    const order = (a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start);
    const isProfession = (m) => m.id.startsWith('profession:');
    return [...kept.filter((m) => !isProfession(m)).sort(order), ...kept.filter(isProfession).sort(order)];
  };
}
