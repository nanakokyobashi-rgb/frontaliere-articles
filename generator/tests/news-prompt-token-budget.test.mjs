/**
 * news-prompt-token-budget.test.mjs — «perche' genera solo evergreen?»
 *
 * COSA PINNA, e perche' e' scritto cosi'.
 *
 * Il difetto: il prompt di generazione e' cresciuto un blocco alla volta —
 * gate di rilevanza, contratto di fonte, fatti di dominio, brief editoriale —
 * ognuno difendibile da solo, e nessuno che pesasse l'assemblato. Sopra il cap
 * di request piu' alto dichiarato dalla flotta (8000 token: e' il default
 * account-wide di GitHub Models e Groq in `DEFAULT_REQUEST_TOKENS_BY_PROVIDER`)
 * il pre-flight di `callLLM` non tenta nemmeno la chiamata.
 *
 * La prova non e' una stima, e' una discontinuita' dentro UN SOLO run
 * (31402084443, 2026-08-10): lo STESSO modello, a 55 secondi di distanza, con
 * esito opposto a seconda del ramo che ha assemblato il prompt.
 *
 *   15:12:33  news       ⏭️  [gpt-4.1] Skipped — request would exceed
 *                            8000-token limit (estimated 9431)
 *   15:13:28  evergreen  🤖 [1/5] Generazione contenuto IT ... con gpt-4.1
 *
 * Tutti e 7 gli skip per input-cap del run cadono nella fase news, zero nella
 * fase evergreen. Il ramo evergreen azzera `domainFactsBlock` e
 * `sourceContract` (`isSyntheticSource`) e porta una `pageContent` sintetica
 * corta; il ramo news aggiunge tutti e tre. Da qui «genera solo evergreen».
 *
 * PERCHE' QUESTO TEST E' SCRITTO PER ESTRAZIONE E NON PER REPLICA.
 * Il difetto e' nato ESATTAMENTE da una misura parziale: il commento a
 * `create-article.mjs` («estTokens ~7333 — ancora ~667 sotto il cap di 8000»)
 * e' onesto e riproducibile, ma misura UN SOLO RAMO, quello evergreen. Un test
 * che ricostruisse il prompt a mano ripeterebbe lo stesso errore in una forma
 * nuova: misurerebbe la propria copia, non il prompt che parte davvero.
 * Quindi qui il prompt viene ESTRATTO dal sorgente di `create-article.mjs` e
 * valutato, con le sole dipendenze iniettate come parametri — la stessa
 * tecnica di `evergreen-brief-section-aware.test.mjs`, resa necessaria dal
 * fatto che questo repo non ha `node_modules` e `create-article.mjs` importa
 * l'intero albero del generatore (`jsdom`, `sharp`, …).
 * E la stima usa `estimateRequestTokens` REALE, importata da `ai-models.mjs`:
 * e' la funzione che decide davvero se un modello viene saltato.
 *
 * Se gli anchor spariscono il test FALLISCE rumorosamente: non puo' passare a
 * vuoto misurando una stringa vuota.
 *
 * Lancia con:
 *   node --test generator/tests/news-prompt-token-budget.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateRequestTokens } from '../scripts/lib/ai-models.mjs';
import { AI_SEARCH_PROMPT_BLOCK_IT } from '../scripts/lib/ai-search-template.mjs';
import { JSON_QUOTE_SAFETY_RULE_IT } from '../scripts/lib/llm-json-repair.mjs';
import { buildSourceContract } from '../scripts/lib/article-factuality-gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const AI_MODELS_SRC = path.resolve(HERE, '../scripts/lib/ai-models.mjs');

const src = readFileSync(CREATE_ARTICLE, 'utf-8');

/** Ritaglia un blocco fra due anchor, fallendo forte se una non c'e' piu'. */
function cut(startAnchor, endAnchor, { includeEnd = true, from = src } = {}) {
  const a = from.indexOf(startAnchor);
  assert.notEqual(a, -1, `anchor iniziale non trovata — aggiornare questo test: ${startAnchor}`);
  const b = from.indexOf(endAnchor, a + startAnchor.length);
  assert.notEqual(b, -1, `anchor finale non trovata — aggiornare questo test: ${endAnchor}`);
  return from.slice(a, includeEnd ? b + endAnchor.length : b);
}

/** Ritaglia una dichiarazione top-level fino alla sua chiusura in colonna 0. */
function cutDecl(startAnchor, { from = src } = {}) {
  const a = from.indexOf(startAnchor);
  assert.notEqual(a, -1, `dichiarazione non trovata — aggiornare questo test: ${startAnchor}`);
  const rel = from.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura non trovata per: ${startAnchor}`);
  return from.slice(a, a + rel + 3);
}

// ── Le costanti del budget, lette dal sorgente ────────────────────────────
function numericConst(name) {
  const m = src.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
  assert.ok(m, `costante \`${name}\` non trovata in create-article.mjs: il budget e' tornato a essere un letterale sparso`);
  return Number(m[1]);
}
const PROMPT_TOKEN_BUDGET = numericConst('PROMPT_TOKEN_BUDGET');
const PROMPT_TOKEN_CEILING = numericConst('PROMPT_TOKEN_CEILING');
const IT_GENERATION_MAX_TOKENS = numericConst('IT_GENERATION_MAX_TOKENS');

// ── I pezzi di create-article.mjs che il prompt usa ───────────────────────
const briefBlock = cut('const EVERGREEN_FACTS_BRIEF = `', 'export function stripInjectedBriefs(', { includeEnd: false })
  + cutDecl('export function stripInjectedBriefs(');
const { evergreenFactsBriefFor } = new Function(
  `${briefBlock.replace(/^export function /gm, 'function ')}\nreturn { evergreenFactsBriefFor };`,
)();

const buildArticleJsonSchema = new Function(
  `${cutDecl('function buildArticleJsonSchema(')}\nreturn buildArticleJsonSchema;`,
)();
const CATEGORIES = new Function(`${cut('const CATEGORIES = [', '];')}\nreturn CATEGORIES;`)();
const AVAILABLE_IMAGES = new Function(`${cut('const PLACES_IMAGES = [', '\n];')}\nreturn PLACES_IMAGES;`)();

// ── Il blocco di assemblaggio del prompt, verbatim da callGemini ──────────
//
// Dall'inizio della gestione del budget fino a subito prima della chiamata:
// include quindi anche il pre-flight `[prompt-budget]`, cosi' che il marker
// che un watchdog leggera' sia pinnato dal suo output reale e non da un grep.
const PROMPT_BLOCK_START = 'const generationAttempt = Number(sourceContext?._generationAttempt || 1);';
const PROMPT_BLOCK_END = '\n  let itRaw;';
const promptBlock = cut(PROMPT_BLOCK_START, PROMPT_BLOCK_END, { includeEnd: false });

const DEPS = [
  'pageContent', 'url', 'sourceContext', 'existingIds',
  'CREATE_ARTICLE_MIN_IT_WORDS', 'IS_FRONTALIERE', 'SECTION_NAME',
  'AI_SEARCH_PROMPT_BLOCK_IT', 'JSON_QUOTE_SAFETY_RULE_IT',
  'buildSourceContract', 'evergreenFactsBriefFor', 'buildArticleJsonSchema',
  'lastSourcePublishedAt', '_winnerFingerprintMessage',
  'AI_MODELS', 'GH_MODEL_HEAVY', 'CATEGORIES', 'AVAILABLE_IMAGES',
  'estimateRequestTokens', 'PROMPT_TOKEN_BUDGET', 'IT_GENERATION_MAX_TOKENS',
];

const assemblePrompt = new Function(
  '__d',
  `const { ${DEPS.join(', ')} } = __d;\n${promptBlock}\n`
  + 'return { llmMessages, articleSchema, estTokens: _promptEstTokens, overBudget: _promptOverBudget, prompt, branch: _promptBudgetBranch };',
);

// ── Fixture: il CASO PEGGIORE REALE, non uno comodo ───────────────────────
//
// Ogni scelta qui e' verso l'alto, perche' un budget si prova sul massimo:
//   - la fonte supera MAX_SOURCE_CHARS, quindi il troncamento e' saturo;
//   - gli id sono i piu' lunghi che il corpus produca (58 char, es.
//     `affitti-svizzera-mercato-immobiliare-2026-canton-san-gallo`) e sono
//     tanti quanti il selettore ne mandi al massimo;
//   - le headline correlate sono al massimo che `rankAndSelectHeadlines` passa.
// Il corpus di id e' sintetico e DETERMINISTICO di proposito: leggere
// `content/routerBlogData.ts` legherebbe il lock alla crescita del corpus e lo
// farebbe sfarfallare da solo, che e' l'anti-pattern del ratchet a conteggio.
// 104 = l'id piu' lungo del corpus reale (misurato su 3845 id: p50=35, p95=51,
// max=104). Un fixture con id di lunghezza media misurerebbe un caso comodo e
// lascerebbe passare proprio la crescita che ha prodotto il difetto.
const LONG_ID = `affitti-svizzera-mercato-immobiliare-canton-san-gallo-guida-completa-inquilini-disdetta-2026${'-x'.repeat(6)}`;
const existingIds = Array.from({ length: 4000 }, (_, i) => `${LONG_ID.slice(0, 99)}-${String(i).padStart(4, '0')}`);

const NEWS_PARAGRAPH = `Il Consiglio di Stato del Canton Ticino ha approvato il 12 marzo 2026 il messaggio numero 8412 che rivede il regolamento sull'imposta alla fonte per i lavoratori frontalieri. La misura, entrata in vigore il 1 aprile 2026, modifica le aliquote applicate ai redditi superiori a CHF 120'000 annui e introduce un nuovo obbligo di notifica trimestrale a carico dei datori di lavoro con piu' di 50 dipendenti frontalieri. Secondo i dati della Divisione delle contribuzioni sono 78'420 i lavoratori interessati, con un gettito stimato in CHF 1,24 miliardi per il 2026. Il direttore del Dipartimento delle finanze ha dichiarato che il nuovo assetto garantisce maggiore equita' fra i contribuenti residenti e non residenti. L'Associazione industrie ticinesi ha criticato l'onere amministrativo, quantificato in 14 ore mensili per azienda. Il termine per il referendum scade il 30 giugno 2026. `;
// extractArticleText taglia a 8000 char; il prompt ritronca a MAX_SOURCE_CHARS.
const NEWS_PAGE_CONTENT = NEWS_PARAGRAPH.repeat(11).slice(0, 8000);

const BASE_DEPS = {
  existingIds,
  CREATE_ARTICLE_MIN_IT_WORDS: 900,
  AI_SEARCH_PROMPT_BLOCK_IT,
  JSON_QUOTE_SAFETY_RULE_IT,
  buildSourceContract,
  evergreenFactsBriefFor,
  buildArticleJsonSchema,
  CATEGORIES,
  AVAILABLE_IMAGES,
  estimateRequestTokens,
  PROMPT_TOKEN_BUDGET,
  IT_GENERATION_MAX_TOKENS,
  _winnerFingerprintMessage: null,
  AI_MODELS: { GEMINI_FLASH: 'gemini-2.5-flash' },
  GH_MODEL_HEAVY: 'gpt-4o',
  lastSourcePublishedAt: '2026-03-12T08:00:00.000Z',
};

/** Assembla catturando stderr: il blocco logga, e il log e' parte del contratto. */
function assemble(overrides) {
  const logged = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...a) => logged.push(a.join(' '));
  console.warn = (...a) => logged.push(a.join(' '));
  try {
    return { ...assemblePrompt({ ...BASE_DEPS, ...overrides }), logged };
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
}

/** Il ramo NEWS: fonte reale scrapata. `section` di default 'frontaliere', come il call-site reale prima di #96 — passala esplicitamente per l'altra sezione. */
function newsPrompt(extra = {}, section = 'frontaliere') {
  return assemble({
    pageContent: NEWS_PAGE_CONTENT,
    url: 'https://www.tio.ch/ticino/economia/1812345/imposta-fonte-frontalieri-nuove-aliquote',
    IS_FRONTALIERE: section === 'frontaliere',
    SECTION_NAME: section,
    sourceContext: {
      headline: 'Imposta alla fonte, il Ticino rivede le aliquote per i frontalieri sopra i 120mila franchi',
      relatedHeadlines: [
        { source: 'CdT', headline: 'Frontalieri, il nuovo accordo fiscale entra nel vivo' },
        { source: 'RSI', headline: 'Imposta alla fonte: cosa cambia per 78mila lavoratori' },
        { source: 'laRegione', headline: 'Aziende ticinesi contro il nuovo obbligo di notifica trimestrale' },
        { source: 'Ticinonline', headline: 'Notifica trimestrale, le imprese chiedono una proroga al Cantone' },
      ],
      _generationAttempt: 1,
      _generationAttemptMax: 6,
      _minItalianWords: 900,
      _primaryLocale: 'it',
      ...extra,
    },
  });
}

/** Il ramo EVERGREEN: `pageContent` sintetica costruita da create-article.mjs. */
function evergreenPrompt(section = 'frontaliere') {
  const keyword = 'frontaliere farmacista ticino stipendio requisiti';
  return assemble({
    pageContent: `[ARTICOLO EVERGREEN SEO]\nKeyword target: ${keyword}\nAngolo editoriale: guida pratica passo passo\n\nGenera un articolo approfondito e pratico ottimizzato per questa keyword long-tail. Usa solo fatti verificati e stabili sul dominio frontalieri Ticino-Italia. Se servono esempi, presentali come scenari ipotetici, senza nomi, aziende, citta' o importi specifici inventati.\n\n${evergreenFactsBriefFor(section)}\n\n⚠️ I FATTI VERIFICATI qui sopra DEVONO corrispondere ESATTAMENTE (lo stesso ground truth e' usato dal fact-checker, che blocca l'articolo se diverghi). Per dettagli NON coperti, attieniti a nozioni stabili e generali del dominio; se un dato specifico non e' certo, ometti o usa formulazioni qualitative invece di inventare cifre/date precise.`,
    url: `evergreen://${encodeURIComponent(keyword)}`,
    IS_FRONTALIERE: section === 'frontaliere',
    SECTION_NAME: section,
    sourceContext: {
      headline: keyword,
      relatedHeadlines: [],
      _generationAttempt: 1,
      _generationAttemptMax: 6,
      _minItalianWords: 900,
      _primaryLocale: 'it',
    },
  });
}

// ═══ 0. Il fixture e' davvero il prompt, non un guscio vuoto ═════════════
//
// Senza questo, ogni numero sotto potrebbe essere la misura di una stringa
// mutilata da un anchor scivolato — e il test passerebbe verde per il motivo
// sbagliato, che e' il modo in cui il difetto originale e' sopravvissuto.

test('l\'estrazione produce il prompt VERO (guardia anti-verde-a-vuoto)', () => {
  const { llmMessages, prompt, articleSchema } = newsPrompt();

  assert.ok(Array.isArray(llmMessages) && llmMessages.length >= 2, 'llmMessages non assemblato');
  assert.equal(llmMessages[0].role, 'system');
  assert.equal(llmMessages[llmMessages.length - 1].role, 'user');

  for (const marker of [
    'REGOLA #0 — GATE DI RILEVANZA TOPICA',
    'REGOLA #1 — FEDELTÀ ALLA FONTE',
    'DIVIETI ANTI-ALLUCINAZIONE',
    'SOURCE CONTENT:',
    'ARTICLE IDS',
    'FATTI DI DOMINIO VERIFICATI',
  ]) {
    assert.ok(prompt.includes(marker), `il prompt estratto non contiene «${marker}»: l'anchor e' scivolato`);
  }
  // La notizia c'e' davvero, ed e' troncata (fonte oltre MAX_SOURCE_CHARS).
  assert.ok(prompt.includes('imposta alla fonte'), 'la fonte non e\' finita nel prompt');
  assert.ok(prompt.includes('[...contenuto troncato per brevità]'), 'il fixture non satura MAX_SOURCE_CHARS');
  assert.ok(articleSchema?.schema, 'lo schema JSON non e\' stato costruito');
});

// ═══ 1. IL TEST CENTRALE: il ramo NEWS sta dentro il tetto ═══════════════

test('IL TEST CENTRALE: il prompt NEWS nel caso peggiore resta sotto il tetto', () => {
  const { estTokens } = newsPrompt();
  assert.ok(
    estTokens <= PROMPT_TOKEN_CEILING,
    `il prompt news e' stimato in ${estTokens} token, sopra PROMPT_TOKEN_CEILING (${PROMPT_TOKEN_CEILING}).\n`
    + 'Il tetto e\' un ratchet: puo\' solo SCENDERE. Se hai aggiunto un blocco al prompt, il costo va\n'
    + 'compensato altrove, non assorbito alzando il tetto — sopra PROMPT_TOKEN_BUDGET '
    + `(${PROMPT_TOKEN_BUDGET}) ogni modello GitHub Models e Groq viene saltato dal pre-flight.`,
  );
});

test('il ramo NEWS SVIZZERA resta sotto il tetto — non solo l\'evergreen svizzera', () => {
  // `generate-article.yml` alterna cron frontaliere/svizzera chiamando lo
  // stesso create-article.mjs sia per notizie reali sia per evergreen: la
  // sezione svizzera sul ramo NEWS e' un path di produzione raggiunto
  // regolarmente, non solo un caso teorico. Senza questo test la sola
  // combinazione section='svizzera' + branch=news non era mai esercitata —
  // `newsPrompt()` fissava SECTION_NAME a 'frontaliere' e nessun altro test
  // passava una sezione diversa sul ramo news.
  //
  // Il gap era reale: EVERGREEN_FACTS_BRIEF_CH iniettato in domainFactsBlock
  // (anche sul ramo news, non solo evergreen) misurava 10.362 token, sopra
  // PROMPT_TOKEN_CEILING — la sezione svizzera non sarebbe mai entrata in
  // generazione da notizia reale, solo da evergreen. Il tetto in caratteri su
  // domainFactsBlock lo riporta sotto il tetto.
  const { estTokens } = newsPrompt({}, 'svizzera');
  assert.ok(
    estTokens <= PROMPT_TOKEN_CEILING,
    `il prompt news svizzera e' stimato in ${estTokens} token, sopra PROMPT_TOKEN_CEILING (${PROMPT_TOKEN_CEILING}).\n`
    + 'Se e\' salito, il tetto su MAX_DOMAIN_FACTS_CHARS in create-article.mjs va rivisto: senza, la sezione '
    + 'svizzera smette di generare da notizia reale, solo da evergreen.',
  );
});

test('il ramo NEWS regge anche il retry, che e\' il tentativo piu\' pesante', () => {
  // I retry riducono la fonte (4500) ma aggiungono il feedback del fact-check
  // e quello sulla headline: il saldo e' in salita, quindi il caso peggiore
  // vero non e' il primo tentativo.
  const { estTokens } = newsPrompt({
    _generationAttempt: 4,
    _previousWordCount: 640,
    _factCheckRefinement: '- "Il gettito sale a CHF 2 miliardi nel 2027" — non presente nella fonte\n'
      + '- "L\'accordo entra in vigore nel 2027" — data non presente nella fonte\n'
      + '- "Secondo uno studio dell\'USTAT il 62% dei frontalieri" — studio non citato dalla fonte',
    _headlineRefinement: 'title troppo lungo (128 caratteri) e con punto interrogativo finale',
  });
  assert.ok(
    estTokens <= PROMPT_TOKEN_CEILING,
    `il prompt news al retry e' stimato in ${estTokens} token, sopra PROMPT_TOKEN_CEILING (${PROMPT_TOKEN_CEILING})`,
  );
});

// ═══ 2. Il ramo EVERGREEN deve stare sotto il CAP VERO, non sotto il tetto ═
//
// E' l'invariante che il run 31402084443 mostra intatta, e va tenuta tale:
// e' l'unico ramo che oggi entra nella flotta, e se sfora anche lui la
// generazione si ferma del tutto invece di degradare.

test('il ramo EVERGREEN sta sotto il cap REALE della flotta (8000), non solo sotto il tetto', () => {
  const { estTokens, overBudget } = evergreenPrompt('frontaliere');
  assert.ok(
    estTokens <= PROMPT_TOKEN_BUDGET,
    `il prompt evergreen e' stimato in ${estTokens} token, sopra il cap della flotta `
    + `(${PROMPT_TOKEN_BUDGET}). E' l'unico ramo che oggi entra in GitHub Models e Groq — il run `
    + '31402084443 lo mostra generare con gpt-4.1 mentre il ramo news veniva saltato. Se sfora '
    + 'anche lui, il pipeline non ha piu\' NESSUN percorso che entri in quei due provider.',
  );
  assert.equal(overBudget, false, 'il pre-flight segnala il ramo evergreen fuori budget');
});

test('l\'evergreen SVIZZERA rispetta almeno il tetto (e non ancora il cap)', () => {
  // Misurato 8452 token contro i 7803 del gemello frontaliere. La differenza
  // e' quasi tutta in EVERGREEN_FACTS_BRIEF_CH, che e' 3170 caratteri contro i
  // 1553 del brief frontaliere e finisce dentro `pageContent` sul ramo
  // evergreen. E' un difetto adiacente REALE — la sezione svizzera non entra
  // nei due provider principali — ma vive in un blocco che questa PR non
  // tocca: qui viene solo pinnato perche' non peggiori in silenzio.
  const { estTokens } = evergreenPrompt('svizzera');
  assert.ok(
    estTokens <= PROMPT_TOKEN_CEILING,
    `il prompt evergreen svizzera e' stimato in ${estTokens} token, sopra PROMPT_TOKEN_CEILING (${PROMPT_TOKEN_CEILING})`,
  );
});

// La distanza fra i due rami e' l'invariante che e' stata violata davvero: un
// ramo era misurato (il commento «estTokens ~7333» a create-article.mjs) e
// l'altro no. Sono TRE i blocchi che il ramo news porta in piu', tutti dietro
// la stessa guardia `isSyntheticSource`:
//   domainFactsBlock  +  sourceContract  +  la fonte scrapata (fino a
//   MAX_SOURCE_CHARS) al posto della pageContent sintetica dell'evergreen.
// Il numero qui sotto e' la loro somma misurata, arrotondata in alto. Se sale,
// e' perche' e' comparso un QUARTO blocco news-only — ed e' quello il momento
// in cui va dichiarato, non sei mesi dopo contando gli skip nei log.
const NEWS_OVER_EVERGREEN_MAX_TOKENS = 2150;

test('la distanza news − evergreen resta quella dei tre blocchi noti', () => {
  const news = newsPrompt().estTokens;
  const evergreen = evergreenPrompt('frontaliere').estTokens;
  const gap = news - evergreen;
  assert.ok(
    gap <= NEWS_OVER_EVERGREEN_MAX_TOKENS,
    `il ramo news costa ${gap} token piu' dell'evergreen (news=${news}, evergreen=${evergreen}), `
    + `sopra i ${NEWS_OVER_EVERGREEN_MAX_TOKENS} dichiarati. I tre blocchi che producono la distanza `
    + 'sono domainFactsBlock, sourceContract e la fonte scrapata, tutti dietro `isSyntheticSource`: '
    + 'se ne hai aggiunto un quarto, dichiaralo qui invece di alzare il numero.',
  );
});

// ═══ 3. Il budget di OUTPUT non deve escludere modelli da solo ════════════

test('IT_GENERATION_MAX_TOKENS non esclude nessun modello per output cap', () => {
  // MODEL_MAX_OUTPUT_TOKENS non e' esportato: si legge dal sorgente di
  // ai-models.mjs, che e' `mode: identical` e va letto, mai scritto, da qui.
  const aiSrc = readFileSync(AI_MODELS_SRC, 'utf-8');
  const table = cut('const MODEL_MAX_OUTPUT_TOKENS = {', '\n};', { from: aiSrc });
  const limits = [...table.matchAll(/:\s*(\d+),/g)].map((m) => Number(m[1]));
  assert.ok(limits.length >= 5, 'MODEL_MAX_OUTPUT_TOKENS non parsata — aggiornare questo test');

  const lowest = Math.min(...limits);
  // Il guard di callLLM salta il modello con `o.maxTokens > modelLimit`:
  // uguale al cap va bene, sopra no.
  assert.ok(
    IT_GENERATION_MAX_TOKENS <= lowest,
    `IT_GENERATION_MAX_TOKENS=${IT_GENERATION_MAX_TOKENS} supera il cap di output piu' basso della `
    + `flotta (${lowest}): quei modelli vengono saltati con «model max output ${lowest} < requested `
    + `maxTokens ${IT_GENERATION_MAX_TOKENS}» prima ancora di guardare il prompt.`,
  );
  // …e deve restare sufficiente: CREATE_ARTICLE_MIN_IT_WORDS parole IT + faq +
  // seo + overhead JSON stanno in ~2500-3000 token misurati.
  assert.ok(
    IT_GENERATION_MAX_TOKENS >= 3500,
    `IT_GENERATION_MAX_TOKENS=${IT_GENERATION_MAX_TOKENS} e' sotto il fabbisogno misurato `
    + '(~2500-3000 token per 900 parole IT + faq + seo): scendere ancora produce troncamenti.',
  );
});

test('il budget e\' un SIMBOLO, non un letterale sparso nel call-site', () => {
  const callSite = cut('const articleSchema = buildArticleJsonSchema(primaryLocale);', '\n  let itData;');
  assert.equal(
    (callSite.match(/maxTokens:\s*\d+/g) || []).length, 0,
    'la chiamata di generazione IT ha di nuovo un maxTokens letterale: '
    + 'il prossimo che lo cambia non trovera\' il vincolo che lo governa',
  );
  assert.ok(
    (callSite.match(/maxTokens:\s*IT_GENERATION_MAX_TOKENS/g) || []).length >= 2,
    'le due chiamate (Gemini diretta e cascade) non passano entrambe da IT_GENERATION_MAX_TOKENS',
  );
});

// ═══ 4. Il marker che il watchdog leggera' ════════════════════════════════

test('il pre-flight pubblica un marker machine-readable stabile', () => {
  const { logged, estTokens } = newsPrompt();
  const line = logged.find((l) => l.startsWith('[prompt-budget]'));
  assert.ok(line, 'nessuna riga [prompt-budget]: la dimensione del prompt e\' di nuovo deducibile solo contando gli skip a valle');

  const fields = Object.fromEntries(
    [...line.matchAll(/(\w+)=([^\s]+)/g)].map((m) => [m[1], m[2]]),
  );
  assert.equal(fields.branch, 'news');
  assert.equal(fields.section, 'frontaliere');
  assert.equal(fields.attempt, '1');
  assert.equal(Number(fields.est), estTokens);
  assert.equal(Number(fields.budget), PROMPT_TOKEN_BUDGET);
  assert.ok(fields.over === '0' || fields.over === '1');

  assert.equal(evergreenPrompt().logged.find((l) => l.startsWith('[prompt-budget]')).includes('branch=evergreen'), true);
});

test('sopra budget il pre-flight avvisa ma NON rompe la pipeline', () => {
  // Un throw qui trasformerebbe un degrado (la catena scende ai modelli che il
  // payload lo reggono) in un run perso. Il contratto e' warning + marker.
  const { overBudget, logged } = newsPrompt();
  if (overBudget) {
    assert.ok(
      logged.some((l) => l.includes('⚠️') && l.includes('prompt-budget')),
      'over budget senza warning leggibile',
    );
  }
  assert.doesNotThrow(() => newsPrompt(), 'il pre-flight lancia invece di avvisare');
});

// ═══ 5. Il lock mancante: il divisore di estimateRequestTokens ════════════
//
// `ai-models.mjs` cita `tests/scripts/ai-models-token-estimate-divisor.test.ts`
// come «regression lock sul divisore». Quel file NON esiste, e
// `package.json` (`node --test 'generator/tests/*.test.mjs'`) non scansiona
// nemmeno quel percorso. Il divisore 3.5 sposta la soglia di TUTTA la flotta
// ed era senza lock: e' la stessa forma del difetto SiteShellContract — un
// contratto citato in un commento, che nessun guard che segue gli import
// vede. Qui viene pinnato per COMPORTAMENTO, non per lettura del sorgente.

test('estimateRequestTokens e\' pinnata su divisore 3.5 e margine 500', () => {
  const chars = (n) => [{ role: 'user', content: 'x'.repeat(n) }];

  assert.equal(estimateRequestTokens([]), 500, 'il margine di sicurezza non e\' piu\' 500');
  assert.equal(estimateRequestTokens(chars(3500)), 1500, 'il divisore non e\' piu\' 3.5');
  assert.equal(estimateRequestTokens(chars(7000)), 2500);
  // arrotondamento per eccesso
  assert.equal(estimateRequestTokens(chars(1)), 501);

  // I `content` di TUTTI i messaggi contano, non solo l'ultimo.
  assert.equal(
    estimateRequestTokens([{ role: 'system', content: 'x'.repeat(3500) }, { role: 'user', content: 'y'.repeat(3500) }]),
    2500,
  );
  // Lo schema JSON serializzato conta: e' meta' della sorpresa di questo difetto.
  const schema = { schema: { type: 'object', properties: {} } };
  assert.equal(
    estimateRequestTokens(chars(3500), { jsonSchema: schema }),
    1500 + Math.ceil(JSON.stringify(schema.schema).length / 3.5) - Math.ceil(0 / 3.5),
    'lo jsonSchema non viene piu' + ' conteggiato: il prompt reale e\' piu\' grande della stima',
  );
});

test('il tetto non e\' sopra il cap della flotta senza dirlo', () => {
  assert.ok(
    PROMPT_TOKEN_CEILING >= PROMPT_TOKEN_BUDGET,
    'PROMPT_TOKEN_CEILING e\' sceso sotto PROMPT_TOKEN_BUDGET: ora il tetto e\' il cap, '
    + 'e le due costanti vanno unificate',
  );
  assert.equal(PROMPT_TOKEN_BUDGET, 8000, 'il cap piu\' alto dichiarato dalla flotta e\' cambiato: verificare DEFAULT_REQUEST_TOKENS_BY_PROVIDER in ai-models.mjs');
});
