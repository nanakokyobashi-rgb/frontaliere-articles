/**
 * split-literal-null-body.test.mjs — la stringa `"null"` non e' un corpo
 *
 * IL DIFETTO (issue #799). Nel merge del gate dello split
 * (`_generateSplit`, generator/scripts/create-article.mjs) il RAW del modello
 * vince campo per campo sul blocco normalizzato, e «vince» veniva deciso con
 * un test di vuoto NUDO:
 *
 *     const raw = bodyContent[k];
 *     if (typeof raw === 'string' && raw.trim()) continue;
 *
 * piu' il gemello dell'assemblaggio, una riga sotto:
 *
 *     .filter((x) => typeof x === 'string' && x.trim()).join('\n\n')
 *
 * Il verdetto a valle scarta invece la stringa LETTERALE `"null"`
 * (`isLiteralNullString`, body2-payload-verdict.mjs): e' la serializzazione
 * sbagliata del `null` JSON che il payload di abort di REGOLA #0 dichiara per
 * quel campo, misurata su `haiku`. Su `content.it = { body1: "null", body2:
 * <reale>, body3: <reale> }` il RAW «null» vinceva, il blocco normalizzato non
 * veniva mai guardato, e l'articolo usciva con un paragrafo il cui testo e'
 * `null`: gli altri due body portavano `articolo.length` oltre i 500,
 * `validateItalianPayload` vedeva `body1` non vuoto, e il pezzo arrivava a
 * `content/` e da li' a `dist/api/` senza che nulla fallisse.
 *
 * PERCHE' PER ESTRAZIONE. Stessa ragione di `split-abort-strictness.test.mjs`,
 * da cui questo banco eredita l'impianto: `create-article.mjs` importa
 * l'intero albero del generatore e questo repo non ha `node_modules`, quindi
 * non e' importabile sotto `node --test`. Il blocco viene RITAGLIATO verbatim
 * e valutato con le sole dipendenze iniettate — e le funzioni che DECIDONO
 * (`normalizeItalianContentFromPayload`, `hasUsableContentText`) sono quelle
 * vere, non una replica che misurerebbe se' stessa.
 *
 * Lancia con:
 *   node --test generator/tests/split-literal-null-body.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repairLlmJson } from '../scripts/lib/llm-json-repair.mjs';
import {
  normalizeItalianContentFromPayload,
  hasUsableContentText,
  hasUsableTranslatedText,
  isLiteralNullString,
  isTopicGateAbortVerdict,
  findUnreadableContentEvidence,
  recoverMisplacedFaq,
  BODY_ONLY_FIELDS,
  META_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

const SPLIT_ANCHOR = 'const _generateSplit = async () => {';

function cutGenerateSplit() {
  const a = src.indexOf(SPLIT_ANCHOR);
  assert.notEqual(a, -1, `anchor non trovata — aggiornare questo test: ${SPLIT_ANCHOR}`);
  const rel = src.slice(a).indexOf('\n  };\n');
  assert.notEqual(rel, -1, 'chiusura di _generateSplit non trovata');
  const block = src.slice(a, a + rel + 6);
  assert.ok(block.includes('call=2/2'), 'il ritaglio non contiene la chiamata 2/2: anchor di chiusura sbagliata');
  assert.ok(block.includes('BODY_ONLY_FIELDS'), 'il ritaglio non contiene il merge dei body: anchor sbagliata');
  return block;
}

const SPLIT_SRC = cutGenerateSplit();

const DEPS = [
  '_splitCall1', 'useGeminiDirect', 'callLLM', 'AI_MODELS', 'temperature',
  'IT_GENERATION_MAX_TOKENS', 'forceModel', 'GH_MODEL_HEAVY',
  'PREFERRED_GENERATION_MODELS', '_preferActiveThisAttempt', 'repairLlmJson',
  'normalizeItalianContentFromPayload', 'hasUsableContentText', 'isTopicGateAbortVerdict', 'findUnreadableContentEvidence',
  'recoverMisplacedFaq', 'BODY_ONLY_FIELDS', 'META_ONLY_FIELDS',
  'primaryLocale', 'RUN_REPORT', '_buildHalf', '_splitMode', 'SECTION_NAME',
  'generationAttempt', '_splitBudgetLog', 'console',
];

const makeSplit = new Function(
  '__d',
  `const { ${DEPS.join(', ')} } = __d;\n`
  + 'let _splitPromptTentato = null;\n'
  + `${SPLIT_SRC}\n`
  + 'return _generateSplit;',
);

const BLOCCO = "Il Consiglio di Stato del Canton Ticino ha approvato il messaggio 8412 che rivede il regolamento sull'imposta alla fonte per i lavoratori frontalieri residenti in Italia e attivi nel Cantone. ".repeat(3);

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
  let articoloVisto = null;
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
    hasUsableContentText,
    isTopicGateAbortVerdict,
    findUnreadableContentEvidence,
    recoverMisplacedFaq,
    BODY_ONLY_FIELDS,
    META_ONLY_FIELDS,
    primaryLocale: 'it',
    RUN_REPORT,
    _buildHalf: (_kind, articolo) => {
      articoloVisto = articolo;
      return { p: 'prompt-meta', msgs: [{ role: 'user', content: 'meta' }], schema: { name: 'meta' }, est: 3272, fonteChars: 0, fattiChars: 0 };
    },
    _splitMode: 'on',
    SECTION_NAME: 'frontaliere',
    generationAttempt: 1,
    _splitBudgetLog: 8000,
    console: fakeConsole,
  });
  const out = await _generateSplit();
  return { out, chiamate, righe, log: righe.join('\n'), articoloVisto, RUN_REPORT };
}

// ── 1. Il predicato, da solo ──────────────────────────────────────────────
//
// Una sola sorgente per «questa stringa e' un `null` serializzato» — il gate
// a monte e il verdetto a valle devono chiamare LA STESSA funzione, non una
// riga che le somiglia (AGENTS.md #6).
test('isLiteralNullString/hasUsableContentText: "null" in ogni forma non e\' contenuto', () => {
  for (const v of ['null', 'NULL', 'Null', ' null ', '"null"', "'null'", '" null "']) {
    assert.equal(isLiteralNullString(v), true, `${JSON.stringify(v)} doveva essere un null letterale`);
    assert.equal(hasUsableContentText(v), false, `${JSON.stringify(v)} non e\' contenuto usabile`);
  }
});

// Il predicato dei campi TRADOTTI deroga di proposito, ma SOLO dove `null` e'
// una parola della lingua. Sulla sorgente (italiano) nessuna grafia di `null`
// e' una parola, quindi rifiutarle tutte non puo' cancellare contenuto; su un
// campo `de` `Null` e' la parola per «zero», e rifiutarla fa pubblicare il
// testo IT sotto `/de/` (#831). Su en/fr — e senza locale — la deroga NON
// vale: `Null`/`NULL` come testo intero non e' prosa, e lasciarlo passare
// toglierebbe la recovery che #822 ha messo li'.
test('hasUsableTranslatedText: la deroga al «Null» vale solo per de (#831)', () => {
  for (const v of ['null', ' null ', '"null"', "'null'", '" null "']) {
    for (const loc of ['de', 'en', 'fr', undefined]) {
      assert.equal(hasUsableTranslatedText(v, loc), false, `${JSON.stringify(v)} e\' una serializzazione di null (${loc})`);
    }
    assert.equal(hasUsableContentText(v), false, `${JSON.stringify(v)} non e\' contenuto nemmeno sulla sorgente`);
  }
  for (const v of ['Null', 'NULL', '"Null"']) {
    assert.equal(hasUsableTranslatedText(v, 'de'), true, `${JSON.stringify(v)} e\' testo tedesco legittimo`);
    assert.equal(hasUsableTranslatedText(v, 'DE'), true, `il locale e\' case-insensitive: ${JSON.stringify(v)}`);
    for (const loc of ['en', 'fr', 'it', undefined]) {
      assert.equal(hasUsableTranslatedText(v, loc), false, `${JSON.stringify(v)} non e\' prosa in ${loc}: resta un campo mancante`);
    }
  }
  // Il `Null` DENTRO una frase non e' il caso limite di nessuno dei due
  // predicati: passa in ogni locale, perche' non e' il testo INTERO.
  for (const loc of ['de', 'en', 'fr', undefined]) {
    assert.equal(hasUsableTranslatedText('Null Grad Celsius', loc), true, `testo reale in ${loc}`);
  }
  // Sulla sorgente il predicato NON si e' allentato: `Null`/`NULL` restano
  // scartati li', altrimenti #822 si riaprirebbe dal lato del payload IT.
  for (const v of ['Null', 'NULL', '"Null"']) {
    assert.equal(hasUsableContentText(v), false, `${JSON.stringify(v)} deve restare scartato sul payload sorgente`);
  }
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(hasUsableTranslatedText(v, 'de'), false, `${JSON.stringify(v)} non e\' una stringa non vuota`);
  }
});

test('testo reale (anche fra virgolette) resta contenuto, lo strip serve solo al filtro', () => {
  for (const v of ['nullita\' contrattuale', '"Il messaggio 8412"', 'annullato', 'null e non solo']) {
    assert.equal(isLiteralNullString(v), false, `${JSON.stringify(v)} NON e\' un null letterale`);
    assert.equal(hasUsableContentText(v), true, `${JSON.stringify(v)} e\' contenuto usabile`);
  }
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(hasUsableContentText(v), false, `${JSON.stringify(v)} non e\' una stringa non vuota`);
  }
});

// ── 2. I due call-site del merge, pinnati sul SORGENTE ────────────────────
//
// La metrica della issue #799: zero test di vuoto NUDI sul percorso di
// assemblaggio dello split.
test('il merge dello split non contiene piu\' test di vuoto null-blind', () => {
  assert.equal(SPLIT_SRC.includes('raw.trim()) continue'), false,
    'il gate «il RAW vince» e\' tornato a un raw.trim() nudo: la stringa "null" lo supera');
  assert.equal(/\.filter\(\(x\) => typeof x === 'string' && x\.trim\(\)\)/.test(SPLIT_SRC), false,
    'l\'assemblaggio di `articolo` e\' tornato a un x.trim() nudo: conta "null" come corpo');
  assert.ok(SPLIT_SRC.includes('hasUsableContentText'),
    'il merge non usa piu\' il predicato del valle: i due gate possono divergere di nuovo');
});

// ── 3. Il caso misurato su `haiku` ────────────────────────────────────────
//
// `content.it = { body1: "null", body2: <reale>, body3: <reale> }`. Gli altri
// due body bastano a superare i 500 char, quindi si arriva alla 2/2 e il
// payload viene pubblicato: e' esattamente il percorso in cui il paragrafo
// `null` usciva vivo.
test('body1 = "null" non diventa un paragrafo: non sopravvive al merge ne\' all\'articolo', async () => {
  const { out, chiamate, articoloVisto } = await run({
    risposte: [
      JSON.stringify({ content: { it: { body1: 'null', body2: BLOCCO, body3: BLOCCO } } }),
      PAYLOAD_META,
    ],
  });
  assert.equal(chiamate.length, 2, 'il corpo residuo supera i 500ch: la 2/2 deve partire');
  assert.equal(articoloVisto.includes('null'), false,
    'la stringa "null" e\' finita nell\'articolo passato alla 2/2');
  const merged = JSON.parse(out);
  assert.equal(merged.content.it.body1, '',
    'body1 esce come "null": validateItalianPayload lo conterebbe come campo presente e pubblicherebbe il paragrafo');
  assert.equal(merged.content.it.body2, BLOCCO);
  assert.equal(merged.content.it.body3, BLOCCO);
});

test('anche con le virgolette dentro il valore ("\\"null\\"") il campo non passa', async () => {
  const { out } = await run({
    risposte: [
      JSON.stringify({ content: { it: { body1: '"null"', body2: BLOCCO, body3: BLOCCO } } }),
      PAYLOAD_META,
    ],
  });
  assert.equal(JSON.parse(out).content.it.body1, '');
});

// ── 4. Il RAW «null» non deve nemmeno BATTERE le altre forme ──────────────
//
// Il blocco normalizzato guarda tutte e tre le forme che il valle tollera. Se
// il corpo vero e' li', un `"null"` sotto `content.it` non deve oscurarlo:
// era il modo in cui il difetto perdeva contenuto REALE, non solo il modo in
// cui pubblicava `null`.
test('un body1 reale alla radice vince sul "null" di content.it', async () => {
  const CORPO_RADICE = `${BLOCCO} Alla radice.`;
  const { out } = await run({
    risposte: [
      JSON.stringify({ body1: CORPO_RADICE, content: { it: { body1: 'null', body2: BLOCCO, body3: BLOCCO } } }),
      PAYLOAD_META,
    ],
  });
  assert.equal(JSON.parse(out).content.it.body1, CORPO_RADICE);
});

// ── 5. Nessuna regressione: il corpo reale sopravvive BYTE PER BYTE ───────
//
// Il RAW vince ancora dove porta contenuto, spazi compresi: e' l'invariante
// che `split-abort-strictness.test.mjs` chiama «il corpo della 1/2
// sopravvive all'assemblaggio», e il filtro non deve intaccarlo.
test('il corpo reale continua a vincere sul normalizzato, senza trim', async () => {
  const CON_SPAZI = `  ${BLOCCO}  `;
  const { out } = await run({
    risposte: [
      JSON.stringify({ content: { it: { body1: CON_SPAZI, body2: BLOCCO, body3: BLOCCO } } }),
      PAYLOAD_META,
    ],
  });
  assert.equal(JSON.parse(out).content.it.body1, CON_SPAZI,
    'il RAW e\' stato trimmato: il corpo non sopravvive piu\' byte per byte');
});

// ── 6. Tutti e tre i body a "null" ⇒ nessun corpo, fallback ───────────────
//
// E' la forma piena dell'abort mal serializzato. `articolo` resta vuoto, i
// 500 char non ci sono, e lo split ricade sulla chiamata unica invece di
// spedire tre paragrafi `null` alla 2/2.
test('tre body "null" ⇒ fallback alla chiamata unica, nessuna 2/2', async () => {
  const { out, chiamate, log } = await run({
    risposte: [JSON.stringify({ content: { it: { body1: 'null', body2: 'null', body3: 'null' } } })],
  });
  assert.equal(out, null, 'lo split doveva ricadere sulla chiamata unica');
  assert.equal(chiamate.length, 1, 'nessuna 2/2 su un corpo inesistente');
  assert.match(log, /ha reso 0ch di corpo/, 'il log deve dire che il corpo e\' vuoto, non 14ch di "null"');
});
