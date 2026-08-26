/**
 * ── UN ABORT DI REGOLA #0 DEVE COSTARE UNA CHIAMATA ────────────────────────
 *
 * ## Il fatto
 *
 * Run 32175400548 del corpus (`generate-article.yml`), 2026-08-18 19:15:09Z,
 * sezione svizzera. `claude-cli/haiku` — primo del roster, e dopo
 * l'evaporazione del free tier l'unico percorso affidabile — ha risposto con
 * un abort di REGOLA #0 perfettamente conforme al contratto, 484 caratteri:
 *
 *     rigetto: famiglia=forma-sbagliata(chiavi) model=claude-cli/haiku
 *       rawChars=484 repairedChars=484 kept=100 parse=ok tipo=object
 *       chiaviRadice=[abort_topical_relevance,reason,id,category,image,...]
 *     output JSON incompleto: content.it non normalizzabile (tentativo 1/5) — rigenero...
 *
 * Poi quattro rigenerazioni da 60-240 s l'una sullo stesso modello a pagamento,
 * e la sezione chiusa con «no article generated». Senza articolo non c'e' push
 * su `content/`, quindi la catena auto-invocante non riparte e si aspetta il
 * prossimo `schedule` (:07 e :37).
 *
 * Il modello NON aveva sbagliato: `abort_topical_relevance` e' un campo del
 * contratto, e il prompt di generazione gli ordina esplicitamente di usarlo
 * («torna al GATE DI RILEVANZA TOPICA (REGOLA #0) e rifiuta con
 * "abort_topical_relevance": true»). A sbagliare era il chiamante.
 *
 * ## Cosa osserva questo test, e come
 *
 * Non una replica della regola: la regola VERA. Il test
 *
 *   1. legge `generator/scripts/create-article.mjs`, ne ESTRAE il sorgente di
 *      `callLLM()` per bilanciamento di graffe, e lo istanzia con `new Function`
 *      iniettando le sue dipendenze libere;
 *   2. inietta le implementazioni REALI di `repairLlmJson` e
 *      `classifyBody2Payload` — non stub, non copie: gli stessi oggetti codice
 *      che gira la produzione;
 *   3. stubba SOLO il trasporto (`_aiCallLLM`, cioe' la rete) e ne CONTA le
 *      invocazioni.
 *
 * Perche' l'estrazione invece di un import: `create-article.mjs` non e'
 * importabile dalle gate del generatore, che girano `node --test` senza
 * `npm ci` (vedi .github/workflows/tests.yml) e non hanno `jsdom`, tirato
 * dentro a module scope da `extract-article-text.mjs`. L'alternativa —
 * riscrivere il ciclo nel test — misurerebbe la copia, non il codice spedito.
 *
 * Se i delimitatori si spostano, il test fallisce RUMOROSAMENTE invece di
 * passare a vuoto: e' la ragione dell'assert sulla firma prima di tutto il
 * resto.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  repairLlmJson,
  describeJsonParseError,
  describeRawForDiagnostics,
} from '../scripts/lib/llm-json-repair.mjs';
import {
  classifyBody2Payload,
  normalizeItalianContentFromPayload,
  resolveBody2Validation,
  REQUIRED_IT_BODY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';
import { describePayloadRejection } from '../scripts/lib/llm-payload-diagnostics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.join(HERE, '..', 'scripts', 'create-article.mjs');

/**
 * Il payload VERO della run 32175400548, byte per byte come uscito dal modello.
 * Non un fac-simile: e' l'unica forma che prova che il caso di produzione e'
 * coperto, comprese le 9 chiavi di contenuto messe a `null` accanto al flag.
 */
const ABORT_RAW_PRODUZIONE = `{"abort_topical_relevance":true,"reason":"La fonte riguarda l'inaugurazione di una nuova ala ospedaliera a Coira (Grigioni), un evento di politica sanitaria locale. Non ha ricadute concrete su fiscalità, mercato del lavoro, previdenza, costo della vita, affitti o scadenze federali/cantonali che interessino un audience nazionale svizzero generico.","id":null,"category":null,"image":null,"hasCalculator":null,"imagePrompt":null,"imageAlt":null,"slugs":null,"content":null,"seo":null}`;

const FIRMA = 'async function callLLM(messages, opts = {}) {';

/** Ritaglia il corpo di una funzione per bilanciamento di graffe. */
function estraiFunzione(sorgente, firma) {
  const start = sorgente.indexOf(firma);
  assert.notEqual(
    start,
    -1,
    'Firma non trovata in create-article.mjs: ' + firma + '\n' +
      "Se callLLM() e' stata rinominata o ri-firmata, questo test va aggiornato " +
      "INSIEME: senza il ritaglio non osserva piu' niente.",
  );
  let depth = 0;
  for (let i = start + firma.length - 1; i < sorgente.length; i++) {
    if (sorgente[i] === '{') depth++;
    else if (sorgente[i] === '}') {
      depth--;
      if (depth === 0) return sorgente.slice(start, i + 1);
    }
  }
  assert.fail('Graffe sbilanciate ritagliando callLLM() da create-article.mjs.');
}

const SORGENTE = readFileSync(CREATE_ARTICLE, 'utf8');
const CALL_LLM_SRC = estraiFunzione(SORGENTE, FIRMA);

/**
 * Toglie commenti e letterali di stringa, lasciando la sola struttura.
 *
 * Serve alla guardia d'ordine in fondo al file, e non e' pedanteria: la prima
 * stesura leggeva gli indici sul sorgente grezzo e trovava
 * `recordModelContentFailure()` DENTRO il commento che spiega perche' quella
 * chiamata non deve avvenire sul ramo di abort. Una guardia che si fa ingannare
 * dalla prosa che documenta l'invariante misura il testo, non il codice — ed e'
 * il modo esatto in cui un gate diventa rumore.
 *
 * Le stringhe cadono insieme ai commenti per la stessa ragione: un messaggio
 * d'errore puo' nominare qualunque simbolo.
 */
function soloCodice(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const due = src.slice(i, i + 2);
    if (due === '//') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (due === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      out += '§';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const CALL_LLM_CODICE = soloCodice(CALL_LLM_SRC);

/**
 * Istanzia il `callLLM()` VERO con le sue dipendenze libere iniettate.
 * L'unico stub e' il trasporto: tutto cio' che DECIDE (repair, verdetto,
 * ciclo di retry, punteggio) e' il codice di produzione.
 */
function costruisciCallLLM({ risposte, wallBudgetExceeded = () => false }) {
  const chiamate = [];
  const punteggi = { failure: [], success: [] };

  const _aiCallLLM = async (messages, opts) => {
    chiamate.push({ messages, opts });
    if (opts && opts.modelUsedRef) opts.modelUsedRef.model = 'claude-cli/haiku';
    const i = Math.min(chiamate.length - 1, risposte.length - 1);
    return risposte[i];
  };

  const deps = {
    _aiCallLLM,
    AI_MODELS: { LOCAL_FALLBACK: 'local/fallback' },
    REQUIRED_IT_BODY_FIELDS,
    RUN_START_MS: Date.now(),
    RUN_WALL_BUDGET_MS: 60 * 60 * 1000,
    repairLlmJson,
    classifyBody2Payload,
    // #485: `callLLM` non deduce piu' i campi attesi annusando il prompt — la
    // regola vive in `resolveBody2Validation`, che il ritaglio legge dalla
    // chiusura come tutto il resto.
    resolveBody2Validation,
    describePayloadRejection,
    describeJsonParseError,
    describeRawForDiagnostics,
    recordModelContentFailure: (m) => punteggi.failure.push(m),
    recordModelContentSuccess: (m) => punteggi.success.push(m),
    wallBudgetExceeded,
    isNonItalianScript: () => false,
    nonItalianScriptRatio: () => 0,
    RUN_REPORT: {},
  };

  const factory = new Function(
    'deps',
    'const { ' + Object.keys(deps).join(', ') + ' } = deps;\n' +
      'let _localFallbackUsedThisHeadline = false;\n' +
      CALL_LLM_SRC + '\n' +
      'return callLLM;',
  );

  return { callLLM: factory(deps), chiamate, punteggi };
}

/** Messaggi che accendono `isBody2Check` (nominano TUTTI i campi richiesti). */
const MSGS_GENERAZIONE_IT = [
  {
    role: 'user',
    content:
      'Genera content.it (title, excerpt, body1, body2, body3, faq) per un articolo. ' +
      'Se la fonte non ha un vero aggancio frontaliere, rifiuta con "abort_topical_relevance": true.',
  },
];

/** Un payload di articolo pieno e valido, per il ramo di controllo. */
function payloadPieno(extra = {}) {
  const corpo = 'Il nuovo accordo sui frontalieri cambia le regole di imposizione. '.repeat(3);
  return JSON.stringify({
    ...extra,
    content: {
      it: {
        title: 'Frontalieri, cosa cambia con il nuovo accordo',
        excerpt: 'Le regole di imposizione cambiano per chi lavora in Ticino.',
        body1: corpo,
        body2: corpo,
        body3: corpo,
      },
    },
  });
}

/** Silenzia la diagnostica di callLLM() senza perderne il contenuto. */
async function senzaRumore(fn) {
  const vero = console.error;
  const righe = [];
  console.error = (...a) => righe.push(a.join(' '));
  try {
    const esito = await fn();
    return { esito, righe };
  } finally {
    console.error = vero;
  }
}

describe('REGOLA #0: un abort dichiarato costa UNA chiamata', () => {
  it('il payload VERO della run 32175400548 risale al chiamante senza rigenerazioni', async () => {
    const { callLLM, chiamate, punteggi } = costruisciCallLLM({
      risposte: [ABORT_RAW_PRODUZIONE],
    });

    const { esito, righe } = await senzaRumore(() =>
      callLLM(MSGS_GENERAZIONE_IT, { jsonMode: true }),
    );

    // 1. UNA chiamata al modello. Prima della fix erano 5 — il difetto in un numero.
    assert.equal(
      chiamate.length,
      1,
      'Un abort di REGOLA #0 ha speso ' + chiamate.length + ' chiamate al modello invece di 1. ' +
        "E' il difetto della run 32175400548: il ciclo isBody2Check legge il `null` del " +
        'normalizzatore come «JSON malformato» e rigenera fino a 5 volte sul modello a pagamento.',
    );

    // 2. La stringa grezza risale INTATTA: il ramo abort del chiamante la riconosce.
    assert.equal(
      esito,
      ABORT_RAW_PRODUZIONE,
      "callLLM() deve restituire il raw dell'abort com'e': e' il ramo " +
        '«REGOLA #0 abort gate» del chiamante a classificarlo, contarlo in ' +
        'RUN_REPORT.topicGateAborts e alzare err.topicGateAbort. Un throw qui ' +
        "spezzerebbe l'esito dichiarato in due posti.",
    );

    // 3. Nessuna penalizzazione del modello: ha obbedito al contratto.
    assert.deepEqual(
      punteggi.failure,
      [],
      "Un abort conforme non e' un fallimento di contenuto. Penalizzarlo degrada in " +
        'Firestore (ai_model_scores) il primo del roster per aver fatto la cosa giusta.',
    );

    // 4. …e nemmeno un premio: il rifiuto e' la risposta piu' economica possibile.
    assert.deepEqual(
      punteggi.success,
      [],
      "Un abort non e' contenuto prodotto: premiarlo pagherebbe un modello per non scrivere mai.",
    );

    // 5. L'esito e' DICHIARATO, non silenzioso.
    assert.ok(
      righe.some((r) => r.includes('[topic-gate]')),
      "callLLM() deve dichiarare l'abort sul log. Righe viste:\n" + righe.join('\n'),
    );
    assert.ok(
      !righe.some((r) => r.includes('rigenero')),
      "Nessuna riga «rigenero» e' ammessa su un abort. Righe viste:\n" + righe.join('\n'),
    );
  });

  it('il ciclo di rigenerazione resta VIVO su un payload davvero rotto', async () => {
    // Non-vacuita': se la scorciatoia dell'abort avesse disattivato il ciclo,
    // questo test passerebbe con 1 chiamata invece di 5 e il contenuto malformato
    // finirebbe pubblicato.
    const rotto = '{"content":{"it":{"title":"solo il titolo"}}}';
    const { callLLM, chiamate, punteggi } = costruisciCallLLM({ risposte: [rotto] });

    await senzaRumore(async () => {
      await assert.rejects(
        () => callLLM(MSGS_GENERAZIONE_IT, { jsonMode: true }),
        (err) => err.qualityReject === true,
      );
    });

    assert.equal(chiamate.length, 5, 'Un payload incompleto deve ancora esaurire i 5 tentativi.');
    assert.equal(
      punteggi.failure.length,
      5,
      'E un fallimento di contenuto vero va ancora penalizzato a ogni giro.',
    );
  });

  it('un payload valido passa in una chiamata e viene premiato', async () => {
    const { callLLM, chiamate, punteggi } = costruisciCallLLM({ risposte: [payloadPieno()] });
    await senzaRumore(() => callLLM(MSGS_GENERAZIONE_IT, { jsonMode: true }));
    assert.equal(chiamate.length, 1);
    assert.deepEqual(punteggi.success, ['claude-cli/haiku']);
    assert.deepEqual(punteggi.failure, []);
  });

  it("flag di abort MA contenuto pieno non e' un abort: decide il chiamante", async () => {
    // Guardia di auto-contraddizione del 2026-07-06 (osservata su qwen2.5:14b):
    // fidarsi del flag quando il contenuto c'e' buttava via un articolo valido
    // e in tema. La scorciatoia non deve riaprire quella porta.
    const { callLLM, chiamate } = costruisciCallLLM({
      risposte: [payloadPieno({ abort_topical_relevance: true, reason: 'incoerente' })],
    });
    const { esito, righe } = await senzaRumore(() =>
      callLLM(MSGS_GENERAZIONE_IT, { jsonMode: true }),
    );
    assert.equal(chiamate.length, 1);
    assert.ok(
      esito.includes('"body2"'),
      'Il contenuto deve risalire al chiamante, non essere scartato.',
    );
    assert.ok(
      !righe.some((r) => r.includes('[topic-gate] abort dichiarato')),
      "Con il contenuto pieno callLLM() non deve dichiarare l'abort: quella decisione " +
        'appartiene alla guardia di auto-contraddizione del chiamante.',
    );
  });
});

describe("REGOLA #0: la regola sta nel modulo, e il modulo e' cablato", () => {
  it("il verdetto sul payload di produzione e' topic-gate-abort, non un rigetto", () => {
    const parsed = JSON.parse(repairLlmJson(ABORT_RAW_PRODUZIONE));

    // Il normalizzatore torna null — ed e' corretto: il contenuto E' null.
    // E' leggere quel null come «malformato» a essere sbagliato.
    assert.equal(normalizeItalianContentFromPayload(parsed), null);

    const { verdict, missing } = classifyBody2Payload({ parsed, parseErr: null });
    assert.equal(verdict, 'topic-gate-abort');
    assert.deepEqual(missing, [], "Su un abort non manca niente: e' una risposta completa.");
  });

  it('un JSON illeggibile resta un rigetto anche se nomina il flag', () => {
    const troncato = '{"abort_topical_relevance":true,"reason":"la fonte non ha agg';
    let parsed;
    let parseErr = null;
    try {
      parsed = JSON.parse(repairLlmJson(troncato));
    } catch (e) {
      parseErr = e;
    }
    const { verdict } = classifyBody2Payload({ parsed, parseErr });
    assert.equal(
      verdict,
      'reject',
      "Un payload troncato a meta' non e' un abort dichiarato: e' un output tagliato, " +
        "e la sua leva e' il tetto di uscita, non il gate topico.",
    );
  });

  it("il flag va letto STRETTO: solo `true` booleano dichiara l'abort", () => {
    for (const valore of ['true', 1, 'false', 0, null]) {
      const { verdict } = classifyBody2Payload({
        parsed: { abort_topical_relevance: valore, content: null },
        parseErr: null,
      });
      assert.equal(
        verdict,
        'reject',
        'abort_topical_relevance=' + JSON.stringify(valore) + ' non deve valere come abort: ' +
          'lo schema lo modella come [boolean, null], e un falso positivo qui butta un ' +
          'articolo valido SENZA rigenerarlo — il danno peggiore dei due.',
      );
    }
  });

  it('la stringa letterale "null" sui campi di content non vale come contenuto (#512)', () => {
    // Un modello che serializza male il `null` dell'abort come TESTO "null"
    // invece che come valore JSON null non ha scritto un articolo: se
    // `normalizeItalianContentFromPayload` la trattasse come contenuto, un
    // vero abort di REGOLA #0 uscirebbe pubblicato con corpo/titolo "null".
    const abortConNullTestuale = {
      abort_topical_relevance: true,
      reason: 'fonte senza aggancio frontaliere',
      content: {
        it: {
          title: 'null',
          excerpt: 'null',
          body1: 'NULL',
          body2: ' null ',
          body3: 'null',
        },
      },
    };

    assert.equal(
      normalizeItalianContentFromPayload(abortConNullTestuale),
      null,
      'La stringa "null" (in ogni maiuscola/spaziatura) deve essere trattata come campo assente.',
    );

    const { verdict, missing } = classifyBody2Payload({ parsed: abortConNullTestuale, parseErr: null });
    assert.equal(
      verdict,
      'topic-gate-abort',
      'Un abort con content.* letteralmente "null" deve restare un abort, non un articolo ' +
        'con corpo testuale "null".',
    );
    assert.deepEqual(missing, []);
  });

  it('la stringa quoted "null" sui campi di content non vale come contenuto (#554)', () => {
    // Follow-up di #543/#512: LITERAL_NULL_STRING_RE=/^null$/i non matcha il
    // valore JS `"null"` (virgolette *dentro* la stringa) che resta dopo un
    // JSON doppio-serializzato. Lo strip di UNA coppia wrapping vive nel
    // modulo spedito: il test lo chiama, non lo ricopia.
    const quotedNull = '"null"';
    const abortConNullQuoted = {
      abort_topical_relevance: true,
      reason: 'fonte senza aggancio frontaliere',
      content: {
        it: {
          title: quotedNull,
          excerpt: quotedNull,
          body1: "'null'",
          body2: ' "NULL" ',
          body3: quotedNull,
        },
      },
    };

    const normalizzato = normalizeItalianContentFromPayload(abortConNullQuoted);
    assert.equal(
      normalizzato,
      null,
      'Dopo trim+strip di una coppia wrapping, "null"/\'null\' deve essere campo assente. ' +
        'Valori restanti: ' + JSON.stringify(normalizzato),
    );
    const campiPieni = normalizzato ? Object.values(normalizzato).filter(Boolean).length : 0;
    assert.equal(campiPieni, 0);

    const { verdict, missing } = classifyBody2Payload({ parsed: abortConNullQuoted, parseErr: null });
    assert.equal(
      verdict,
      'topic-gate-abort',
      'Un abort con content.* letteralmente "\\"null\\"" deve restare un abort, non un articolo ' +
        'il cui corpo e\' la stringa quoted "null".',
    );
    assert.deepEqual(missing, []);
  });

  it('testo reale tra virgolette non viene svuotato dallo strip wrapping (#554)', () => {
    const titoloQuoted = '"Frontalieri, cosa cambia con il nuovo accordo"';
    const corpo = 'Il nuovo accordo sui frontalieri cambia le regole di imposizione. '.repeat(3);
    const parsed = {
      content: {
        it: {
          title: titoloQuoted,
          excerpt: 'Le regole di imposizione cambiano per chi lavora in Ticino.',
          body1: corpo,
          body2: corpo,
          body3: corpo,
        },
      },
    };

    const n = normalizeItalianContentFromPayload(parsed);
    assert.ok(n, 'Un titolo realmente quoted non deve far cadere il blocco a null.');
    assert.equal(
      n.title,
      titoloQuoted,
      'Lo strip wrapping e\' solo per il filtro null: il titolo reale resta intatto.',
    );
    const { verdict } = classifyBody2Payload({ parsed, parseErr: null });
    assert.equal(verdict, 'ok');
  });

  it('un campo di content davvero uguale a "null" resta rigettato quando NON e\' un abort', () => {
    // Non-vacuita': senza il flag di abort, un payload con SOLO testo "null" sui
    // campi non deve travestirsi da contenuto valido — deve finire in reject
    // come qualunque altro payload senza contenuto reale.
    const { verdict, missing } = classifyBody2Payload({
      parsed: {
        content: {
          it: {
            title: 'null',
            excerpt: 'null',
            body1: 'null',
            body2: 'null',
            body3: 'null',
          },
        },
      },
      parseErr: null,
    });
    assert.equal(verdict, 'reject');
    assert.deepEqual(missing, ['content.it non normalizzabile']);
  });

  it('callLLM() consulta il modulo ed esce PRIMA del ramo di rigenerazione', () => {
    // Un classificatore corretto che nessuno chiama e' lo stesso difetto con un
    // file in piu'. Qui si pinna l'ORDINE, che e' l'invariante: l'uscita per
    // abort deve precedere il ramo `missing.length > 0` e ogni penalizzazione.
    const iVerdetto = CALL_LLM_CODICE.indexOf('classifyBody2Payload({');
    const iAbort = CALL_LLM_CODICE.indexOf('verdict === §');
    const iRigenera = CALL_LLM_CODICE.indexOf('missing.length > 0');
    const iPenalita = CALL_LLM_CODICE.indexOf('recordModelContentFailure(');

    assert.notEqual(
      iVerdetto,
      -1,
      "callLLM() non chiama piu' classifyBody2Payload(): il modulo e' scollegato, e un " +
        'classificatore che nessuno chiama non protegge niente.',
    );
    assert.notEqual(iAbort, -1, "callLLM() non ha piu' l'uscita per topic-gate-abort.");
    assert.ok(
      iAbort < iRigenera,
      "L'uscita per abort deve stare PRIMA del ramo `missing.length > 0`. " +
        "L'ordine opposto e' esattamente il difetto misurato sulla run 32175400548.",
    );
    assert.ok(
      iAbort < iPenalita,
      "L'uscita per abort deve precedere recordModelContentFailure(): altrimenti un " +
        'modello che obbedisce al contratto viene degradato nel ledger dei punteggi.',
    );
  });
});
