/**
 * ── L'ABORT TERMINALE NON DEVE INGHIOTTIRE CIO' CHE NON E' UN RIFIUTO ──────
 *
 * Issue #827 (follow-up di #807, item 1 di #810). Da #807 il verdetto
 * `topic-gate-abort` e' TERMINALE: `callLLM` torna la risposta grezza senza
 * rigenerare, il gate di valle lancia `err.topicGateAbort`, e la sezione si
 * chiude senza articolo — quindi senza push su `content/**` e senza la catena
 * auto-invocante.
 *
 * `normalizeItalianContentFromPayload` legge un campo SOLO se e' una stringa
 * su una chiave dichiarata: `body1` come array/oggetto, o il corpo su
 * `content.it.body`/`text`, per lui non esistono, e tornava `null`
 * esattamente come su un abort puro. Quel `null` significava `reject`
 * (rigenerabile) fino a #807, e da li' in poi «rifiuto terminale»: un modello
 * che ha scritto l'articolo in una forma sbagliata veniva buttato via senza
 * rigenerare.
 *
 * Questo test misura le due direzioni insieme, perche' e' il loro EQUILIBRIO
 * a essere fragile: la forma non letta torna rigenerabile (§1), e l'abort
 * puro resta terminale (§1b) — cioe' le cinque rigenerazioni che #807 ha
 * tolto non tornano.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repairLlmJson } from '../scripts/lib/llm-json-repair.mjs';
import {
  normalizeItalianContentFromPayload,
  hasUsableContentText,
  isTopicGateAbortVerdict,
  findUnreadableContentEvidence,
  classifyBody2Payload,
  recoverMisplacedFaq,
  BODY_ONLY_FIELDS,
  META_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';

const CORPO = 'Il Consiglio di Stato del Canton Ticino ha approvato il messaggio 8412 che rivede il regolamento sull\'imposta alla fonte per i frontalieri residenti in Italia. '.repeat(3);

// ── 1. La forma che il normalizzatore non legge non e' un rifiuto ─────────
//
// Ogni fixture: flag di abort `true` + corpo REALE in una forma che
// `normalizeItalianContentFromPayload` scarta. Il pin che rende il test non
// circolare e' l'assert sul normalizzatore: e' LUI a non vedere niente, ed e'
// esattamente per questo che il payload rischiava l'abort terminale.
const FORME_NON_LETTE = {
  'body1 come array': {
    abort_topical_relevance: true,
    reason: 'la fonte non ha un angolo frontaliere reale',
    content: { it: { title: null, excerpt: null, body1: [CORPO], body2: null, body3: null } },
  },
  'body1 come oggetto': {
    abort_topical_relevance: true,
    reason: 'la fonte non ha un angolo frontaliere reale',
    content: { it: { body1: { paragrafo: CORPO } } },
  },
  'corpo su content.it.body (chiave non dichiarata)': {
    abort_topical_relevance: true,
    reason: 'la fonte non ha un angolo frontaliere reale',
    content: { it: { title: null, body: CORPO } },
  },
  'corpo su content.testo': {
    abort_topical_relevance: true,
    reason: 'la fonte non ha un angolo frontaliere reale',
    content: { testo: CORPO },
  },
  'corpo su text alla radice': {
    abort_topical_relevance: true,
    reason: 'la fonte non ha un angolo frontaliere reale',
    text: CORPO,
  },
  'content come stringa alla radice': {
    abort_topical_relevance: true,
    reason: 'la fonte non ha un angolo frontaliere reale',
    content: CORPO,
  },
  'paragrafi come array alla radice': {
    abort_topical_relevance: true,
    reason: 'la fonte non ha un angolo frontaliere reale',
    paragrafi: [CORPO, CORPO],
  },
};

for (const [nome, payload] of Object.entries(FORME_NON_LETTE)) {
  test(`abort dichiarato + ${nome} ⇒ reject rigenerabile, NON abort terminale`, () => {
    assert.equal(
      normalizeItalianContentFromPayload(payload), null,
      `il fixture non esercita piu' la classe: il normalizzatore vede contenuto su ${nome}`,
    );
    assert.ok(findUnreadableContentEvidence(payload), `nessuna evidenza trovata su ${nome}`);
    assert.equal(
      isTopicGateAbortVerdict(payload), false,
      `${nome} letto come abort: la sezione si chiuderebbe senza articolo e senza rigenerare`,
    );
    const { verdict, missing } = classifyBody2Payload({ parsed: payload });
    assert.equal(verdict, 'reject', `${nome} deve restare rigenerabile`);
    // La diagnostica NOMINA la chiave: senza, il log dice «non normalizzabile»
    // su una risposta che il modello ha scritto per intero, e la classe resta
    // invisibile.
    assert.match(
      missing.join(' '), /abort dichiarato ma contenuto su /,
      `evidenza non nominata su ${nome}: ${missing.join(', ')}`,
    );
  });

  test(`abort dichiarato + ${nome} ⇒ reject anche sulla meta' body dello split`, () => {
    assert.equal(isTopicGateAbortVerdict(payload, { expectedFields: BODY_ONLY_FIELDS }), false);
  });
}

// ── 1b. L'abort PURO resta un abort (regressione su #807) ────────────────
//
// La direzione opposta e' il danno che #807 ha tolto: cinque rigenerazioni
// contro un modello che ha OBBEDITO. Questi payload non devono muoversi.
const ABORT_PURI = {
  'abort nudo': { abort_topical_relevance: true, reason: 'fuori tema' },
  'abort di produzione (campi radice a null)': {
    abort_topical_relevance: true,
    reason: 'La fonte riguarda un evento sanitario locale a Coira.',
    id: null, category: null, image: null, hasCalculator: null,
    imagePrompt: null, imageAlt: null, slugs: null, content: null, seo: null,
  },
  'rifiuto INTITOLATO alla radice (il caso di #807)': {
    abort_topical_relevance: true,
    reason: 'la fonte non riguarda i frontalieri',
    title: 'Rifiuto: fonte non pertinente',
    content: { it: { title: null, excerpt: null, body1: null, body2: null, body3: null } },
  },
  'rifiuto intitolato dentro content.it': {
    abort_topical_relevance: true,
    reason: 'la fonte non riguarda i frontalieri',
    content: { it: { title: 'Rifiuto: fonte non pertinente', excerpt: null, body1: null, body2: null, body3: null } },
  },
  'body serializzati come stringa letterale "null"': {
    abort_topical_relevance: true,
    reason: 'la fonte non riguarda i frontalieri',
    content: { it: { title: 'null', excerpt: 'null', body1: 'null', body2: 'null', body3: 'null' } },
  },
  // Struttura SENZA testo: un abort conforme puo' portarsela dietro, e
  // contarla come contenuto rimetterebbe le rigenerazioni di #807.
  'scheletro vuoto dentro content.it': {
    abort_topical_relevance: true,
    reason: 'fuori tema',
    content: { it: { title: null, seo: { metaTitle: null, metaDescription: null }, tags: [], hasCalculator: false } },
  },
  'reason lungo, senza corpo': {
    abort_topical_relevance: true,
    reason: `${'La fonte riguarda una gara ciclistica locale senza ricadute sui frontalieri. '.repeat(6)}`,
    content: { it: { body1: null, body2: null, body3: null } },
  },
};

for (const [nome, payload] of Object.entries(ABORT_PURI)) {
  test(`abort puro (${nome}) resta terminale: nessuna rigenerazione`, () => {
    assert.equal(findUnreadableContentEvidence(payload), null, `evidenza inventata su un abort puro: ${nome}`);
    assert.equal(
      isTopicGateAbortVerdict(payload), true,
      `${nome} non e' piu' un abort: tornano le cinque rigenerazioni di #807`,
    );
    assert.equal(classifyBody2Payload({ parsed: payload }).verdict, 'topic-gate-abort');
  });
}

// Il corpo LEGGIBILE resta auto-contraddizione, non «forma non letta»: la
// decisione del 2026-07-06 (contenuto sopra flag) non viene toccata.
test('abort dichiarato + corpo leggibile ⇒ NON abort, e nessuna evidenza di forma non letta', () => {
  const payload = {
    abort_topical_relevance: true,
    reason: 'incoerente',
    // Meta PLAUSIBILI e non `'T'`/`'E'`: dal floor di #798 un placeholder di una
    // lettera esce `reject` sul suo conto, e mascherebbe cio' che questo test misura.
    content: { it: { title: 'Imposta alla fonte, cosa cambia nel 2026', excerpt: 'Il punto sulle nuove aliquote per i frontalieri.', body1: CORPO, body2: CORPO, body3: CORPO } },
  };
  assert.equal(findUnreadableContentEvidence(payload), null);
  assert.equal(isTopicGateAbortVerdict(payload), false);
  assert.equal(classifyBody2Payload({ parsed: payload }).verdict, 'ok');
});

// La meta' `meta` dello split: senza campi di corpo fra gli attesi il
// contenuto vince sul flag (carve-out di #807), e questa fix non la sposta.
test("meta' meta: title/excerpt presenti + flag ⇒ non abort, come prima", () => {
  const payload = {
    abort_topical_relevance: true,
    reason: 'x',
    content: { it: { title: 'Titolo', excerpt: 'Excerpt' } },
  };
  assert.equal(isTopicGateAbortVerdict(payload, { expectedFields: META_ONLY_FIELDS }), false);
});

// Senza il flag il predicato non si accende mai: `findUnreadableContentEvidence`
// e' un discriminante DENTRO l'abort, non un secondo validatore di forma.
test('nessun flag ⇒ il verdetto non passa nemmeno da qui', () => {
  const payload = { content: { it: { body1: [CORPO] } } };
  assert.equal(isTopicGateAbortVerdict(payload), false);
  const { verdict, missing } = classifyBody2Payload({ parsed: payload });
  assert.equal(verdict, 'reject');
  assert.equal(missing.join(' '), 'content.it non normalizzabile');
});

// ── 2. Il gate dello split 1/2 eredita il verdetto ────────────────────────
//
// Stessa meccanica dei test fratelli (split-abort-strictness,
// split-literal-null-body): `_generateSplit` viene ritagliato da
// create-article.mjs ed eseguito, perche' quel file non e' importabile dalle
// gate del generatore (girano `node --test` senza `npm ci`).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');
const SPLIT_ANCHOR = 'const _generateSplit = async () => {';

function cutGenerateSplit() {
  const a = src.indexOf(SPLIT_ANCHOR);
  assert.notEqual(a, -1, `anchor non trovata — aggiornare questo test: ${SPLIT_ANCHOR}`);
  const rel = src.slice(a).indexOf('\n  };\n');
  assert.notEqual(rel, -1, 'chiusura di _generateSplit non trovata');
  const block = src.slice(a, a + rel + 6);
  assert.ok(block.includes('call=2/2'), 'il ritaglio non contiene la chiamata 2/2: anchor di chiusura sbagliata');
  assert.ok(block.includes('abort_topical_relevance'), 'il ritaglio non contiene il gate di abort: anchor sbagliata');
  return block;
}

const DEPS = [
  '_splitCall1', 'useGeminiDirect', 'callLLM', 'AI_MODELS', 'temperature',
  'IT_GENERATION_MAX_TOKENS', 'forceModel', 'GH_MODEL_HEAVY',
  'PREFERRED_GENERATION_MODELS', '_preferActiveThisAttempt', 'repairLlmJson',
  'normalizeItalianContentFromPayload', 'hasUsableContentText', 'isTopicGateAbortVerdict',
  'findUnreadableContentEvidence', 'recoverMisplacedFaq',
  'BODY_ONLY_FIELDS', 'META_ONLY_FIELDS',
  'primaryLocale', 'RUN_REPORT', '_buildHalf', '_splitMode', 'SECTION_NAME',
  'generationAttempt', '_splitBudgetLog', 'console',
];

const makeSplit = new Function(
  '__d',
  `const { ${DEPS.join(', ')} } = __d;\n`
  + 'let _splitPromptTentato = null;\n'
  + `${cutGenerateSplit()}\n`
  + 'return _generateSplit;',
);

async function run({ risposte }) {
  const chiamate = [];
  const righe = [];
  const RUN_REPORT = {};
  const _generateSplit = makeSplit({
    _splitCall1: { p: 'prompt-body', msgs: [{ role: 'user', content: 'body' }], schema: { name: 'body' } },
    useGeminiDirect: false,
    callLLM: async () => {
      const r = risposte[chiamate.length];
      chiamate.push(r);
      assert.notEqual(r, undefined, `callLLM chiamata ${chiamate.length} volte, ma il fixture ha ${risposte.length} risposte`);
      return r;
    },
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
    _buildHalf: () => ({ p: 'prompt-meta', msgs: [{ role: 'user', content: 'meta' }], schema: { name: 'meta' }, est: 3272, fonteChars: 0, fattiChars: 0 }),
    _splitMode: 'on',
    SECTION_NAME: 'frontaliere',
    generationAttempt: 1,
    _splitBudgetLog: 8000,
    console: { error: (...a) => righe.push(a.join(' ')) },
  });
  const out = await _generateSplit();
  return { out, chiamate, righe, log: righe.join('\n'), RUN_REPORT };
}

test("1/2 con abort + corpo in forma non letta: niente abort terminale, la forma e' NOMINATA", async () => {
  const risposta = JSON.stringify({
    abort_topical_relevance: true,
    reason: 'la fonte non ha un angolo frontaliere reale',
    content: { it: { title: null, excerpt: null, body1: [CORPO], body2: null, body3: null } },
  });
  const { out, chiamate, log, RUN_REPORT } = await run({ risposte: [risposta] });
  assert.equal(chiamate.length, 1, `la 1/2 doveva bastare. Log:\n${log}`);
  assert.equal(
    out, null,
    `lo split ha restituito il payload invece di ricadere sulla chiamata unica: e' l'abort terminale. Log:\n${log}`,
  );
  assert.doesNotMatch(
    log, /abort terminale, nessuna chiamata 2\/2/,
    `il ramo terminale e' scattato lo stesso. Log:\n${log}`,
  );
  assert.match(log, /content\.it\.body1/, `la forma non letta non e' nominata nel log. Log:\n${log}`);
  // Non e' un'auto-contraddizione: per il gate quel corpo non c'e'.
  assert.equal(
    RUN_REPORT.topicGateSelfContradictions, undefined,
    'la forma non letta viene contata come auto-contraddizione: il contatore misura un caso che non esiste',
  );
});

test('1/2 con abort PURO: il ramo terminale resta intatto', async () => {
  const risposta = JSON.stringify({
    abort_topical_relevance: true,
    reason: 'La fonte riguarda un evento sanitario locale a Coira.',
    content: { it: { title: null, excerpt: null, body1: null, body2: null, body3: null } },
  });
  const { out, chiamate, log } = await run({ risposte: [risposta] });
  assert.equal(chiamate.length, 1, `la 2/2 non doveva partire su un abort. Log:\n${log}`);
  assert.equal(JSON.parse(out).abort_topical_relevance, true, `l'abort puro deve risalire al chiamante. Log:\n${log}`);
  assert.match(log, /abort terminale, nessuna chiamata 2\/2/, `Log:\n${log}`);
});

test("1/2 con abort + corpo LEGGIBILE: resta auto-contraddizione contata", async () => {
  const risposta = JSON.stringify({
    abort_topical_relevance: true,
    reason: 'incoerente',
    content: { it: { body1: CORPO, body2: CORPO, body3: CORPO } },
  });
  const meta = JSON.stringify({ content: { it: { title: 'Titolo', excerpt: 'Excerpt' } } });
  const { out, chiamate, log, RUN_REPORT } = await run({ risposte: [risposta, meta] });
  assert.equal(chiamate.length, 2, `la 2/2 doveva partire sul corpo leggibile. Log:\n${log}`);
  assert.equal(RUN_REPORT.topicGateSelfContradictions, 1, `Log:\n${log}`);
  assert.equal(JSON.parse(out).content.it.body1, CORPO);
});
