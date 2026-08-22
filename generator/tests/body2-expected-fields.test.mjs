/**
 * ── LA META' BODY DELLO SPLIT NON DEVE PIU' ESSERE GIUDICATA UN ARTICOLO ───
 *
 * Difetto (#485). `callLLM()` decideva SE validare una risposta e QUALI campi
 * pretendere annusando il testo del prompt:
 *
 *     opts.jsonMode && REQUIRED_IT_BODY_FIELDS.every(f => messages.some(m => m.content?.includes(f)))
 *
 * cioe' cercando la PRESENZA DELLA STRINGA, non la RICHIESTA DEL CAMPO. Lo
 * split a due chiamate (#430) manda per la meta' BODY un'istruzione che dice
 *
 *     «content.it (body1, body2, body3). NON produrre id, category, image,
 *      slugs, title, excerpt, faq o seo: verranno chiesti in una chiamata
 *      separata.»
 *
 * — tre campi chiesti e DUE VIETATI, ma tutti e cinque i nomi presenti. Il
 * predicato scattava a cinque campi e una risposta body-only CONFORME usciva
 * `output JSON incompleto: title, excerpt`, rigenerata `maxBody2Retries` volte
 * camminando ogni volta la cascata dei modelli, poi `qualityReject`.
 *
 * MISURA: lo split non ha completato una sola volta dal #430. Sulle 4 run del
 * 2026-08-18 (32187412494, 32182923129, 32176062690, 32190158524) `call=1/2`
 * e' stampato 25 volte e `call=2/2` ZERO; sulle run 32209129247 e 32193289552
 * del 2026-08-19 `roster_blocked` compare 12 e 11 volte, col primo tentativo
 * che brucia ~31 minuti senza produrre niente.
 *
 * ── COSA ESEGUE QUESTO FILE, E PERCHE' NON E' UN GUARD SUL SORGENTE ────────
 *
 * Un test che cercasse `expectedFields` nel testo di create-article.mjs
 * passerebbe anche con un'implementazione che ignora il parametro. Qui invece
 * gira il CODICE VERO: `callLLM` e `_generateSplit` sono RITAGLIATI dal
 * sorgente e istanziati con `new Function`, iniettando le dipendenze che
 * leggono dalla chiusura. E' la stessa tecnica di split-abort-strictness.test.mjs,
 * ed e' l'unica disponibile: create-article.mjs non e' importabile dalle gate
 * del generatore, che girano `node --test` senza `npm ci` e non hanno `jsdom`
 * (tirato dentro a module scope da extract-article-text.mjs).
 *
 * Il test centrale (#3) e' letteralmente lo scenario di produzione: prompt
 * della meta' body VERBATIM dal sorgente + risposta body-only conforme, dentro
 * `_generateSplit` reale che chiama `callLLM` reale. Prima della fix quel
 * percorso lanciava; ora arriva a `call=2/2`.
 *
 * MUTAZIONI COPERTE (ognuna uccisa da un test di COMPORTAMENTO):
 *
 *   M1  resolveBody2Validation ignora `expectedFields` (torna sempre i 5)     → #3, #4
 *   M2  `enabled: true` anche senza jsonMode                                  → #9
 *   M3  validazione spenta quando `expectedFields` manca                      → #5
 *   M4  `fields` vuoto come default                                           → #5
 *   M5  classifyBody2Payload ignora `expectedFields`                          → #1, #3
 *   M6  la soglia `body2<40` sparisce                                         → #6
 *   M7  la chiamata 1/2 dello split non passa `expectedFields`                → #3
 *   M8  la chiamata 2/2 dello split non passa `expectedFields`                → #7
 *   M9  `expectedFields` viene inoltrato al provider dentro le opts           → #8
 *   M10 la validazione di `expectedFields` sparisce (accetta campi ignoti)    → #10
 *   M11 il ramo body-only smette di rigettare un body2 ASSENTE                → #2
 *   M12 il merge della meta' meta torna a leggere SOLO
 *       `content[primaryLocale]`, perdendo title/excerpt alla radice
 *       (issue #494)                                                         → #13
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  repairLlmJson,
  describeJsonParseError,
  describeRawForDiagnostics,
} from '../scripts/lib/llm-json-repair.mjs';
import {
  resolveBody2Validation,
  classifyBody2Payload,
  normalizeItalianContentFromPayload,
  REQUIRED_IT_BODY_FIELDS,
  BODY_ONLY_FIELDS,
  META_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';
import { describePayloadRejection } from '../scripts/lib/llm-payload-diagnostics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

// ── I due ritagli dal sorgente ────────────────────────────────────────────

/** Ritaglia una `async function <nome>(...)` verbatim, fino alla `}` in colonna 0. */
function cutFunction(nome, sentinelle) {
  const anchor = `async function ${nome}(`;
  const a = src.indexOf(anchor);
  assert.notEqual(a, -1, `anchor non trovata — aggiornare questo test: ${anchor}`);
  const rel = src.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura di ${nome} non trovata`);
  const block = src.slice(a, a + rel + 2);
  for (const s of sentinelle) {
    assert.ok(block.includes(s), `il ritaglio di ${nome} non contiene ${JSON.stringify(s)}: anchor sbagliata`);
  }
  return block;
}

const CALL_LLM_SRC = cutFunction('callLLM', [
  'resolveBody2Validation',
  'classifyBody2Payload',
  'maxBody2Retries',
  'qualityReject',
]);

const SPLIT_ANCHOR = 'const _generateSplit = async () => {';
function cutGenerateSplit() {
  const a = src.indexOf(SPLIT_ANCHOR);
  assert.notEqual(a, -1, `anchor non trovata — aggiornare questo test: ${SPLIT_ANCHOR}`);
  const rel = src.slice(a).indexOf('\n  };\n');
  assert.notEqual(rel, -1, 'chiusura di _generateSplit non trovata');
  const block = src.slice(a, a + rel + 6);
  assert.ok(block.includes('call=2/2'), 'il ritaglio non contiene la chiamata 2/2: anchor di chiusura sbagliata');
  return block;
}
const SPLIT_SRC = cutGenerateSplit();

/**
 * L'istruzione VERBATIM della meta' body, quella che accendeva l'euristica.
 * Il fixture non puo' invecchiare in silenzio: se `buildMessages` la
 * riformula, questa asserzione cade e va aggiornato il test.
 */
const FRAMMENTO_ISTRUZIONE_BODY = '(body1, body2, body3). NON produrre id, category, image, slugs, title, excerpt, faq o seo';
assert.ok(
  src.includes(FRAMMENTO_ISTRUZIONE_BODY),
  "l'istruzione della meta' body e' cambiata nel sorgente: aggiornare FRAMMENTO_ISTRUZIONE_BODY",
);
const FRAMMENTO_ISTRUZIONE_FULL = 'content.${primaryLocale} (title, excerpt, body1, body2, body3, faq), seo.';
assert.ok(
  src.includes(FRAMMENTO_ISTRUZIONE_FULL),
  "l'istruzione della chiamata unica e' cambiata nel sorgente: aggiornare FRAMMENTO_ISTRUZIONE_FULL",
);

const PROMPT_BODY = `⚠️ ISTRUZIONE SPECIALE PER QUESTA CHIAMATA:\nGenera SOLO il JSON con questi campi: content.it ${FRAMMENTO_ISTRUZIONE_BODY}: verranno chiesti in una chiamata separata.`;
const PROMPT_FULL = `⚠️ ISTRUZIONE SPECIALE PER QUESTA CHIAMATA:\nGenera SOLO il JSON con questi campi: id, category, image, hasCalculator, imagePrompt, imageAlt (4 lingue), slugs (4 lingue), content.it (title, excerpt, body1, body2, body3, faq), seo.`;
// La chiamata a campo singolo di translateArticle: nomina UN campo solo.
const PROMPT_TRADUZIONE = 'Traduci in inglese il seguente campo.\n- body2: Il Consiglio di Stato ha approvato il messaggio.\n\nRispondi con un JSON object:\n{"body2": "..."}';

const BLOCCO = "Il Consiglio di Stato del Canton Ticino ha approvato il messaggio 8412 che rivede il regolamento sull'imposta alla fonte per i lavoratori frontalieri residenti in Italia. ".repeat(3);

/** La risposta CONFORME della meta' body: per contratto senza title/excerpt. */
const RISPOSTA_BODY_CONFORME = JSON.stringify({
  content: { it: { body1: BLOCCO, body2: BLOCCO, body3: BLOCCO } },
});
/** La risposta CONFORME della meta' meta: per contratto senza i body. */
const RISPOSTA_META_CONFORME = JSON.stringify({
  id: 'imposta-fonte-frontalieri-messaggio-8412',
  category: 'fiscalita',
  content: {
    it: {
      title: 'Imposta alla fonte, cosa cambia per i frontalieri',
      excerpt: 'Il messaggio 8412 rivede le aliquote e introduce una notifica trimestrale.',
    },
  },
});

// ── L'istanziazione del `callLLM` vero ────────────────────────────────────

const CALL_LLM_DEPS = [
  '_aiCallLLM', 'AI_MODELS', 'RUN_START_MS', 'RUN_WALL_BUDGET_MS', 'repairLlmJson',
  'classifyBody2Payload', 'resolveBody2Validation', 'describePayloadRejection',
  'describeJsonParseError', 'describeRawForDiagnostics', 'recordModelContentFailure',
  'recordModelContentSuccess', 'wallBudgetExceeded', 'console',
];

/**
 * @param {object} o
 * @param {string[]} o.risposte  cosa risponde il finto provider, in ordine.
 * @returns {{ callLLM: Function, provider: object[], righe: string[], punteggi: object }}
 */
function makeCallLLM({ risposte, modello = 'gpt-4.1' }) {
  const provider = [];
  const righe = [];
  const punteggi = { success: [], failure: [] };
  const _aiCallLLM = async (messages, opts) => {
    provider.push({ messages, opts });
    const r = risposte[Math.min(provider.length - 1, risposte.length - 1)];
    if (opts?.modelUsedRef) opts.modelUsedRef.model = modello;
    return r;
  };
  const fabbrica = new Function(
    '__d',
    `const { ${CALL_LLM_DEPS.join(', ')} } = __d;\n`
    // `_localFallbackUsedThisHeadline` e' un `let` di modulo che callLLM ASSEGNA:
    // va dichiarato, non destrutturato, o l'assegnazione esplode.
    + 'let _localFallbackUsedThisHeadline = false;\n'
    + `${CALL_LLM_SRC}\n`
    + 'return callLLM;',
  );
  const callLLM = fabbrica({
    _aiCallLLM,
    AI_MODELS: { GEMINI_FLASH: 'gemini-flash', LOCAL_FALLBACK: 'local/fallback' },
    RUN_START_MS: Date.now(),
    RUN_WALL_BUDGET_MS: 60 * 60 * 1000,
    repairLlmJson,
    classifyBody2Payload,
    resolveBody2Validation,
    describePayloadRejection,
    describeJsonParseError,
    describeRawForDiagnostics,
    recordModelContentFailure: (m) => punteggi.failure.push(m),
    recordModelContentSuccess: (m) => punteggi.success.push(m),
    wallBudgetExceeded: () => false,
    console: { error: (...a) => righe.push(a.join(' ')) },
  });
  return { callLLM, provider, righe, punteggi };
}

// ── 1. Il predicato non pretende piu' cio' che il prompt VIETA ─────────────
//
// Il payload body-only conforme, giudicato con i campi che la meta' body
// produce davvero, e' `ok`. Con i cinque campi e' `reject` su title/excerpt:
// e' esattamente il verdetto che ha bloccato lo split per un giorno.

test('#1 il payload body-only e ok sui campi attesi, reject sui cinque', () => {
  const parsed = JSON.parse(RISPOSTA_BODY_CONFORME);

  const ristretto = classifyBody2Payload({ parsed, expectedFields: BODY_ONLY_FIELDS });
  assert.equal(ristretto.verdict, 'ok');
  assert.deepEqual(ristretto.missing, []);

  const largo = classifyBody2Payload({ parsed });
  assert.equal(largo.verdict, 'reject');
  assert.deepEqual(largo.missing, ['title', 'excerpt']);
});

// ── 2. Restringere NON e' disattivare ──────────────────────────────────────

test('#2 un body-only con body3 mancante resta reject anche sui campi ristretti', () => {
  const parsed = JSON.parse(JSON.stringify({ content: { it: { body1: BLOCCO, body2: BLOCCO } } }));
  const { verdict, missing } = classifyBody2Payload({ parsed, expectedFields: BODY_ONLY_FIELDS });
  assert.equal(verdict, 'reject');
  assert.deepEqual(missing, ['body3']);
});

// ── 3. IL TEST CENTRALE: lo split completo, sul codice vero ────────────────
//
// `_generateSplit` reale + `callLLM` reale + provider finto. Prima della fix
// la chiamata 1/2 lanciava `qualityReject` dopo 5 rigenerazioni e `call=2/2`
// non veniva mai stampato — la firma osservata in produzione.

const SPLIT_DEPS = [
  '_splitCall1', 'useGeminiDirect', 'callLLM', 'AI_MODELS', 'temperature',
  'IT_GENERATION_MAX_TOKENS', 'forceModel', 'GH_MODEL_HEAVY',
  'PREFERRED_GENERATION_MODELS', '_preferActiveThisAttempt', 'repairLlmJson',
  'normalizeItalianContentFromPayload', 'BODY_ONLY_FIELDS', 'META_ONLY_FIELDS',
  'primaryLocale', 'RUN_REPORT', '_buildHalf', '_splitMode', 'SECTION_NAME',
  'generationAttempt', '_splitBudgetLog', 'console',
];

async function runSplit({ risposte }) {
  const righe = [];
  const fakeConsole = { error: (...a) => righe.push(a.join(' ')) };
  const { callLLM, provider, righe: righeCall, punteggi } = makeCallLLM({ risposte });
  const fabbrica = new Function(
    '__d',
    `const { ${SPLIT_DEPS.join(', ')} } = __d;\n`
    + 'let _splitPromptTentato = null;\n'
    + `${SPLIT_SRC}\n`
    + 'return _generateSplit;',
  );
  const _generateSplit = fabbrica({
    _splitCall1: {
      p: 'prompt-body',
      msgs: [{ role: 'user', content: PROMPT_BODY }],
      schema: { name: 'article_body_only' },
    },
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
    BODY_ONLY_FIELDS,
    META_ONLY_FIELDS,
    primaryLocale: 'it',
    RUN_REPORT: {},
    _buildHalf: () => ({
      p: 'prompt-meta',
      msgs: [{ role: 'user', content: 'ISTRUZIONE: id, category, content.it (title, excerpt, faq), seo.' }],
      schema: { name: 'article_metadata_only' },
      est: 3272,
      fonteChars: 0,
      fattiChars: 0,
    }),
    _splitMode: 'on',
    SECTION_NAME: 'frontaliere',
    generationAttempt: 1,
    _splitBudgetLog: 8000,
    console: fakeConsole,
  });
  return { _generateSplit, provider, punteggi, log: () => [...righe, ...righeCall].join('\n') };
}

test('#3 lo split arriva a call=2/2 con UNA chiamata per meta e restituisce il merge', async () => {
  const { _generateSplit, provider, punteggi, log } = await runSplit({
    risposte: [RISPOSTA_BODY_CONFORME, RISPOSTA_META_CONFORME],
  });

  const out = await _generateSplit();

  assert.equal(provider.length, 2, `una chiamata per meta': ricevute ${provider.length}\n${log()}`);
  assert.match(log(), /call=2\/2/, `la 2/2 non e' stata raggiunta:\n${log()}`);
  assert.doesNotMatch(log(), /output JSON incompleto/, `rigetto su una risposta conforme:\n${log()}`);
  assert.deepEqual(punteggi.failure, [], 'nessun modello va penalizzato per aver obbedito al contratto');

  const merged = JSON.parse(out);
  assert.equal(merged.content.it.title, 'Imposta alla fonte, cosa cambia per i frontalieri');
  // Il merge porta il payload GREZZO della 1/2, non il blocco normalizzato:
  // il verdetto giudica, non riscrive.
  assert.equal(merged.content.it.body1, BLOCCO);
  assert.equal(merged.id, 'imposta-fonte-frontalieri-messaggio-8412');

  // La chiamata 1/2 ha davvero dichiarato la propria meta'.
  assert.deepEqual(provider[0].opts.jsonSchema, { name: 'article_body_only' });
});

// ── 4. La stessa risposta SENZA il flag: il difetto, riprodotto ────────────
//
// Non e' un test del passato: e' cio' che prova che a fare la differenza sia
// `expectedFields` e non un altro effetto del ritaglio.

test('#4 senza expectedFields la stessa risposta body-only viene rigettata 5 volte e lancia', async () => {
  const { callLLM, provider, righe, punteggi } = makeCallLLM({ risposte: [RISPOSTA_BODY_CONFORME] });

  await assert.rejects(
    () => callLLM([{ role: 'user', content: PROMPT_BODY }], { jsonMode: true }),
    (e) => {
      assert.equal(e.qualityReject, true);
      assert.match(e.message, /title, excerpt/);
      return true;
    },
  );
  assert.equal(provider.length, 5, 'le 5 rigenerazioni sono la cascata bruciata in produzione');
  assert.equal(punteggi.failure.length, 5, 'e 5 penalizzazioni contro un modello che aveva obbedito');
  assert.match(righe.join('\n'), /output JSON incompleto: title, excerpt/);
});

// ── 5. Chi dimentica il flag NON perde la validazione ──────────────────────
//
// Il vincolo (b): il percorso di esaurimento retry LANCIA, ed e' cio' che
// impedisce di spedire italiano sotto /en /de /fr. Un default «non validare
// senza flag» rimetterebbe in circolo quel baco.

test('#5 il prompt full-article senza flag valida ancora tutti e cinque i campi', async () => {
  const { callLLM, provider } = makeCallLLM({ risposte: [RISPOSTA_BODY_CONFORME] });
  await assert.rejects(
    () => callLLM([{ role: 'user', content: PROMPT_FULL }], { jsonMode: true }),
    (e) => e.qualityReject === true && /title, excerpt/.test(e.message),
  );
  assert.equal(provider.length, 5);

  const r = resolveBody2Validation({ jsonMode: true, messages: [{ content: PROMPT_FULL }] });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.fields, REQUIRED_IT_BODY_FIELDS);
});

// ── 6. La soglia body2<40 sopravvive dove il body2 e' atteso ──────────────

test('#6 body2 troppo corto resta un rigetto sulla meta body, e non esiste sulla meta meta', () => {
  const corto = JSON.parse(JSON.stringify({ content: { it: { body1: BLOCCO, body2: 'Due righe.', body3: BLOCCO } } }));
  const { verdict, missing } = classifyBody2Payload({ parsed: corto, expectedFields: BODY_ONLY_FIELDS });
  assert.equal(verdict, 'reject');
  assert.ok(missing.includes('body2<40'), `atteso body2<40, ricevuto ${missing.join(', ')}`);

  const meta = classifyBody2Payload({ parsed: JSON.parse(RISPOSTA_META_CONFORME), expectedFields: META_ONLY_FIELDS });
  assert.equal(meta.verdict, 'ok');
  assert.deepEqual(meta.missing, []);
});

// ── 7. La meta' meta ORA e' validata (prima non lo era affatto) ────────────
//
// Il suo prompt non nomina `body1/body2/body3` — stanno dentro i blocchi
// `${_isMeta ? '' : ...}` di `buildPrompt`, e `minWordsInstruction` e' saltata
// per `meta` — quindi l'euristica era FALSA e la 2/2 passava senza giudizio.
// Una risposta senza `title` sarebbe arrivata al merge per morire dopo su
// `validateItalianPayload`, senza rigenerazione ne' rotazione di modello.

test('#7 una risposta meta senza title viene rigettata e rigenerata, non lasciata passare', async () => {
  const metaSenzaTitle = JSON.stringify({
    id: 'x', category: 'fiscalita',
    content: { it: { excerpt: 'Un sottotitolo qualunque con dati concreti.' } },
  });
  const { _generateSplit, provider, log } = await runSplit({
    risposte: [RISPOSTA_BODY_CONFORME, metaSenzaTitle],
  });
  await assert.rejects(() => _generateSplit(), (e) => e.qualityReject === true && /title/.test(e.message));
  assert.ok(provider.length > 2, `la 2/2 dev'essere stata rigenerata, chiamate=${provider.length}\n${log()}`);
  assert.match(log(), /output JSON incompleto: title/);
});

// ── 8. `expectedFields` non scende al provider ────────────────────────────

test('#8 expectedFields resta nel validatore e non entra nelle opts della richiesta', async () => {
  const { callLLM, provider } = makeCallLLM({ risposte: [RISPOSTA_BODY_CONFORME] });
  await callLLM([{ role: 'user', content: PROMPT_BODY }], { jsonMode: true, expectedFields: BODY_ONLY_FIELDS });
  assert.equal(provider.length, 1);
  assert.ok(
    !('expectedFields' in provider[0].opts),
    `expectedFields spedito al provider: ${Object.keys(provider[0].opts).join(', ')}`,
  );
  assert.equal(provider[0].opts.jsonMode, true, 'le altre opts devono passare intatte');
});

// ── 9. Il flag non puo' accendere la validazione fuori da jsonMode ────────

test('#9 senza jsonMode la validazione resta spenta anche con expectedFields', async () => {
  assert.deepEqual(
    resolveBody2Validation({ jsonMode: false, expectedFields: BODY_ONLY_FIELDS }),
    { enabled: false, fields: [] },
  );

  const { callLLM, provider } = makeCallLLM({ risposte: ['testo libero, non JSON'] });
  const out = await callLLM([{ role: 'user', content: PROMPT_BODY }], { expectedFields: BODY_ONLY_FIELDS });
  assert.equal(out, 'testo libero, non JSON');
  assert.equal(provider.length, 1, 'nessuna rigenerazione su una chiamata non-jsonMode');
});

// ── 10. Un elenco malformato e' un errore di programmazione, non un dato ───

test('#10 expectedFields invalido lancia invece di ricadere in silenzio sull euristica', () => {
  for (const cattivo of [[], 'body1', {}, ['body1', 'sottotitolo'], ['seo']]) {
    assert.throws(
      () => resolveBody2Validation({ jsonMode: true, expectedFields: cattivo, messages: [{ content: PROMPT_FULL }] }),
      TypeError,
      `atteso TypeError per ${JSON.stringify(cattivo)}`,
    );
  }
});

// ── 11. La chiamata a campo singolo di translateArticle resta fuori ────────
//
// Il vincolo (a): li' `missing` sarebbe garantito non vuoto (title, excerpt,
// body1, body3 non sono in quel payload per costruzione) e ogni traduzione
// morirebbe di `qualityReject`.

test('#11 la traduzione a campo singolo non viene giudicata come un articolo', async () => {
  const r = resolveBody2Validation({ jsonMode: true, messages: [{ content: PROMPT_TRADUZIONE }] });
  assert.equal(r.enabled, false);

  const traduzione = JSON.stringify({ body2: 'The State Council approved message 8412.' });
  const { callLLM, provider } = makeCallLLM({ risposte: [traduzione] });
  const out = await callLLM([{ role: 'user', content: PROMPT_TRADUZIONE }], { jsonMode: true });
  assert.equal(out, traduzione, 'la traduzione dev essere restituita intatta');
  assert.equal(provider.length, 1, 'nessuna rigenerazione: la validazione non si applica qui');
});

// ── 12. L'abort di REGOLA #0 continua a costare UNA chiamata ───────────────
//
// #484 e la PR che ha estratto il verdetto hanno pagato questo comportamento:
// restringere i campi attesi non deve riaprirlo. L'ordine dei rami dentro
// `classifyBody2Payload` e' l'invariante.

test('#12 un abort conforme sulla meta body resta un abort, non un payload incompleto', async () => {
  const abort = JSON.stringify({
    abort_topical_relevance: true,
    reason: "La fonte riguarda l'inaugurazione di un'ala ospedaliera a Coira, senza aggancio frontaliere.",
    content: null,
  });
  const { callLLM, provider, punteggi } = makeCallLLM({ risposte: [abort] });
  const out = await callLLM([{ role: 'user', content: PROMPT_BODY }], { jsonMode: true, expectedFields: BODY_ONLY_FIELDS });
  assert.equal(out, abort, "l'abort risale grezzo al chiamante");
  assert.equal(provider.length, 1, 'un abort legittimo costa UNA chiamata');
  assert.deepEqual(punteggi.failure, []);
  assert.deepEqual(punteggi.success, [], 'ne penalizzato ne premiato: un abort non e contenuto');
});

// ── 13. Il merge recupera title/excerpt quando arrivano FUORI da content.it ─
//
// Buco lasciato dalla #7 (issue #494): `normalizeItalianContentFromPayload`
// tollera title/excerpt in `content[locale]`, in `content` senza locale, o
// ALLA RADICE del payload — e' cosi' che `classifyBody2Payload` giudica `ok`
// la risposta. Il merge dentro `_generateSplit` leggeva pero' SOLO
// `metaData.content[primaryLocale]`: una risposta gia' giudicata `ok` con i
// campi alla radice passava il verdetto (e premiava il modello) per poi
// perderli comunque nel merge, morendo piu' a valle in
// `validateItalianPayload` con `Campo title mancante per it` — senza
// rigenerazione ne' rotazione di modello. Il test #7 copre «meta SENZA
// title» (giustamente rigettata); questo copre «meta con title FUORI
// POSTO» (dev'essere ACCETTATA e recuperata, non buttata).

test('#13 un meta con title/excerpt alla radice viene recuperato dal merge, non perso', async () => {
  const metaRadice = JSON.stringify({
    id: 'imposta-fonte-frontalieri-messaggio-8412',
    category: 'fiscalita',
    title: 'Imposta alla fonte, cosa cambia per i frontalieri',
    excerpt: 'Il messaggio 8412 rivede le aliquote e introduce una notifica trimestrale.',
  });

  // Premessa: il verdetto giudica questa forma `ok`, non `reject` — altrimenti
  // il gap non esisterebbe affatto.
  const verdetto = classifyBody2Payload({ parsed: JSON.parse(metaRadice), expectedFields: META_ONLY_FIELDS });
  assert.equal(verdetto.verdict, 'ok', "title/excerpt alla radice devono passare il verdetto: e' qui che si apre il gap");

  const { _generateSplit, provider, log } = await runSplit({
    risposte: [RISPOSTA_BODY_CONFORME, metaRadice],
  });

  const out = await _generateSplit();

  assert.equal(provider.length, 2, `nessuna rigenerazione: la risposta e' conforme\n${log()}`);
  assert.doesNotMatch(log(), /output JSON incompleto/, `rigetto su una risposta che il verdetto giudica ok:\n${log()}`);

  const merged = JSON.parse(out);
  assert.equal(
    merged.content.it.title,
    'Imposta alla fonte, cosa cambia per i frontalieri',
    'il title alla radice deve arrivare in content.it, non essere perso nel merge',
  );
  assert.equal(merged.content.it.excerpt, 'Il messaggio 8412 rivede le aliquote e introduce una notifica trimestrale.');
});
