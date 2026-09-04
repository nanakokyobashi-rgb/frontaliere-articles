/**
 * ── L'ABORT TERMINALE NON DEVE INGHIOTTIRE CIO' CHE NON E' UN RIFIUTO ──────
 *
 * follow-up di #807 (issue #810). Da quel merge il verdetto
 * `topic-gate-abort` e' TERMINALE: `callLLM` torna la risposta grezza senza
 * rigenerare, il gate di valle lancia `err.topicGateAbort`, e la sezione si
 * chiude senza articolo — quindi senza push su `content/**` e senza la catena
 * auto-invocante. Tre forme rischiavano di finirci dentro senza essere
 * rifiuti:
 *
 *   1. il corpo emesso in una forma che `normalizeItalianContentFromPayload`
 *      NON legge (`body1` come array/oggetto, `content.it.body`, `text`,
 *      `content` come stringa): il normalizzatore torna `null` esattamente
 *      come su un abort puro, e prima di #807 quel `null` significava
 *      `reject` — cioe' rigenerabile;
 *   2. una generazione TRONCATA che, riparata, avesse la forma di un rifiuto
 *      intitolato;
 *   3. il flag della meta' `meta` dello split che sopravvive al merge e viene
 *      riletto a valle sui body della meta' `body`.
 *
 * Il caso 2 e' misurato qui, non assunto: la sweep sotto tronca payload di
 * abort in OGNI posizione e verifica che nessun prefisso arrivi a un verdetto
 * di abort.
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
};

for (const [nome, payload] of Object.entries(FORME_NON_LETTE)) {
  test(`abort dichiarato + ${nome} ⇒ reject rigenerabile, NON abort terminale`, () => {
    assert.equal(
      normalizeItalianContentFromPayload(payload), null,
      'il fixture non esercita piu' + ' la classe: il normalizzatore vede contenuto qui',
    );
    assert.ok(
      findUnreadableContentEvidence(payload), `nessuna evidenza trovata su ${nome}`,
    );
    assert.equal(
      isTopicGateAbortVerdict(payload), false,
      `${nome} letto come abort: la sezione si chiuderebbe senza articolo e senza rigenerare`,
    );
    const { verdict, missing } = classifyBody2Payload({ parsed: payload });
    assert.equal(verdict, 'reject', `${nome} deve restare rigenerabile`);
    // La diagnostica NOMINA la chiave: senza, il log dice «non normalizzabile»
    // su una risposta che il modello ha scritto per intero.
    assert.match(missing.join(' '), /abort dichiarato ma contenuto su /, `evidenza non nominata: ${missing.join(', ')}`);
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
};

for (const [nome, payload] of Object.entries(ABORT_PURI)) {
  test(`abort puro (${nome}) resta terminale: nessuna rigenerazione`, () => {
    assert.equal(findUnreadableContentEvidence(payload), null, `evidenza inventata su un abort puro: ${nome}`);
    assert.equal(isTopicGateAbortVerdict(payload), true, `${nome} non e' piu' un abort: tornano le cinque rigenerazioni di #807`);
    assert.equal(classifyBody2Payload({ parsed: payload }).verdict, 'topic-gate-abort');
  });
}

// Il corpo LEGGIBILE resta auto-contraddizione, non «forma non letta»: la
// decisione del 2026-07-06 (contenuto sopra flag) non viene toccata.
test('abort dichiarato + corpo leggibile ⇒ NON abort, e nessuna evidenza di forma non letta', () => {
  const payload = {
    abort_topical_relevance: true,
    reason: 'incoerente',
    content: { it: { title: 'T', excerpt: 'E', body1: CORPO, body2: CORPO, body3: CORPO } },
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

// ── 2. Una generazione TRONCATA non puo' diventare un abort ───────────────
//
// L'item 2 di #810: se `repairLlmJson` chiudesse un JSON tagliato dopo
// `abort_topical_relevance:true` + un `title` ma prima dei body, il payload
// riparato sarebbe indistinguibile da un rifiuto intitolato — e verrebbe
// accettato come abort invece che rigenerato.
//
// La sweep MISURA la premessa invece di assumerla: tronca in ogni posizione
// payload di abort nei due ordini di serializzazione (flag prima del
// contenuto e dopo), con e senza fence markdown, e con graffe DENTRO
// `reason` — cioe' il caso che manderebbe fuori strada l'estrazione
// bracket-balanced. Un prefisso proprio di un JSON bilanciato ha sempre
// almeno una graffa aperta in piu', e `repairLlmJson` non ne aggiunge: quindi
// o non parsa, oppure il taglio ha colpito solo il fence e il payload e'
// COMPLETO. Se un giorno la riparazione imparasse a chiudere le graffe,
// questo test diventa rosso — ed e' il punto.
const PAYLOAD_TRONCABILI = {
  'flag prima del contenuto': {
    abort_topical_relevance: true,
    reason: 'La fonte riguarda un evento locale senza ricadute frontaliere.',
    title: 'Rifiuto: fonte non pertinente',
    content: { it: { title: 'Titolo pieno', excerpt: 'Excerpt pieno', body1: CORPO, body2: CORPO, body3: CORPO } },
    seo: { metaTitle: 'm', metaDescription: 'd' },
  },
  'flag dopo il contenuto': {
    content: { it: { title: 'Titolo pieno', excerpt: 'Excerpt pieno', body1: CORPO, body2: CORPO, body3: CORPO } },
    abort_topical_relevance: true,
    reason: 'La fonte riguarda un evento locale senza ricadute frontaliere.',
  },
  'graffe dentro reason': {
    abort_topical_relevance: true,
    reason: 'La fonte cita il template {"body1": "..."} e non ha ricadute frontaliere.',
    content: { it: { title: 'Titolo pieno', body1: CORPO } },
  },
};

for (const [nome, oggetto] of Object.entries(PAYLOAD_TRONCABILI)) {
  for (const fence of [false, true]) {
    test(`troncamento (${nome}${fence ? ', in fence markdown' : ''}) ⇒ mai un abort`, () => {
      const pieno = fence ? `\`\`\`json\n${JSON.stringify(oggetto)}\n\`\`\`` : JSON.stringify(oggetto);
      const parsabili = [];
      for (let i = 1; i < pieno.length; i++) {
        const troncato = pieno.slice(0, i);
        let parsed;
        try {
          parsed = JSON.parse(repairLlmJson(troncato));
        } catch {
          continue; // parse fallito ⇒ `reject`, che e' l'esito giusto.
        }
        parsabili.push(i);
        const { verdict } = classifyBody2Payload({ parsed });
        assert.notEqual(
          verdict, 'topic-gate-abort',
          `il prefisso di ${i} char parsa come abort: una generazione troncata verrebbe chiusa come rifiuto.\n${troncato.slice(-120)}`,
        );
      }
      // Gli unici prefissi parsabili sono quelli che tagliano il solo fence di
      // chiusura: il JSON dentro e' intero. Se ne comparissero altri, la
      // riparazione avrebbe iniziato a inventare struttura.
      for (const i of parsabili) {
        assert.ok(
          fence && pieno.slice(0, i).includes(JSON.stringify(oggetto)),
          `prefisso parsabile a ${i} char che NON contiene il payload intero: repairLlmJson sta chiudendo un troncamento`,
        );
      }
    });
  }
}

// ── 3. Il flag della 2/2 non sopravvive al merge dello split ──────────────
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
  'normalizeItalianContentFromPayload', 'hasUsableContentText', 'isTopicGateAbortVerdict', 'recoverMisplacedFaq',
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

const PAYLOAD_BODY_BUONO = JSON.stringify({
  content: { it: { body1: CORPO, body2: CORPO, body3: CORPO } },
});

test("il flag della 2/2 non arriva al payload assemblato: il gate di valle non lo rilegge sui body della 1/2", async () => {
  const metaConFlag = JSON.stringify({
    abort_topical_relevance: true,
    reason: 'la fonte non ha un angolo frontaliere reale',
    content: { it: { title: 'Imposta alla fonte, cosa cambia', excerpt: 'Il messaggio 8412 rivede le aliquote.' } },
  });
  const { out, chiamate, log, RUN_REPORT } = await run({ risposte: [PAYLOAD_BODY_BUONO, metaConFlag] });
  assert.equal(chiamate.length, 2, `la 2/2 non e' partita. Log:\n${log}`);
  assert.notEqual(out, null, 'lo split e\' caduto in fallback');
  const payload = JSON.parse(out);
  assert.equal(
    payload.abort_topical_relevance, undefined,
    'il flag della meta\' meta sopravvive al merge: a valle diventa una «contract violation» '
    + 'contata su body che quella meta\' non ha prodotto',
  );
  // Il payload assemblato e' contenuto pieno: il valle non deve vedere niente
  // di cui contraddirsi.
  assert.equal(isTopicGateAbortVerdict(payload), false);
  assert.ok(normalizeItalianContentFromPayload(payload).title);
  assert.equal(payload.content.it.body1, CORPO, 'il corpo della 1/2 deve sopravvivere byte per byte');
  // Lo scarto va NOMINATO, o e' un'uscita muta.
  assert.match(log, /flag NON propagato al merge/, `lo scarto del flag non compare nei log. Log:\n${log}`);
  // Il contatore delle auto-contraddizioni conta i casi VERI: la 1/2 qui non
  // ha dichiarato niente.
  assert.equal(RUN_REPORT.topicGateSelfContradictions, undefined);
});

test('senza flag sulla 2/2 il merge resta identico (nessuna chiave persa)', async () => {
  const meta = JSON.stringify({
    id: 'imposta-fonte-messaggio-8412',
    category: 'fiscalita',
    content: { it: { title: 'Imposta alla fonte, cosa cambia', excerpt: 'Il messaggio 8412 rivede le aliquote.' } },
  });
  const { out } = await run({ risposte: [PAYLOAD_BODY_BUONO, meta] });
  const payload = JSON.parse(out);
  assert.equal(payload.id, 'imposta-fonte-messaggio-8412');
  assert.equal(payload.category, 'fiscalita');
  assert.equal(payload.content.it.title, 'Imposta alla fonte, cosa cambia');
  assert.equal(payload.content.it.body2, CORPO);
});
