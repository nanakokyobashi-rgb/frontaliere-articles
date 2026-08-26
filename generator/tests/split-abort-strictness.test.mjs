/**
 * split-abort-strictness.test.mjs — i due gate di abort devono decidere uguale
 *
 * COSA PINNA, e perche' e' scritto cosi'.
 *
 * IL DIFETTO. `_generateSplit` in `generator/scripts/create-article.mjs`
 * decideva l'abort per rilevanza topica con un test di verita' LASCA:
 *
 *     if (bodyData?.abort_topical_relevance) return JSON.stringify(bodyData);
 *
 * mentre il ramo a valle che decide LA STESSA COSA (« REGOLA #0 abort gate »)
 * usa l'uguaglianza STRETTA `=== true`. Qualunque valore truthy che non sia
 * `true` — la stringa `"false"`, `"no"`, un numero, un oggetto — passava di
 * qui e falliva la'. E la divergenza non era solo sul flag: lo split misurava
 * l'usabilita' del contenuto con `articolo.length >= 500`, il valle con
 * `normalizeItalianContentFromPayload`, che torna truthy con UN carattere in
 * uno qualunque di title/excerpt/body1/body2/body3. Nella finestra 1..499
 * char i due criteri dicevano l'opposto.
 *
 * COSA COSTAVA. L'uscita di abort restituisce la meta' BODY
 * (`ROOT_KEYS_BODY = ['content','abort_topical_relevance','reason']`), che per
 * costruzione non puo' contenere `title`/`excerpt` — quelli nascono solo nella
 * chiamata 2/2. Consegnarla a un gate che poi NON abortisce significa un
 * payload senza i campi obbligatori: `output JSON incompleto: title, excerpt`,
 * rigenerazioni, e modelli penalizzati per aver obbedito al contratto.
 *
 * ONESTA' SULLA CAUSA, perche' questo test non deve raccontare una storia
 * falsa. La misura che ha aperto l'indagine — 4 run del 2026-08-18
 * (32187412494, 32182923129, 32176062690, 32190158524), `call=1/2` stampato
 * 25 volte in tutto e `call=2/2` ZERO — NON e' spiegata da questo difetto.
 * E' spiegata da `isBody2Check` in `callLLM` (create-article.mjs, ~riga 5360):
 *
 *     const isBody2Check = opts.jsonMode
 *       && REQUIRED_IT_BODY_FIELDS.every(f => messages.some(m => m.content?.includes(f)));
 *
 * L'istruzione della meta' BODY dice « NON produrre id, category, image,
 * slugs, title, excerpt, faq o seo », quindi NOMINA `title` ed `excerpt`, e
 * `content.it (body1, body2, body3)` nomina gli altri tre: tutti e cinque i
 * `REQUIRED_IT_BODY_FIELDS` compaiono nel messaggio, e il predicato scatta
 * anche sulla meta' body. Una risposta body-only CONFORME viene quindi
 * classificata `missing = ['title','excerpt']`, rigenerata 5 volte, e infine
 * `callLLM` LANCIA — cosi' `_generateSplit` non raggiunge nemmeno il gate di
 * abort, e non stampa nessun fallback (un throw non e' un `return null`). Vedi
 * il bullet dedicato nella PR: e' un difetto SEPARATO, con un suo rimedio
 * separato a riga 5360.
 *
 * Questo file pinna quindi la SECONDA barriera sullo stesso percorso, non la
 * prima — ed e' comunque necessaria, perche' e' quella che decide cosa succede
 * appena la prima cade.
 *
 * PERCHE' PER ESTRAZIONE E NON PER REPLICA. Stessa ragione di
 * `news-prompt-token-budget.test.mjs`, che ritaglia dallo stesso file: questo
 * repo non ha `node_modules` e `create-article.mjs` importa l'intero albero del
 * generatore (`jsdom`, `sharp`, …), quindi importarlo e' impossibile. Ma la
 * ragione vera e' un'altra: una replica scritta a mano della logica di abort
 * misurerebbe la replica. Qui `_generateSplit` viene RITAGLIATA verbatim dal
 * sorgente e valutata con le sole dipendenze iniettate, e le due funzioni che
 * DECIDONO — `repairLlmJson` e `normalizeItalianContentFromPayload` — sono
 * quelle vere, importate dai loro moduli.
 *
 * Cosa e' stubbato, e cosa quindi questo file NON misura: `callLLM` (qui e'
 * l'osservabile — quante volte viene chiamata dice se la 2/2 e' avvenuta; ma
 * stubbarla toglie di mezzo proprio `isBody2Check`, cioe' la prima barriera
 * descritta sopra) e `_buildHalf` (costruisce prompt e schema della 2/2, che
 * hanno il loro banco in news-prompt-token-budget.test.mjs).
 *
 * Se l'anchor sparisce il test FALLISCE rumorosamente: non puo' passare a
 * vuoto su una stringa vuota.
 *
 * Lancia con:
 *   node --test generator/tests/split-abort-strictness.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repairLlmJson } from '../scripts/lib/llm-json-repair.mjs';
import {
  normalizeItalianContentFromPayload,
  recoverMisplacedFaq,
  BODY_ONLY_FIELDS,
  META_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

const SPLIT_ANCHOR = 'const _generateSplit = async () => {';

/** Ritaglia `_generateSplit` verbatim, dalla sua anchor alla chiusura indentata. */
function cutGenerateSplit() {
  const a = src.indexOf(SPLIT_ANCHOR);
  assert.notEqual(a, -1, `anchor non trovata — aggiornare questo test: ${SPLIT_ANCHOR}`);
  const rel = src.slice(a).indexOf('\n  };\n');
  assert.notEqual(rel, -1, 'chiusura di _generateSplit non trovata');
  const block = src.slice(a, a + rel + 6);
  // Non puo' passare a vuoto: se il ritaglio finisse corto, il corpo che
  // stiamo misurando non ci sarebbe piu'.
  assert.ok(block.includes('call=2/2'), 'il ritaglio non contiene la chiamata 2/2: anchor di chiusura sbagliata');
  assert.ok(block.includes('abort_topical_relevance'), 'il ritaglio non contiene il gate di abort: anchor sbagliata');
  return block;
}

const SPLIT_SRC = cutGenerateSplit();

/** Le dipendenze che il blocco legge dalla chiusura di `callGemini`. */
const DEPS = [
  '_splitCall1', 'useGeminiDirect', 'callLLM', 'AI_MODELS', 'temperature',
  'IT_GENERATION_MAX_TOKENS', 'forceModel', 'GH_MODEL_HEAVY',
  'PREFERRED_GENERATION_MODELS', '_preferActiveThisAttempt', 'repairLlmJson',
  'normalizeItalianContentFromPayload', 'recoverMisplacedFaq',
  // #485: le due chiamate dichiarano a `callLLM` i campi che la loro meta'
  // produce davvero, invece di lasciarglieli dedurre dal testo del prompt.
  'BODY_ONLY_FIELDS', 'META_ONLY_FIELDS',
  'primaryLocale', 'RUN_REPORT', '_buildHalf', '_splitMode', 'SECTION_NAME',
  'generationAttempt', '_splitBudgetLog', 'console',
];

const makeSplit = new Function(
  '__d',
  `const { ${DEPS.join(', ')} } = __d;\n`
  // `_splitPromptTentato` e' un `let` della chiusura che il blocco ASSEGNA:
  // va dichiarato, non destrutturato, o l'assegnazione esplode.
  + 'let _splitPromptTentato = null;\n'
  + `${SPLIT_SRC}\n`
  + 'return _generateSplit;',
);

const BODY_BLOCK = 'Il Consiglio di Stato del Canton Ticino ha approvato il messaggio 8412 che rivede il regolamento sull\'imposta alla fonte per i lavoratori frontalieri residenti in Italia e attivi nel Cantone. '.repeat(3);
const CORPO_BUONO = { body1: BODY_BLOCK, body2: BODY_BLOCK, body3: BODY_BLOCK };
// 1..499 char: la finestra in cui i due criteri di usabilita' divergevano —
// sotto la soglia dei 500 dello split, ma `normalizeItalianContentFromPayload`
// lo vede eccome, quindi il valle NON abortirebbe su questo payload.
const CORPO_CORTO = { body1: 'Due righe e basta.' };

/** Il payload della meta' BODY: per costruzione NON ha title/excerpt. */
function payloadBody(flag, content) {
  const p = { content: content ? { it: content } : {} };
  if (flag !== undefined) p.abort_topical_relevance = flag;
  if (flag !== undefined && flag !== null) p.reason = 'La fonte non ha un angolo frontaliere reale.';
  return JSON.stringify(p);
}

// #508: le altre due forme che `normalizeItalianContentFromPayload` tollera
// a valle — `content` con la lingua saltata, e i campi alla radice del
// payload senza `content` affatto — che `payloadBody()` sopra non esercita
// mai perche' avvolge sempre in `{ content: { it: ... } }`.
function payloadBodyContentSenzaLocale(flag, content) {
  const p = { content: content || {} };
  if (flag !== undefined) p.abort_topical_relevance = flag;
  if (flag !== undefined && flag !== null) p.reason = 'La fonte non ha un angolo frontaliere reale.';
  return JSON.stringify(p);
}
function payloadBodyRadice(flag, content) {
  const p = { ...(content || {}) };
  if (flag !== undefined) p.abort_topical_relevance = flag;
  if (flag !== undefined && flag !== null) p.reason = 'La fonte non ha un angolo frontaliere reale.';
  return JSON.stringify(p);
}

/**
 * Il payload della meta' META. La forma segue lo schema vero: `title` ed
 * `excerpt` stanno in `content.<locale>` (`CONTENT_KEYS_META = ['title',
 * 'excerpt','faq']`), non alla radice — `ROOT_KEYS_META` non li contiene.
 */
const PAYLOAD_META = JSON.stringify({
  id: 'imposta-fonte-frontalieri-messaggio-8412',
  category: 'fiscalita',
  content: {
    it: {
      title: 'Imposta alla fonte, cosa cambia per i frontalieri',
      excerpt: 'Il messaggio 8412 rivede le aliquote e introduce una notifica trimestrale.',
    },
  },
});

/**
 * Esegue `_generateSplit` con le due risposte LLM date, e restituisce
 * l'esito piu' tutto cio' che serve a giudicarlo: quante chiamate LLM sono
 * partite, e ogni riga stampata.
 */
async function run({ risposte }) {
  const chiamate = [];
  const righe = [];
  const RUN_REPORT = {};
  const fakeConsole = { error: (...a) => righe.push(a.join(' ')) };
  const callLLM = async () => {
    const r = risposte[chiamate.length];
    chiamate.push(r);
    assert.notEqual(r, undefined, `callLLM chiamata ${chiamate.length} volte, ma il fixture ha ${risposte.length} risposte`);
    return r;
  };
  const _generateSplit = makeSplit({
    _splitCall1: { p: 'prompt-body', msgs: [{ role: 'user', content: 'body' }], schema: { name: 'body' } },
    useGeminiDirect: false,
    callLLM,
    AI_MODELS: { GEMINI_FLASH: 'gemini-flash' },
    temperature: 0.7,
    IT_GENERATION_MAX_TOKENS: 8000,
    forceModel: null,
    GH_MODEL_HEAVY: 'gpt-4.1',
    PREFERRED_GENERATION_MODELS: [],
    _preferActiveThisAttempt: false,
    repairLlmJson,
    normalizeItalianContentFromPayload,
    recoverMisplacedFaq,
    BODY_ONLY_FIELDS,
    META_ONLY_FIELDS,
    primaryLocale: 'it',
    RUN_REPORT,
    _buildHalf: () => ({ p: 'prompt-meta', msgs: [{ role: 'user', content: 'meta' }], schema: { name: 'meta' }, est: 3272, fonteChars: 0, fattiChars: 0 }),
    _splitMode: 'on',
    SECTION_NAME: 'frontaliere',
    generationAttempt: 1,
    _splitBudgetLog: 8000,
    console: fakeConsole,
  });
  const out = await _generateSplit();
  return { out, chiamate, righe, log: righe.join('\n'), RUN_REPORT };
}

// ── 1. Flag TRUTHY-ma-non-`true` + corpo buono ⇒ si arriva alla 2/2 ───────
//
// Il modello obbedisce al contratto («non abortire») scrivendo `"false"`
// invece di `false`, o `"no"`. Il valle usa `=== true`, quindi per lui questi
// payload NON sono un abort: lo split deve essere altrettanto stretto, o
// consegna una meta' body a un ramo che si aspetta un articolo intero.
for (const flag of ['false', 'no', 'False', 0.5, { motivo: 'boh' }]) {
  test(`flag truthy-ma-non-true (${JSON.stringify(flag)}) + corpo buono ⇒ chiamata 2/2, payload con title ed excerpt`, async () => {
    const { out, chiamate, log } = await run({
      risposte: [payloadBody(flag, CORPO_BUONO), PAYLOAD_META],
    });
    assert.equal(chiamate.length, 2, `la 2/2 non e' partita. Log:\n${log}`);
    assert.ok(log.includes('call=2/2'), `manca il marker call=2/2. Log:\n${log}`);
    assert.notEqual(out, null, 'lo split e\' caduto in fallback invece di completare');
    const payload = JSON.parse(out);
    // I due campi che la meta' body non puo' produrre, e la cui assenza
    // faceva stampare «output JSON incompleto: title, excerpt».
    assert.ok(payload.content.it.title, `payload senza title: e' la meta' body, non l'assemblato. Log:\n${log}`);
    assert.ok(payload.content.it.excerpt, `payload senza excerpt: e' la meta' body, non l'assemblato. Log:\n${log}`);
    // E cio' che il valle usera' davvero per giudicarlo.
    assert.ok(normalizeItalianContentFromPayload(payload).title, 'il valle non vedrebbe un title in questo payload');
    // Il corpo della 1/2 sopravvive all'assemblaggio: la 2/2 non lo riscrive.
    assert.equal(payload.content.it.body1, CORPO_BUONO.body1);
  });
}

// ── 1b. Flag truthy-ma-non-`true` + corpo CORTO ⇒ fallback, non abort ────
//
// Il caso che la sola strettezza deve prendere. Senza corpo utilizzabile non
// c'e' contenuto da far vincere, ma un abort restituito su un flag che il
// valle NON riconosce come abort e' il peggiore dei due mondi: consegna una
// meta' body senza `title`/`excerpt` a un gate che non abortira' mai. L'unica
// uscita corretta e' `null` — ricadi sulla chiamata unica.
for (const flag of ['false', 'no']) {
  test(`flag truthy-ma-non-true (${JSON.stringify(flag)}) + corpo corto ⇒ fallback alla chiamata unica, NON un abort`, async () => {
    const { out, chiamate, log } = await run({ risposte: [payloadBody(flag, CORPO_CORTO)] });
    assert.equal(chiamate.length, 1, 'senza corpo utilizzabile la 2/2 non deve partire');
    assert.equal(
      out, null,
      `restituita la meta' body come se fosse un abort, ma il valle usa \`=== true\` e non abortira'. Log:\n${log}`,
    );
    // E il valore anomalo va NOMINATO: e' l'unico indizio che il modello ha
    // tentato un abort in una forma che nessuno dei due gate riconosce.
    assert.match(
      log, /abort_topical_relevance=.*ne' true ne' assente/,
      `il flag malformato non compare nei log: resta invisibile proprio il caso che questa fix illumina. Log:\n${log}`,
    );
  });
}

// ── 2. Flag `=== true` + contenuto ASSENTE ⇒ abort, payload com'e' ───────
//
// L'unico caso in cui l'abort e' corretto: il valle, con lo stesso payload,
// abortirebbe anche lui (`normalizeItalianContentFromPayload` → null).
test('flag === true + contenuto assente ⇒ abort terminale, si ritorna il payload com\'e\'', async () => {
  const grezzo = payloadBody(true, null);
  // Il pin che rende il test non circolare: e' il PREDICATO DEL VALLE a dire
  // che questo payload e' un abort, non una convinzione di questo file.
  assert.equal(normalizeItalianContentFromPayload(JSON.parse(grezzo)), null);
  const { out, chiamate } = await run({ risposte: [grezzo] });
  assert.equal(chiamate.length, 1, 'l\'abort e\' terminale: la 2/2 non deve partire');
  assert.notEqual(out, null, 'un abort vero non e\' un fallback: non deve tornare null');
  const payload = JSON.parse(out);
  assert.equal(payload.abort_topical_relevance, true, 'il flag deve arrivare intatto al valle, che lo riconosce');
  assert.ok(!payload.content?.it?.title, 'un abort non porta metadati');
});

// ── 2b. Flag `=== true` + corpo 1..499 char ⇒ NON un abort ───────────────
//
// La finestra in cui allineare il solo FLAG non bastava. Qui lo split vedeva
// `articolo.length < 500` e restituiva il payload come abort; il valle, con
// `normalizeItalianContentFromPayload` truthy, avrebbe saltato il proprio
// throw di abort, preso il ramo di auto-contraddizione, e sarebbe finito in
// `validateItalianPayload` con `Campo title mancante per it`. Cioe' di nuovo
// un payload consegnato a un gate che non abortisce.
test('flag === true + corpo sotto i 500 char ⇒ NON un abort: il valle non abortirebbe, quindi si ricade sulla chiamata unica', async () => {
  const grezzo = payloadBody(true, CORPO_CORTO);
  assert.ok(
    normalizeItalianContentFromPayload(JSON.parse(grezzo)),
    'il fixture non e\' piu\' nella finestra di divergenza: il valle vedrebbe contenuto qui',
  );
  const { out, chiamate, log, RUN_REPORT } = await run({ risposte: [grezzo] });
  assert.equal(chiamate.length, 1, 'sotto i 500 char non si spende la 2/2');
  assert.equal(
    out, null,
    `restituito come abort un payload che il valle NON riconoscerebbe come abort: `
    + `finirebbe in validateItalianPayload con «Campo title mancante per it». Log:\n${log}`,
  );
  assert.match(log, /contract violation, trusting content over the flag/, `la contraddizione va loggata anche qui. Log:\n${log}`);
  assert.equal(RUN_REPORT.topicGateSelfContradictions, 1);
});

// ── 3. Flag `=== true` + corpo buono ⇒ vince il contenuto ────────────────
//
// La politica del valle, non una nuova: « the model contradicted its own abort
// signal; trust the content it produced over the flag ». Se lo split abortisse
// qui, scarterebbe un articolo valido e brucerebbe il budget di retry —
// esattamente cio' che il guard di auto-contraddizione del 2026-07-06 (run
// 28802314827) esiste per impedire.
test('flag === true + corpo buono ⇒ vince il contenuto, si prosegue alla 2/2 e la contraddizione viene loggata', async () => {
  const { out, chiamate, log, RUN_REPORT } = await run({
    risposte: [payloadBody(true, CORPO_BUONO), PAYLOAD_META],
  });
  assert.equal(chiamate.length, 2, `la 2/2 non e' partita nonostante il corpo buono. Log:\n${log}`);
  const payload = JSON.parse(out);
  assert.ok(payload.content.it.title && payload.content.it.excerpt, 'il payload assemblato deve avere i metadati della 2/2');
  assert.match(
    log,
    /abort_topical_relevance=true MA ha anche reso \d+ch di corpo/,
    `la contraddizione non e' loggata: e' un verdetto che chi legge i log deve poter vedere. Log:\n${log}`,
  );
  assert.equal(
    RUN_REPORT.topicGateSelfContradictions, 1,
    'la contraddizione va contata QUI: `merged` nasce da metaData e non porta il flag, quindi il gate di valle non la vedra\' mai',
  );
});

// ── 4. Nessuna uscita muta ───────────────────────────────────────────────
//
// E' il silenzio dell'uscita di abort che l'aveva resa l'unico ramo non
// osservabile della funzione: le altre stampavano, e il conteggio a zero delle
// LORO righe era l'unico indizio rimasto. Ogni uscita anticipata deve lasciare
// una riga, e la riga deve dire QUALE uscita e' stata presa — un log presente
// ma sbagliato non aiuterebbe piu' di uno assente.
const USCITE = [
  ['JSON non valido dalla 1/2', ['non e\' JSON'], /chiamata 1\/2 senza JSON valido/],
  ['abort con contenuto assente', [payloadBody(true, null)], /abort terminale, nessuna chiamata 2\/2/],
  ['corpo troppo corto senza flag', [payloadBody(undefined, CORPO_CORTO)], /chiamata 1\/2 ha reso \d+ch di corpo/],
  ['JSON non valido dalla 2/2', [payloadBody(undefined, CORPO_BUONO), 'nemmeno questo e\' JSON'], /chiamata 2\/2 senza JSON valido/],
];
for (const [nome, risposte, atteso] of USCITE) {
  test(`uscita anticipata «${nome}» lascia la SUA riga nei log`, async () => {
    const { righe } = await run({ risposte });
    const proprie = righe.filter((r) => r.includes('[prompt-split]'));
    assert.ok(proprie.length >= 1, `uscita muta: nessuna riga [prompt-split]. Righe: ${JSON.stringify(righe)}`);
    assert.match(
      proprie.join('\n'), atteso,
      `la riga non nomina questa uscita: chi legge i log non puo' distinguerla dalle altre. Righe: ${JSON.stringify(righe)}`,
    );
  });
}

// ── 5b. Forme alternative del payload body-only (#508) ────────────────────
//
// `_corpoUsabile`/`bodyContent` leggevano solo `content[primaryLocale]`,
// mentre il predicato di usabilita' che questo file pinna sopra —
// `normalizeItalianContentFromPayload`, lo stesso che decide `_valleAbortirebbe`
// — tollera anche `content` senza la lingua e i campi alla radice del
// payload (body2-payload-verdict.mjs:198). Un body-only genuino in una di
// queste due forme veniva letto come vuoto e mandato sul ramo di fallback a
// chiamata singola nonostante contenuto vero: la stessa classe di
// disallineamento fra i due criteri che questo file pinna sull'asse del
// flag, riaperta sull'asse della forma del payload.
for (const [nome, builder] of [
  ['content senza locale', payloadBodyContentSenzaLocale],
  ['campi alla radice', payloadBodyRadice],
]) {
  test(`corpo buono in forma "${nome}" ⇒ chiamata 2/2, non fallback, corpo sopravvive all'assemblaggio`, async () => {
    const { out, chiamate, log } = await run({
      risposte: [builder(undefined, CORPO_BUONO), PAYLOAD_META],
    });
    assert.equal(chiamate.length, 2, `la 2/2 non e' partita per la forma "${nome}". Log:\n${log}`);
    assert.notEqual(out, null, `lo split e' caduto in fallback per la forma "${nome}" nonostante contenuto vero. Log:\n${log}`);
    const payload = JSON.parse(out);
    // Il fallback tollerante passa dal blocco normalizzato — che fa `.trim()`
    // sui valori — non dal raw object del modello: il confronto e' quindi
    // sulla versione trimmata, a differenza della forma normale (test 1
    // sopra), che preserva il raw byte per byte.
    assert.equal(
      payload.content.it.body1, CORPO_BUONO.body1.trim(),
      `il corpo della forma "${nome}" non e' sopravvissuto all'assemblaggio`,
    );
  });
}

// ── 5. Drift guard sul sorgente: i due gate restano allineati ────────────
//
// Le asserzioni sopra muoiono se il comportamento regredisce; questa dice
// PERCHE', e nomina il ramo gemello. I due gate decidono la stessa cosa e
// devono confrontare allo stesso modo, sul flag E sul predicato di usabilita':
// e' la divergenza fra i due, non l'uno o l'altro, ad aver prodotto il difetto.
test('lo split e il gate di valle decidono l\'abort con gli stessi due criteri', () => {
  // Sui commenti no: il commento della fix CITA il codice vecchio per
  // spiegare il difetto, e un grep ingenuo lo leggerebbe come una
  // regressione. Si guardano le righe di CODICE.
  const codice = SPLIT_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(
    codice.includes('bodyData?.abort_topical_relevance === true'),
    'lo split non usa piu\' l\'uguaglianza stretta: torna la divergenza col gate di valle',
  );
  assert.equal(
    /if \(bodyData\?\.abort_topical_relevance\)/.test(codice), false,
    'test di verita\' LASCA rimesso nello split: e\' il difetto che questo file esiste per pinnare',
  );
  assert.ok(
    codice.includes('normalizeItalianContentFromPayload(bodyData'),
    'lo split ha smesso di usare il predicato di usabilita\' DEL VALLE: allineare il solo flag non basta',
  );
  assert.ok(
    src.includes('itData?.abort_topical_relevance === true'),
    'il gate di valle non usa piu\' `=== true`: questo test pinna un allineamento, non un lato solo',
  );
});
