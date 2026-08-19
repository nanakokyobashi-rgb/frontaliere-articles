/**
 * llm-call-budget.test.mjs — «perche' un articolo costa 38-168 chiamate LLM?»
 *
 * IL DIFETTO, MISURATO SUI LOG DI CINQUE RUN REALI.
 * Il minimo strutturale per un articolo e' 4 chiamate: 1 selezione headline,
 * 1 stesura, 2 fact-check. Le run vere ne spendevano da 38 a 168:
 *
 *   run 32086523370  1462s  47 stesure  91 fact-check  32 «troppo corto»  168
 *   run 32098067928  1327s  37 stesure  73 fact-check  24 «troppo corto»  142
 *   run 32111688992   547s  25 stesure  12 fact-check   5 «troppo corto»   70
 *
 * Quattro cause distinte, quattro gruppi di test qui sotto:
 *
 *   ① il conteggio parole — deterministico e gratuito — girava DOPO il
 *     fact-check, che costa 2 chiamate. Sulla run 32111688992 si legge nudo:
 *     due `verdict=PASS` e un millisecondo dopo «Contenuto IT troppo corto:
 *     227 parole», sei volte di fila. 12 fact-check pagati e buttati; sulla
 *     32086523370 sono 64 su 91.
 *   ② «troppo corto» e' una proprieta' della FONTE, non del modello, ma il
 *     loop rigenerava ruotando modello: sei modelli diversi fra 179 e 489
 *     parole contro una soglia di 700, poi `expandShortItalianContent` ha
 *     chiuso in 27 secondi.
 *   ③ il cap del classifier pre-spend era codice morto (`?? headlines.length`
 *     con un unico call site che non passa `opts`), mentre il JSDoc dichiarava
 *     12: la documentazione mentiva. CORRETTO LA SERA STESSA, nel verso
 *     opposto a quello scelto qui il pomeriggio: e' il JSDoc ad aver torto, non
 *     il codice. Imporre il tetto ha una misura contraria — vedi il blocco sul
 *     test ③ piu' sotto e pre-spend-gate-telemetry.test.mjs — quindi il tetto
 *     resta opt-in e il JSDoc si allinea al codice.
 *   ④ quattro cicli LLM senza `deadlineMs`, liberi di camminare l'intero
 *     roster, piu' una fase immagini da 9 strategie seriali senza tetto.
 *
 * PERCHE' QUESTI TEST SONO PER ESTRAZIONE E NON PER ESECUZIONE.
 * `create-article.mjs` non e' importabile da un test: 782 KB con effetti di
 * modulo (roster, sezione, RUN_REPORT) e un `main()` a valle. Tutti i test del
 * corpus che lo riguardano leggono il sorgente; questo fa lo stesso, ma dove
 * la funzione e' PURA la estrae e la ESEGUE davvero (`mapWithConcurrency`,
 * `buildForcedRetranslationPrompt`), cosi' il test non si limita a fotografare
 * il testo. Gli ancoraggi sono scelti perche' se spariscono il test FALLISCE
 * rumorosamente invece di passare a vuoto.
 *
 * Lancia con:
 *   node --test generator/tests/llm-call-budget.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const SRC = readFileSync(CREATE_ARTICLE, 'utf8');
const LINES = SRC.split('\n');

/** Righe di solo commento, per non far passare un test su una prova citata a parole. */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Il sorgente senza le righe di commento: qui vive solo il codice che gira. */
const CODE = LINES.filter((l) => !isCommentLine(l)).join('\n');

/**
 * Estrae il corpo di una funzione delimitata da riga di apertura e dalla prima
 * riga di chiusura con la stessa indentazione. Le funzioni che interessano qui
 * sono tutte scritte cosi', e un cambio di indentazione fa fallire il test
 * (`assert` sotto), non lo fa passare a vuoto.
 */
function extractBlock(startsWith) {
  const start = LINES.findIndex((l) => l.startsWith(startsWith));
  assert.notEqual(start, -1, `ancora sparita dal sorgente: "${startsWith}"`);
  const indent = LINES[start].match(/^\s*/)[0];
  const closer = `${indent}}`;
  const end = LINES.findIndex((l, i) => i > start && l === closer);
  assert.notEqual(end, -1, `blocco non chiuso per "${startsWith}"`);
  return { start, end, text: LINES.slice(start, end + 1).join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// ① Il conteggio parole gira PRIMA del fact-check
// ─────────────────────────────────────────────────────────────────────────────

test('① la soglia parole IT e il suo `continue` girano PRIMA di llmFactCheck', () => {
  const gen = extractBlock('async function generateAndValidateArticle(');
  const body = gen.text;

  const iShortCheck = body.indexOf('const itWords = italianBodyWordCount(data);');
  const iShortLog = body.indexOf('Contenuto IT troppo corto: ${itWords} parole');
  const iFactCheck = body.indexOf('await llmFactCheck(');

  assert.notEqual(iShortCheck, -1, 'il conteggio parole IT e sparito dal loop');
  assert.notEqual(iShortLog, -1, 'il log «Contenuto IT troppo corto» e sparito: e la metrica di verifica');
  assert.notEqual(iFactCheck, -1, 'llmFactCheck non e piu chiamato nel loop: e il gate primario');

  assert.ok(
    iShortCheck < iFactCheck,
    'REGRESSIONE: italianBodyWordCount torna a girare dopo llmFactCheck — ogni bozza corta ripaga 2 chiamate LLM buttate',
  );
  assert.ok(
    iShortLog < iFactCheck,
    'REGRESSIONE: il ramo «troppo corto → rigenero» e tornato sotto il fact-check',
  );
});

test('① il fact-check resta un gate bloccante: il percorso di successo lo attraversa', () => {
  const gen = extractBlock('async function generateAndValidateArticle(');
  const body = gen.text;

  // Il `break` che pubblica la bozza (soglia raggiunta, nessun loop AI) deve
  // stare DOPO il fact-check. Se salisse anche lui, la fix ① avrebbe tolto il
  // gate invece di riordinarlo — che e' l'unico modo in cui questa PR puo'
  // fare danno.
  const iFactCheck = body.indexOf('await llmFactCheck(');
  const iSuccess = body.indexOf('Soglia parole IT raggiunta');
  assert.notEqual(iSuccess, -1, 'il log di successo e sparito');
  assert.ok(
    iFactCheck < iSuccess,
    'REGRESSIONE: la bozza puo raggiungere il break di successo senza passare da llmFactCheck',
  );
});

test('① il costo in fact-check della run 32111688992: da 12 chiamate a 2', () => {
  // LA MISURA, RIGIOCATA SUL SORGENTE VERO.
  // La decisione «rigenero senza pagare il fact-check» viene RITAGLIATA dal
  // file ed ESEGUITA: non e' una riscrittura della regola in linguaggio di
  // test — se qualcuno cambia la condizione nel sorgente, cambia qui.
  const gen = extractBlock('async function generateAndValidateArticle(');
  const from = gen.text.indexOf('const earlyExpansionEligible');
  const to = gen.text.indexOf('continue;', from);
  assert.ok(from !== -1 && to > from, 'la decisione pre-fact-check non e piu ritagliabile: aggiornare questo test');
  const decisionSrc = gen.text.slice(from, to) + 'continue = true; }\n return { continue: false };';

  // eslint-disable-next-line no-new-func
  const decide = new Function(
    'itWords', 'adaptiveMinWords', 'attempt', 'maxAttempts',
    'EARLY_EXPANSION_ENABLED', 'EARLY_EXPANSION_MIN_ATTEMPT', 'EARLY_EXPANSION_MIN_RATIO',
    'const isLastAttempt = attempt >= maxAttempts;\n'
    + 'const console = { error() {} };\n'
    + decisionSrc.replace('continue = true; }', 'return { continue: true }; }'),
  );

  // I sei tentativi della run 32111688992, nell'ordine dei log, contro una
  // soglia adattiva di 700 parole e un budget di 6 tentativi.
  const measured = [227, 194, 179, 202, 223, 489];
  const MIN = 700;
  const MAX_ATTEMPTS = 6;

  let factCheckCalls = 0;
  measured.forEach((itWords, i) => {
    const attempt = i + 1;
    const r = decide(itWords, MIN, attempt, MAX_ATTEMPTS, true, 2, 0.5);
    if (!r.continue) factCheckCalls += 2; // llmFactCheck interroga 2 modelli
  });

  assert.equal(
    factCheckCalls, 2,
    `la run 32111688992 dovrebbe costare 2 chiamate di fact-check, ne costa ${factCheckCalls}`,
  );
  // Prima della fix: 6 tentativi x 2 modelli = 12, tutte pagate e buttate.
  assert.ok(factCheckCalls < 12, 'nessun risparmio rispetto al comportamento pre-fix');
});

// ─────────────────────────────────────────────────────────────────────────────
// ② Espansione anticipata
// ─────────────────────────────────────────────────────────────────────────────

test('② le soglie dell espansione anticipata esistono e sono override-abili', () => {
  assert.match(CODE, /const EARLY_EXPANSION_ENABLED = \(process\.env\.CREATE_ARTICLE_EARLY_EXPANSION \?\? '1'\) !== '0';/);
  assert.match(CODE, /CREATE_ARTICLE_EARLY_EXPANSION_RATIO/);
  assert.match(CODE, /const EARLY_EXPANSION_MIN_ATTEMPT = 2;/);
});

test('② l espansione anticipata non parte al tentativo 1 e non parte sotto il rapporto', () => {
  const gen = extractBlock('async function generateAndValidateArticle(');
  const cond = gen.text.slice(
    gen.text.indexOf('const earlyExpansionEligible'),
    gen.text.indexOf('const earlyExpansionEligible') + 500,
  );
  assert.match(cond, /attempt >= EARLY_EXPANSION_MIN_ATTEMPT/);
  assert.match(cond, /itWords >= adaptiveMinWords \* EARLY_EXPANSION_MIN_RATIO/);
  assert.match(cond, /!isLastAttempt/);
  assert.match(cond, /EARLY_EXPANSION_ENABLED/);
});

test('② le tre reti di sicurezza dell espansione restano tutte al loro posto', () => {
  const gen = extractBlock('async function generateAndValidateArticle(');
  const body = gen.text;
  // preExpansionData: il rollback al testo gia approvato ma corto (#156).
  assert.match(body, /const preExpansionData = structuredClone\(data\);/);
  assert.match(body, /data = preExpansionData;/);
  // Il ri-controllo ripetizione: l espansione e il percorso PIU incline al
  // loop (incidente 2026-07-21, swatch-crescita-2026 / novartis-superaspettative).
  assert.match(body, /AI loop rilevato dopo espansione/);
  // Il ri-passaggio dei gate deterministici.
  assert.match(body, /const expandGateResult = runFactualityGates\(\{/);
});

test('② l espansione ANTICIPATA ripassa il fact-check; quella di ultima spiaggia no', () => {
  const gen = extractBlock('async function generateAndValidateArticle(');
  const body = gen.text;
  const guard = 'if (!isLastAttempt && expandGateResult.passed) {';
  const i = body.indexOf(guard);
  assert.notEqual(
    i, -1,
    'REGRESSIONE: l espansione anticipata non ripassa piu llmFactCheck. E il percorso piu incline '
    + 'alla ripetizione e, da quando puo scattare al tentativo 2, produce l articolo PUBBLICATO nel caso normale.',
  );
  const block = body.slice(i, i + 1400);
  assert.match(block, /await llmFactCheck\(/, 'il ramo esiste ma non chiama piu il fact-check');
  assert.match(block, /data = preExpansionData;/, 'un fact-check fallito deve tornare al testo pre-espansione');

  // E deve restare vero che il fatal path («niente altri tentativi») NON
  // introduce un modo nuovo di perdere un articolo che oggi si pubblica.
  assert.ok(
    body.indexOf('if (!isLastAttempt) {\n      console.error(`  ⚠️  Espansione anticipata senza esito') > i,
    'un espansione anticipata senza esito deve rigenerare, non buttare l articolo',
  );
});

test('② l accettazione al 85% resta un ripiego di ULTIMA spiaggia', () => {
  // «Meglio che fallire» vale quando l alternativa e buttare l articolo. Con
  // tentativi ancora in canna l alternativa e un articolo della lunghezza
  // giusta: se questa riga perde `isLastAttempt`, l espansione anticipata
  // pubblica al 85% della soglia invece di rigenerare — cioe questa PR
  // diventa una relazione di qualita, che non e cio che e stata ratificata.
  const gen = extractBlock('async function generateAndValidateArticle(');
  assert.match(
    gen.text,
    /if \(isLastAttempt && expandedWords >= adaptiveMinWords \* 0\.85\) \{/,
    'REGRESSIONE: il ripiego al 85% e diventato raggiungibile con tentativi residui',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ Il cap del classifier, la concorrenza, la cache
// ─────────────────────────────────────────────────────────────────────────────

// COSA ASSERIVA QUESTO TEST FINO AL POMERIGGIO DEL 2026-08-18, E PERCHE ERA
// SBAGLIATO.
//
// Diceva «il default di maxClassifier e 12, ed e lo stesso numero che il JSDoc
// promette», e pinnava la riga `?? DEFAULT_MAX_CLASSIFIER_CALLS` piu il divieto
// esplicito di tornare a `headlines.length`. La lettura era corretta sul
// documento e sbagliata sul comportamento: fra un JSDoc che dichiara 12 e un
// codice che non applica nessun tetto, la PR ha deciso che avesse ragione il
// JSDoc senza misurare cosa costa il tetto.
//
// Misurato la sera stessa sulla telemetria `PRESPEND_GATE_OUTCOME` di 22 run
// reali di generate-article.yml: il tetto a 12 e vincolante quasi solo su
// `section=frontaliere` (pool `before=` 20, 21, 22, 23 in tutte e 10 le righe) e
// quasi mai su `section=svizzera` (`before=` 4-8 in tutte e 12) — cioe cade
// tutto sulla sezione a secco, 10 articoli contro 78 nelle ultime 24h. Simulato
// su un pool da 20 tutte fuori tema, teneva 8 candidate contro 3, smetteva di
// emettere `PRESPEND_GATE_TOTAL_REJECTION` e consegnava alla generazione le
// headline in ordine di pool invece delle 3 migliori per densita topica.
// Bilancio: ~10 chiamate flash-lite risparmiate contro fino a ~8 tentativi di
// generazione completi bruciati — l inverso dell obiettivo di questa PR, che e
// contare le chiamate LLM.
//
// Quindi il numero non era il difetto: il difetto era la documentazione. Il
// tetto resta disponibile e non e piu imposto, e il JSDoc dice cio che il codice
// fa. Il gruppo ③ conserva il resto (concorrenza, cache), che regge la misura.
test('③ il tetto del classifier e opt-in, e il JSDoc dice cio che il codice fa', () => {
  // Nessun tetto se la variabile non c e: e la riga che decide il regime.
  assert.match(
    CODE,
    /const DEFAULT_MAX_CLASSIFIER_CALLS = resolvePreSpendClassifierCap\(process\.env\.PRESPEND_GATE_MAX_CLASSIFIER\);/,
  );
  assert.match(
    CODE,
    /if \(raw == null \|\| raw === ''\) return null;/,
    'REGRESSIONE: variabile assente torna a valere un numero, cioe il tetto torna imposto per default',
  );
  assert.match(
    CODE,
    /const maxClassifier = Number\(opts\.maxClassifier \?\? DEFAULT_MAX_CLASSIFIER_CALLS \?\? headlines\.length\);/,
    'il fallback finale a `headlines.length` E il «nessun tetto»: senza, `Number(null)` sarebbe 0 e il gate non classificherebbe piu niente',
  );
  // Il JSDoc non deve tornare a dichiarare un numero che il codice non applica —
  // la meta giusta del test precedente, che resta valida.
  assert.doesNotMatch(SRC, /@param \{number\} \[opts\.maxClassifier=12\]/);
  assert.doesNotMatch(SRC, /@param \{number\} \[opts\.maxClassifier=DEFAULT_MAX_CLASSIFIER_CALLS\]/);
});

test('③ le classificazioni girano a concorrenza limitata, non piu in serie', () => {
  const gate = extractBlock('async function applyPreSpendTopicGate(');
  assert.match(gate.text, /await mapWithConcurrency\(toClassify, concurrency,/);

  // Il giro che scorre il pool deve restare deterministico: nessuna chiamata
  // di rete dentro. E' quello a rendere l'assegnazione del budget identica a
  // quella seriale di prima, e a togliere i 16,5s misurati su 19 chiamate.
  const gateLines = gate.text.split('\n');
  const loopStart = gateLines.findIndex((l) => l.trim() === 'for (const h of headlines) {');
  assert.notEqual(loopStart, -1, 'il giro sul pool e sparito: aggiornare questo test');
  const loopEnd = gateLines.findIndex((l, i) => i > loopStart && l === '  }');
  assert.notEqual(loopEnd, -1);
  const loopBody = gateLines.slice(loopStart, loopEnd + 1).join('\n');
  assert.ok(
    !loopBody.includes('classifyFrontaliereRelevance'),
    'REGRESSIONE: il classifier torna dentro il for…await seriale (19 chiamate = 16,5s misurati)',
  );
  assert.ok(!/\bawait\b/.test(loopBody.split('\n').filter((l) => !isCommentLine(l)).join('\n')),
    'REGRESSIONE: e ricomparso un await nel giro deterministico sul pool');
  assert.match(CODE, /const PRESPEND_GATE_CONCURRENCY = Math\.max\(/);
});

test('③ mapWithConcurrency preserva l ordine e non supera il limite di chiamate in volo', async () => {
  const { text } = extractBlock('async function mapWithConcurrency(');
  // Estratta ed eseguita davvero: e una funzione pura, quindi il test puo
  // provarne il comportamento invece di fotografarne il testo.
  // eslint-disable-next-line no-new-func
  const mapWithConcurrency = new Function(`${text}; return mapWithConcurrency;`)();

  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 23 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 5, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1 + (n % 3)));
    inFlight -= 1;
    return n * 2;
  });

  assert.deepEqual(out, items.map((n) => n * 2), 'l ordine dei risultati non e quello del pool');
  assert.ok(peak <= 5, `chiamate in volo oltre il limite: ${peak}`);
  assert.ok(peak > 1, 'nessun parallelismo: il rimedio non rimedia');

  // Casi degeneri: il gate li incontra davvero (pool vuoto, limite assurdo).
  assert.deepEqual(await mapWithConcurrency([], 5, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 0, async (n) => n), [1, 2]);
});

test('③ la memo del classifier e sicura rispetto alla concorrenza: memoizza la promise', () => {
  // La `set` deve stare nel wrapper, non nel corpo: se il corpo tornasse a
  // scrivere il RISULTATO, due headline identiche in volo insieme pagherebbero
  // entrambe la chiamata — cioe il costo che la Map esiste per evitare.
  assert.match(CODE, /_preSpendGateCache\.set\(cacheKey, pending\);/);
  assert.match(CODE, /pending\.catch\(\(\) => \{ _preSpendGateCache\.delete\(cacheKey\); \}\);/);
  assert.doesNotMatch(CODE, /_preSpendGateCache\.set\(cacheKey, result\);/);
  assert.doesNotMatch(CODE, /_preSpendGateCache\.set\(cacheKey, fallback\);/);
  // La chiave deve restare la stessa di prima, separatore NUL compreso:
  // cambiarla svuoterebbe la memo senza che nulla lo dica.
  assert.match(CODE, /function preSpendGateCacheKey\(headline, sourceUrl\) \{/);
  assert.ok(
    CODE.includes('.toLowerCase().trim()} ${classifierSourceHint('),
    'il separatore NUL della chiave di memo e cambiato',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ deadlineMs: nessun ciclo LLM cammina il roster senza un termine
// ─────────────────────────────────────────────────────────────────────────────

test('④ il fact-check porta un deadlineMs: bypassa il wrapper callLLM che ce l ha', () => {
  const line = LINES.find((l) => l.includes('buildFactCheckCallOptions({ model,'));
  assert.ok(line, 'la call di _runSingleFactCheck e sparita');
  assert.match(
    line,
    /deadlineMs: RUN_START_MS \+ RUN_WALL_BUDGET_MS/,
    'REGRESSIONE: _runSingleFactCheck chiama _aiCallLLM diretto e senza deadlineMs — e la chiamata piu costosa del run',
  );
});

test('④ il classifier pre-spend porta un deadlineMs', () => {
  const i = CODE.indexOf('const model = process.env.PRESPEND_GATE_MODEL');
  assert.notEqual(i, -1);
  const region = CODE.slice(i, i + 6000);
  const call = region.slice(region.indexOf('await _aiCallLLM('));
  assert.match(
    call.slice(0, 800),
    /deadlineMs: RUN_START_MS \+ RUN_WALL_BUDGET_MS/,
    'REGRESSIONE: una classificazione da 80 token puo tornare a camminare 56 modelli x 2 retry x 30s',
  );
});

test('④ la selezione headline eredita il deadlineMs dal wrapper callLLM', () => {
  // La scheda elencava questa fra le call «senza deadlineMs». Rimisurato: NON
  // lo e'. `requestHeadlineSelection` chiama il wrapper LOCALE `callLLM`, che
  // dal 2026-07-02 mette `deadlineMs: RUN_START_MS + RUN_WALL_BUDGET_MS` come
  // default su ogni sua chiamata; solo `_runSingleFactCheck` e il classifier
  // pre-spend saltano il wrapper e vanno su `_aiCallLLM` diretto — quelli due
  // erano scoperti davvero, e sono i due test qui sopra.
  //
  // Il termine va quindi pinnato DOVE VIVE. Se qualcuno lo toglie dal default
  // del wrapper, la selezione headline torna a poter camminare il roster
  // intero e questo test lo dice.
  const line = LINES.find((l) => l.includes('const result = await _aiCallLLM(messages, {'));
  assert.ok(line, 'la call interna del wrapper callLLM e sparita: aggiornare questo test');
  assert.match(
    line,
    /deadlineMs: RUN_START_MS \+ RUN_WALL_BUDGET_MS/,
    'REGRESSIONE: il wrapper callLLM non impone piu un termine — ogni suo chiamante (selezione headline compresa) puo camminare il roster',
  );
  // L'invariante e' che le opzioni del CHIAMANTE si spandano DOPO i default,
  // cosi' che possa ancora sovrascriverli. Dal #485 lo spread si chiama
  // `llmOpts` e non `opts`: e' `opts` meno `expectedFields`, che e'
  // un'istruzione per il validatore di `callLLM` e non un parametro di
  // richiesta — infilarla qui la spedirebbe a ~180 modelli come chiave
  // sconosciuta. Le due asserzioni pinnano entrambi i fatti: lo spread c'e',
  // e cio' che spande deriva da `opts`.
  assert.match(line, /\.\.\.llmOpts\b/, 'un caller deve poter ancora sovrascrivere il default');
  assert.match(
    SRC,
    /const \{ expectedFields: _expectedFieldsOpt, \.\.\.llmOpts \} = opts;/,
    'REGRESSIONE: `llmOpts` non deriva piu da `opts` — o il caller non sovrascrive piu i default, o `expectedFields` sta scendendo al provider',
  );

  // E la selezione headline deve continuare a passare dal wrapper, non da
  // `_aiCallLLM` diretto: e' quello a darle il termine.
  const sel = extractBlock('async function requestHeadlineSelection(');
  assert.match(sel.text, /rawText = await callLLM\(/);
  assert.doesNotMatch(sel.text, /_aiCallLLM\(/);
});

// ─────────────────────────────────────────────────────────────────────────────
// ④-bis Il tetto alla fase immagini
// ─────────────────────────────────────────────────────────────────────────────

test('④ ogni strategia immagine controlla il budget di fase', () => {
  const img = extractBlock('async function generateArticleImage(');
  const strategies = img.text.split('\n').filter((l) => /^\s*\/\/ ── Strategy /.test(l));
  assert.equal(strategies.length, 9, `strategie trovate: ${strategies.length} (attese 9)`);

  const guards = img.text.split('\n').filter((l) => /imagePhaseExpired\('Strategy /.test(l));
  assert.equal(
    guards.length, 9,
    `REGRESSIONE: ${guards.length}/9 strategie controllano il budget. Le 9 seriali con timeout 90-120s `
    + 'valgono ~22 minuti nel caso peggiore, e girano DOPO tutti i gate — quando perdere il lavoro costa di piu.',
  );
  assert.match(img.text, /const imageDeadline = Date\.now\(\) \+ IMAGE_PHASE_BUDGET_MS;/);
  assert.match(CODE, /const IMAGE_PHASE_BUDGET_MS = Math\.max\(/);
  // Allo scadere si torna null, che e il percorso NORMALE del fallback.
  assert.match(img.text, /if \(imagePhaseExpired\('Strategy 1'\)\) return null;/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Il bug silenzioso: `makePrompt` fuori dalla sua chiusura
// ─────────────────────────────────────────────────────────────────────────────

test('makePrompt non viene mai usata fuori da translateContent, dove e dichiarata', () => {
  // IL DIFETTO: il retry «titolo/excerpt rimasto in italiano» chiamava
  // makePrompt da translateArticle, un livello sopra la chiusura che la
  // dichiara. Ogni invocazione lanciava `ReferenceError: makePrompt is not
  // defined`, il catch la ingoiava e la riemetteva come «Retry fallito: ...» —
  // che si legge come un problema di rete. Quel retry non ha MAI funzionato.
  const start = LINES.findIndex((l) => l.startsWith('  async function translateContent('));
  assert.notEqual(start, -1, 'translateContent e sparita: aggiornare questo test');
  const end = LINES.findIndex((l, i) => i > start && l === '  }');
  assert.notEqual(end, -1);

  const offenders = LINES
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.includes('makePrompt') && !isCommentLine(l))
    .filter(({ i }) => i < start || i > end)
    .map(({ l, i }) => `${i + 1}: ${l.trim()}`);

  assert.deepEqual(
    offenders, [],
    'makePrompt e usata fuori dalla chiusura che la dichiara → ReferenceError a runtime, ingoiato da un catch',
  );
});

test('il retry «rimasto in italiano» usa un prompt di modulo, e il prompt e giusto', () => {
  const { text } = extractBlock('export function buildForcedRetranslationPrompt(');
  // eslint-disable-next-line no-new-func
  const build = new Function(`${text.replace(/^export /, '')}; return buildForcedRetranslationPrompt;`)();

  const out = build({ langName: 'tedesco', field: 'title', itValue: 'Frontalieri in calo' });
  assert.match(out, /rimasta in ITALIANO/);
  assert.match(out, /tedesco/, 'il prompt non nomina la lingua bersaglio');
  assert.match(out, /- title: Frontalieri in calo/, 'il campo da tradurre non finisce nel prompt');
  assert.match(out, /\{"title": "\.\.\."\}/, 'lo schema JSON di risposta manca');
  // Il chiamante fa `callWithRetry(prompt, ...)` con `jsonMode: true`: senza lo
  // schema il parse fallisce e il retry ricade sul valore italiano, cioe torna
  // esattamente il difetto per un'altra via.
  const en = build({ langName: 'inglese', field: 'excerpt', itValue: 'x' });
  assert.match(en, /\{"excerpt": "\.\.\."\}/);
  assert.match(en, /inglese/);
});
