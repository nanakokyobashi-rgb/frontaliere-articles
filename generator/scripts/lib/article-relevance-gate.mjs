/**
 * article-relevance-gate.mjs — il nesso editoriale di un articolo, deciso senza
 * modelli.
 *
 * ## Il difetto
 *
 * Audit GEO del 2026-10-31: `como-napoli-pareggio-2026`,
 * `openjobmetis-trieste-vittoria-kastritis`, `blackout-internet-iran-70-giorni`,
 * `burraco-solidale-buguggiate` e il muro di Big Bend in Texas erano pubblicati,
 * indicizzati e citabili da un sito che parla di frontalieri, Ticino e Svizzera.
 *
 * ## Perche' il corpo non decide
 *
 * Il corpo generato si piega all'angolo che il prompt pretende: l'articolo sul
 * Texas dice «svizzer» 58 volte, quello sull'Iran «frontalier» 10 volte. Contare
 * le parole del corpo premia proprio il riempitivo che il gate deve fermare, e
 * lo stesso vale per l'excerpt («potrebbe avere implicazioni per la Svizzera»).
 * Il segnale affidabile e' cio' di cui l'articolo dichiara di parlare: titolo e
 * id. Per questo la regola forte guarda solo quelli.
 *
 * ## Le due regole, in ordine
 *
 * `fuori-tema`: titolo o id cadono in una famiglia che non ha nesso per
 * definizione (sport, giochi, esteri) e titolo e id non nominano frontalieri,
 * Ticino, Svizzera, confine o lavoro. Una squadra della provincia di Varese non
 * e' un nesso: `openjobmetis-trieste-vittoria-kastritis` resta fuori anche se
 * Varese e' nell'area locale; l'Ambri' Piotta o il FC Lugano restano dentro.
 *
 * `senza-ancore`, solo per la sezione frontaliere: nessun nesso in titolo, id ed
 * excerpt, nessun luogo dell'area locale, e nemmeno una parola forte nel corpo.
 * Qui il corpo serve solo a salvare: un titolo muto con un corpo che parla di
 * Svizzera resta dentro. Le sezioni svizzera e cantonali non la applicano: sono
 * svizzere per costruzione, e un titolo su Herisau o su Sulzer non ha bisogno di
 * dire «Svizzera».
 *
 * ## Precisione prima del richiamo
 *
 * Un falso positivo toglie dall'indice una pagina buona; un falso negativo
 * lascia una pagina debole dov'era. La decisione del proprietario del 2026-09-25
 * (`local-news.mjs`) resta in piedi per Ticino e per la cronaca e la cultura
 * delle province di confine: questa regola restringe solo sport e giochi delle
 * province italiane, come chiesto dall'audit del 2026-10-31.
 *
 * Modulo puro: niente I/O. Lo usano il generatore prima di pubblicare e
 * `scripts/audit-article-relevance.mjs` per il ledger degli articoli esistenti.
 */
import { normalizeText } from './profession-taxonomy.mjs';
import { isInLocalNewsArea } from './local-news.mjs';

/** Radici a inizio parola sul testo di `normalizeText` (minuscolo, senza accenti). */
const wordStartRe = (stems) => new RegExp(`(?:^| )(?:${stems.join('|')})`);
const wholeWordRe = (words) => new RegExp(`(?:^| )(?:${words.join('|')})(?: |$)`);

const CROSS_BORDER = [
  'frontalier', 'transfrontalier', 'grenzgaenger', 'grenzganger', 'cross border',
  'confin', 'frontiera', 'frontiere', 'dogan', 'valic', 'permess', 'ristorn',
];
const SWITZERLAND = [
  'svizzer', 'svizzera', 'elvetic', 'suisse', 'schweiz', 'swiss', 'switzerland',
  'confederazion', 'consiglio federale', 'consiglier federal', 'cantonal', 'cantone', 'canton ',
  'ticin', 'tessin', 'lugan', 'bellinzon', 'locarn', 'mendrisi', 'chiasso', 'biasca',
  'ascona', 'gaggiolo', 'stabio', 'gandria', 'brogeda', 'leventina', 'blenio', 'vallemaggia',
  'ambri', 'gottardo', 'zurig', 'ginevr', 'basilea', 'berna', 'bernes', 'grigion', 'vallese',
  'losanna', 'lucerna', 'san gallo', 'turgovia', 'argovia', 'friburgo', 'neuchatel', 'giura',
  'sciaffusa', 'soletta', 'svitto', 'turgov', 'uri ', 'obvaldo', 'nidvaldo', 'glarona', 'zugo',
  'appenzello', 'thun', 'grasshopper', 'young boys', 'viganello', 'trevano', 'moesa', 'mesolcina',
  'calanca', 'bregaglia', 'poschiavo', 'retica', 'rhb', 'bilateral', 'cassis', 'parmelin',
  'keller sutter', 'rosti', 'swatch', 'nestle', 'novartis', 'roche', 'migros', 'swisscom', 'sulzer',
];
const SWISS_WORDS = [
  'ch', 'avs', 'lamal', 'suva', 'lpp', 'seco', 'ust', 'ffs', 'sbb', 'tilo', 'bns', 'snb',
  'chf', 'comco', 'usi', 'supsi', 'udc', 'plr', 'ocst', 'unia', 'a2', 'a9', 'a13', 'ubs', 'abb',
];
const WORK = [
  'lavoro', 'lavorator', 'lavoratric', 'lavorare', 'occupazion', 'disoccup', 'stipend', 'salari',
  'impieg', 'assunzion', 'assum', 'licenzi', 'pension', 'previdenz', 'fisco', 'fiscal',
  'tassa ', 'tasse', 'impost', 'irpef', 'sindacat',
];

const NEXUS_RE = wordStartRe([...CROSS_BORDER, ...SWITZERLAND, ...WORK]);
const NEXUS_WORDS_RE = wholeWordRe(SWISS_WORDS);
const BODY_ANCHOR_RE = wordStartRe([...CROSS_BORDER, ...SWITZERLAND]);
/**
 * Le province di confine per nome. `isInLocalNewsArea` copre solo i comuni di
 * confine dell'indice, e Gallarate o Saronno ne restano fuori pur stando nella
 * stessa area della decisione del 2026-09-25.
 */
const BORDER_PROVINCE_RE = wordStartRe([
  'varese', 'varesin', 'varesott', 'gallarat', 'busto', 'saronn', 'malpensa', 'sacro monte',
  'como ', 'comasc', 'lario', 'verban', 'domodossol', 'ossola',
]);

/**
 * Le famiglie senza nesso. Solo termini che in un titolo non hanno un secondo
 * senso economico: niente «partita» nuda (partita IVA), niente «tappa» o «giro»,
 * niente «cina» o «russia» da sole quando sono mercati e non esteri puri.
 */
export const OFF_TOPIC_FAMILIES = Object.freeze({
  sport: wordStartRe([
    'serie a ', 'serie b ', 'serie c ', 'champions', 'europa league', 'conference league',
    'pareggi', 'playoff', 'play off', 'playout', 'basket', 'pallacanestro', 'pallavolo', 'volley',
    'calcio ', 'calciator', 'gol ', 'derby', 'campionat', 'allenator', 'tennis', 'ciclism',
    'giro d italia', 'tour de france', 'motogp', 'formula 1', 'maratona', 'atletica', 'nuoto',
    'rugby', 'ginnastica', 'kastritis', 'partita con', 'partita contro', 'partita di', 'la partita',
    'una partita', 'vince la partita', 'batte ', 'sconfitta contro', 'vittoria contro', 'vittoria su',
    'nazionale italiana', 'azzurri', 'scudetto', 'coppa italia',
  ]),
  giochi: wordStartRe(['burraco', 'tombola', 'briscola', 'scopone', 'bingo']),
  esteri: wordStartRe([
    'iran', 'teheran', 'hormuz', 'israel', 'gaza', 'hamas', 'hezbollah', 'libano', 'siria',
    'ucraina', 'kiev', 'putin', 'zelensky', 'trump', 'casa bianca', 'texas', 'stati uniti',
    'messico', 'venezuela', 'corea del nord', 'pyongyang', 'taiwan', 'yemen', 'houthi', 'tajani',
  ]),
});

/** Testo su cui si misura il nesso dichiarato: id e titolo, normalizzati. */
function declaredText({ id = '', title = '' }) {
  return ` ${normalizeText(`${id} ${title}`)} `;
}

function hasNexus(text) {
  return NEXUS_RE.test(text) || NEXUS_WORDS_RE.test(text);
}

function offTopicFamily(text) {
  for (const [family, re] of Object.entries(OFF_TOPIC_FAMILIES)) {
    const match = re.exec(text);
    if (match) return { family, term: match[0].trim() };
  }
  return null;
}

/**
 * @param {{section?: string, id?: string, title?: string, excerpt?: string, body?: string}} article testi italiani
 * @returns {{relevant: true} | {relevant: false, rule: 'fuori-tema'|'senza-ancore', family?: string, term?: string}}
 */
export function classifyArticleRelevance({ section = 'frontaliere', id = '', title = '', excerpt = '', body = '' }) {
  const declared = declaredText({ id, title });
  if (hasNexus(declared)) return { relevant: true };

  // Una famiglia «esteri» in un titolo che nomina una provincia di confine e' un
  // presidio o una proiezione a Varese, non una notizia estera: cronaca e cultura
  // locali restano ammesse. Sport e giochi no.
  const offTopic = offTopicFamily(declared);
  if (offTopic && !(offTopic.family === 'esteri' && BORDER_PROVINCE_RE.test(declared))) {
    return { relevant: false, rule: 'fuori-tema', ...offTopic };
  }

  if (section !== 'frontaliere') return { relevant: true };

  const headline = ` ${normalizeText(`${declared} ${excerpt}`)} `;
  if (hasNexus(headline) || BORDER_PROVINCE_RE.test(headline)) return { relevant: true };
  if (isInLocalNewsArea(`${title} ${excerpt}`)) return { relevant: true };
  if (BODY_ANCHOR_RE.test(` ${normalizeText(body)} `)) return { relevant: true };
  return { relevant: false, rule: 'senza-ancore' };
}

/**
 * Il filtro prima della spesa: una headline di una famiglia senza nesso non vale
 * una generazione. Solo `fuori-tema`: `senza-ancore` ha bisogno del corpo.
 *
 * @param {string} headline
 * @returns {boolean}
 */
export function isOffTopicHeadline(headline) {
  return classifyArticleRelevance({ section: 'svizzera', title: headline }).relevant === false;
}

/** Il corpo testuale di un articolo: la concatenazione dei suoi `bodyN`. */
export function articleBodyText(content = {}) {
  return Object.keys(content)
    .filter((key) => /^body\d+$/.test(key))
    .map((key) => content[key])
    .join('\n');
}

/**
 * Da chiamare prima della pubblicazione automatica. Lancia un errore che il
 * ciclo di generazione tratta come un rifiuto del topic-gate: l'articolo non
 * esce e il ranker passa alla notizia successiva.
 *
 * @param {{id?: string, content?: {it?: Record<string, string>}}} data
 * @param {string} section sezione di pubblicazione
 */
export function assertArticleRelevance(data, section) {
  const it = data?.content?.it ?? {};
  const verdict = classifyArticleRelevance({
    section,
    id: data?.id,
    title: it.title,
    excerpt: it.excerpt,
    body: articleBodyText(it),
  });
  if (verdict.relevant) return verdict;
  const detail = verdict.term ? ` (${verdict.family}: «${verdict.term}»)` : '';
  const error = new Error(`topic-gate abort: articolo senza nesso editoriale, regola ${verdict.rule}${detail}`);
  error.topicGateAbort = true;
  throw error;
}
