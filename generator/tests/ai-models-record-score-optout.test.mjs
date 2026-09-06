/**
 * ── UN PING DIAGNOSTICO NON DEVE SCRIVERE NEL LEDGER DI PRODUZIONE (#630) ───
 *
 * `ai_model_scores/_all` (Firestore, progetto `frontaliere-ticino`) e' UN solo
 * documento, scritto da OGNI workflow dei due repo e letto da
 * `sortChainByScore()` per decidere quale modello viene provato per primo in
 * produzione (vedi score-ledger-persistence.test.mjs, che copre la persistenza
 * di quel documento). Un chiamante puramente diagnostico — il gemello del sito
 * ha gia' `smoke-test-ai-models.mjs`, che pinga ogni modello di DEFAULT_CHAIN
 * una volta al giorno solo per verificarne la disponibilita' — ci scriverebbe
 * esiti che non descrivono nessun uso reale: un ping fallito abbassa il
 * punteggio di un modello sano e ne riordina la cascata VERA.
 *
 * `callLLM(messages, { recordScore: false })` e' l'opt-out. Questo file misura
 * cio' che il flag promette, non la sua presenza:
 *
 *   1. con `recordScore: false` una cascata interamente fallita lascia
 *      `_dirtyModels` VUOTO — cioe' non c'e' niente da persistere, che e' la
 *      forma osservabile di «il ledger non e' stato toccato»; e lascia
 *      `_modelScores` invariato, cioe' nemmeno l'ordinamento in memoria di
 *      questo processo e' stato inquinato. Il MARCHIO di esaurimento invece
 *      RESTA (#846): spegnerlo faceva ripagare a ogni passata l'errore di un
 *      modello gia' fuori quota, ed era la divisione opposta a quella della
 *      discovery. Il confine fra le due meta' e' misurato qui — `dirtyModels`,
 *      `scoreBoard` e `activeCooldowns` restano esattamente quelli di prima;
 *   2. il default (flag assente) continua a scrivere: e' il confine che rende
 *      il test una misura e non una tautologia — senza questo caso, un
 *      `recordScore` che spegnesse TUTTO passerebbe il punto 1 comunque;
 *   3. il ramo host-irraggiungibile di #475 e' coperto quanto gli altri.
 *      Esiste solo in questo repo (il gemello del sito non ce l'ha: e' una
 *      delle ragioni per cui la voce e' `adapted` nel manifest dal 2026-09-04,
 *      issue #806), quindi la discesa 1:1 del flag dal sito lo lasciava scoperto:
 *      `markModelExhausted` scrive `_dirtyModels` come `recordModelFailure`.
 *      Il cooldown del provider, che invece e' in-processo, resta attivo — la
 *      meta' di #475 che risparmia un connect morto per id fratello serve
 *      esattamente al chiamante diagnostico, che la catena la percorre tutta.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  callLLM,
  coerceRecordScore,
  discoverFreeModels,
  getStats,
  recordModelContentFailure,
  recordModelContentSuccess,
  recordModelSuccess,
  resetState,
  DEFAULT_CHAIN,
  DISCOVERY_OPTOUT_IGNORED_WARNING,
  DISCOVERY_OPTOUT_PRUNE_WARNING,
  RECORD_SCORE_COERCION_WARNING,
  _discoverProvider,
} from '../scripts/lib/ai-models.mjs';

/**
 * Il segnale si riconosce dal TESTO che il modulo emette, non da tre parole
 * generiche (#941). `/opt-out|recordScore|diagnost/i` contava anche il warning
 * di `coerceRecordScore()` — quello che scatta per ogni valore stringa non
 * ancora visto, cioe' per la forma con cui un flag arriva da `process.env` —
 * quindi il conteggio «un segnale e uno solo» diventava 2 senza che il segnale
 * fosse stato emesso due volte. Le costanti sono le stesse che costruiscono il
 * messaggio: una sorgente sola, e il predicato non puo' scollarsi dal testo.
 */
const isPruneSignal = (w) => w.includes(DISCOVERY_OPTOUT_PRUNE_WARNING);
const isIgnoredSignal = (w) => w.includes(DISCOVERY_OPTOUT_IGNORED_WARNING);
const isCoercionWarning = (w) => w.includes(RECORD_SCORE_COERCION_WARNING);

// La forma REALE che undici produce per un host che non accetta connessioni:
// il codice syscall vive due livelli sotto (vedi ai-models-host-unreachable).
function undiciFetchFailed(code) {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`${code} models.inference.ai.azure.com:443`), { code }),
  });
}

// Un 429 col corpo che `isDailyLimitError` riconosce come limite giornaliero:
// e' il percorso ledger piu' battuto in produzione (markModelExhausted +
// recordModelFailure), e non passa dal ramo di #475.
function dailyLimitResponse() {
  return {
    ok: false,
    status: 429,
    headers: new Map(),
    text: async () => JSON.stringify({ error: { message: 'You exceeded your current quota, daily limit reached' } }),
    json: async () => ({ error: { message: 'daily limit reached' } }),
  };
}

const ENV_KEYS = ['AI_MODELS_FORCE_CHAIN', 'GH_MODELS_PAT', 'AI_MODELS_PREFER'];
const CALL_OPTS = { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 };

describe('callLLM({ recordScore: false }) — opt-out dal ledger di produzione', () => {
  let envBackup = {};
  let realFetch;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    // Due id GitHub serviti dallo stesso host: il secondo e' il FRATELLO, ed e'
    // cio' che rende osservabile il cooldown del punto 3.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini';
    realFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  it('un limite giornaliero non lascia NIENTE da persistere', async () => {
    globalThis.fetch = async () => dailyLimitResponse();

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], { ...CALL_OPTS, recordScore: false }));

    const stats = getStats();
    assert.equal(
      stats.dirtyModels,
      0,
      `un ping diagnostico ha sporcato ${stats.dirtyModels} modelli: al prossimo flush finiscono in ai_model_scores/_all, che ordina la produzione`,
    );
    assert.deepEqual(
      stats.scoreBoard,
      [],
      `nessun punteggio doveva muoversi, visti: ${JSON.stringify(stats.scoreBoard)}`,
    );
    // ...ma il MARCHIO in-processo resta, e deve (#846). L'opt-out spegne il
    // ledger, non il circuit breaker: un modello a quota esaurita che non entra
    // in `_exhaustedModels` viene ritentato a ogni giro della cascata, e il
    // chiamante diagnostico e' proprio quello che la percorre tutta — pagava
    // quindi lo stesso 429 a ogni passata. Il ban muore col processo e non
    // raggiunge nessun documento condiviso: e' `dirtyModels === 0` qui sopra a
    // misurarlo. Stessa divisione del ramo markStale della discovery.
    assert.deepEqual(
      [...stats.exhaustedModels].sort(),
      ['gpt-4.1-mini', 'gpt-4o-mini'],
      `il ban di run deve valere anche in opt-out, visti: ${stats.exhaustedModels.join(', ')}`,
    );
  });

  it('senza il flag lo stesso fallimento SCRIVE — e\' il confine che rende la misura vera', async () => {
    globalThis.fetch = async () => dailyLimitResponse();

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], CALL_OPTS));

    const stats = getStats();
    assert.ok(
      stats.dirtyModels > 0,
      "il default deve continuare a scrivere: un recordScore che spegne il ledger per tutti non e' un opt-out, e' una regressione silenziosa della produzione",
    );
    assert.ok(
      stats.scoreBoard.length > 0,
      'il default deve continuare a muovere i punteggi in memoria',
    );
  });

  it('copre anche il ramo host-irraggiungibile di #475, che il gemello del sito non ha', async () => {
    globalThis.fetch = async () => { throw undiciFetchFailed('ENOTFOUND'); };

    // `maxRetriesPerModel: 3` e non 1: il tag `e.hostUnreachable` viene apposto
    // DOPO il `throw` di ultimo tentativo dentro _callOpenAICompatible, quindi
    // con un solo tentativo consentito il ramo di #475 non e' raggiungibile e il
    // test misurerebbe il ramo generico credendo di misurare questo.
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], { ...CALL_OPTS, maxRetriesPerModel: 3, recordScore: false }));

    const stats = getStats();
    // markModelExhausted() fa `_dirtyModels.add(modelId)` come recordModelFailure:
    // e' una scrittura al ledger a tutti gli effetti, e su questo ramo era
    // l'unica rimasta scoperta dopo la discesa 1:1 del flag dal sito.
    assert.equal(
      stats.dirtyModels,
      0,
      `un host morto ha sporcato ${stats.dirtyModels} modelli in un ping diagnostico`,
    );
    // Il ban di run resta anche qui (#846) — e' `dirtyModels === 0` a dire che
    // niente ha raggiunto il ledger. Un solo id: il fratello non viene mai
    // provato, perche' il cooldown del provider qui sotto lo salta prima.
    assert.deepEqual(
      stats.exhaustedModels,
      ['gpt-4o-mini'],
      `il ban di run deve valere anche in opt-out, visti: ${stats.exhaustedModels.join(', ')}`,
    );
    // ...ma il cooldown in-processo resta: e' la meta' di #475 che evita un
    // connect morto per ogni id fratello, e muore col processo senza toccare
    // Firestore. Un diagnostico che percorre l'intera catena e' proprio chi ne
    // beneficia di piu'.
    assert.ok(
      stats.activeCooldowns.github > 0,
      `il cooldown del provider non e' un dato di ledger e deve restare attivo, visti: ${JSON.stringify(stats.activeCooldowns)}`,
    );
  });
});


/**
 * ── #783.1 — L'OPT-OUT E' UN FLAG, NON IL BOOLEANO `false` ─────────────────
 *
 * Il gate storico era `recordScore !== false`: sotto quella forma SOLO il
 * booleano `false` e' un opt-out, mentre `0`, `null`, `''` e la stringa
 * `'false'` passano e scrivono `ai_model_scores/_all`. `'false'` e' la forma
 * tipica di un valore che arriva da `process.env`, e il chiamante piu' esposto
 * e' proprio quello diagnostico. Il fallimento e' silenzioso: nessun errore,
 * solo punteggi di produzione che si muovono per dei ping.
 *
 * Il caso `recordScore: true` in coda e' il confine: senza, un coercitore che
 * restituisse sempre `false` passerebbe tutti gli altri.
 */
describe('#783 — valori falsy non-false sono opt-out veri', () => {
  let envBackup = {};
  let realFetch;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini';
    realFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  for (const value of ['false', 'FALSE', ' false ', '0', 'no', 'off', '', 0, null]) {
    it(`recordScore: ${JSON.stringify(value)} non tocca il ledger`, async () => {
      globalThis.fetch = async () => dailyLimitResponse();

      await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], { ...CALL_OPTS, recordScore: value }));

      const stats = getStats();
      assert.equal(
        stats.dirtyModels,
        0,
        `recordScore=${JSON.stringify(value)} ha sporcato ${stats.dirtyModels} modelli: il chiamante credeva di essere in opt-out`,
      );
      assert.deepEqual(stats.scoreBoard, [], `nessun punteggio doveva muoversi con recordScore=${JSON.stringify(value)}`);
      // Il ban di run resta: l'opt-out e' sul ledger, non sul breaker (#846).
      assert.deepEqual(
        [...stats.exhaustedModels].sort(),
        ['gpt-4.1-mini', 'gpt-4o-mini'],
        `il ban di run doveva valere anche con recordScore=${JSON.stringify(value)}, visti: ${stats.exhaustedModels.join(', ')}`,
      );
    });
  }

  for (const value of [true, 'true', '1', 'yes', undefined]) {
    it(`recordScore: ${JSON.stringify(value)} continua a scrivere`, async () => {
      globalThis.fetch = async () => dailyLimitResponse();

      const opts = { ...CALL_OPTS };
      if (value !== undefined) opts.recordScore = value;
      await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], opts));

      assert.ok(
        getStats().dirtyModels > 0,
        `recordScore=${JSON.stringify(value)} non e' un opt-out: spegnere il ledger qui sarebbe una regressione silenziosa della produzione`,
      );
    });
  }

  it('coerceRecordScore normalizza a booleano, senza mai lanciare', () => {
    for (const falsy of [false, 'false', 'FALSE', ' off ', '0', '', 0, null, NaN]) {
      assert.equal(coerceRecordScore(falsy), false, `${JSON.stringify(falsy)} doveva valere false`);
    }
    for (const truthy of [true, 'true', '1', 'sì', 1, {}]) {
      assert.equal(coerceRecordScore(truthy), true, `${JSON.stringify(truthy)} doveva valere true`);
    }
    // Il flag assente e' il default di DEFAULT_OPTS, non un opt-out.
    assert.equal(coerceRecordScore(undefined), true);
  });
});

/**
 * ── #783.2 — LA DISCOVERY SCRIVEVA IL LEDGER FUORI DAL GATE ────────────────
 *
 * Il ramo `markStale` di `_discoverProvider` chiama `markModelExhausted`, che
 * fa `_dirtyModels.add()` + `_schedulePersist()` come qualsiasi fallimento di
 * cascata. Stava fuori dall'opt-out perche' la discovery e' per processo mentre
 * il flag e' per chiamata: un chiamante diagnostico che facesse discovery prima
 * di pingare la catena sporcava comunque il documento condiviso.
 *
 * Il prune della catena invece deve restare in ogni caso — e' in memoria, muore
 * col processo, e non ha niente a che vedere col ledger.
 */
describe('#783 — discovery: opt-out dal ledger, prune invariato', () => {
  const PREFIX = 'openrouter/';
  const DEAD = `${PREFIX}zz-decommissioned-783:free`;
  let chainBackup;
  let realFetch;
  let keyBackup;

  const cfg = {
    name: 'TestProv',
    prefix: PREFIX,
    getKey: () => 'test-key',
    url: 'https://example.invalid/models',
    markStale: true,
    pick: (m) => m?.id || null,
  };

  beforeEach(() => {
    keyBackup = process.env.OPENROUTER_API_KEY;
    chainBackup = [...DEFAULT_CHAIN];
    DEFAULT_CHAIN.push(DEAD);
    realFetch = globalThis.fetch;
    // Il listing offre un solo id, e non e' quello morto: `offeredIds.size > 0`
    // supera la guardia anti-glitch, quindi il ramo markStale scatta davvero.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'zz-alive-783:free' }] }),
    });
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (keyBackup === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = keyBackup;
    DEFAULT_CHAIN.length = 0;
    DEFAULT_CHAIN.push(...chainBackup);
    resetState();
  });

  it('con recordScore: false non lascia niente da persistere', async () => {
    const { stale } = await _discoverProvider(cfg, { recordScore: false });

    assert.ok(stale > 0, 'il ramo markStale non e\' scattato: il test misurerebbe il nulla');
    assert.equal(
      getStats().dirtyModels,
      0,
      `la discovery ha sporcato ${getStats().dirtyModels} modelli pur essendo in opt-out`,
    );
    // ...ma il modello morto e' comunque saltato per il resto della run e
    // rimosso dalla catena: entrambe le meta' sono in memoria.
    assert.ok(getStats().exhaustedModels.includes(DEAD), 'il marchio in-processo deve restare, o l\'id morto costa un fallback');
    assert.ok(!DEFAULT_CHAIN.includes(DEAD), 'il prune della catena non dipende dal ledger');
  });

  it('il prune in opt-out non e\' piu\' silenzioso (#844)', async () => {
    // Il prune resta — l'asserzione qui sopra e' invariata — ma smette di essere
    // invisibile: senza segnale, un processo condiviso fra diagnostica e
    // generazione consegna alla seconda una catena potata dalla prima, su un
    // listing raccolto con chiavi e timing diagnostici. Misurato prima del fix:
    // chainBefore=102 chainAfter=79 segnali=0.
    const realWarn = console.warn;
    const warnings = [];
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    let stale;
    try {
      ({ stale } = await _discoverProvider(cfg, { recordScore: false }));
    } finally {
      console.warn = realWarn;
    }

    assert.ok(stale > 0, 'il ramo markStale non e\' scattato: il test misurerebbe il nulla');
    assert.ok(!DEFAULT_CHAIN.includes(DEAD), 'il segnale non deve sostituire il prune: la catena va comunque potata');
    const segnali = warnings.filter(isPruneSignal);
    assert.equal(
      segnali.length,
      1,
      `il prune sotto recordScore falsy deve emettere un segnale e uno solo, visti ${segnali.length}: ${JSON.stringify(warnings)}`,
    );
    assert.match(
      segnali[0],
      /DEFAULT_CHAIN/,
      'il segnale deve nominare la conseguenza (la catena accorciata), non solo il flag',
    );
  });

  it('il segnale del prune in opt-out e\' una-tantum, non per provider', async () => {
    // Dodici provider che potano darebbero dodici righe identiche: il fatto da
    // segnalare e' uno solo, e ripeterlo lo trasforma in rumore.
    const realWarn = console.warn;
    const warnings = [];
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    try {
      await _discoverProvider(cfg, { recordScore: false });
      DEFAULT_CHAIN.push(`${PREFIX}zz-decommissioned-844-bis:free`);
      await _discoverProvider(cfg, { recordScore: false });
    } finally {
      console.warn = realWarn;
    }

    assert.ok(
      !DEFAULT_CHAIN.includes(`${PREFIX}zz-decommissioned-844-bis:free`),
      'la seconda discovery deve aver potato davvero, o il latch non e\' sotto misura',
    );
    assert.equal(
      warnings.filter(isPruneSignal).length,
      1,
      `il warning doveva restare uno solo: ${JSON.stringify(warnings)}`,
    );
  });

  it('la forma env-derived (`recordScore: \'false\'`) e\' un opt-out, e il segnale resta uno', async () => {
    // La forma con cui il flag arriva DAVVERO e' una stringa: `process.env.X` non
    // produce booleani, e il chiamante piu' esposto e' proprio quello diagnostico.
    // Lungo questo percorso non era mai stata esercitata — i tre casi qui sopra
    // passano booleani — quindi il predicato dei test non aveva mai incontrato il
    // warning di coercizione, che contiene anch'esso la parola `recordScore` (#941).
    const realWarn = console.warn;
    const warnings = [];
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    let stale;
    try {
      ({ stale } = await _discoverProvider(cfg, { recordScore: 'false' }));
    } finally {
      console.warn = realWarn;
    }

    assert.ok(stale > 0, 'il ramo markStale non e\' scattato: il test misurerebbe il nulla');
    assert.equal(
      getStats().dirtyModels,
      0,
      'la stringa \'false\' deve essere un opt-out vero: e\' la forma in cui il flag arriva da process.env',
    );
    assert.ok(!DEFAULT_CHAIN.includes(DEAD), 'il prune della catena non dipende dal ledger');
    assert.equal(
      warnings.filter(isPruneSignal).length,
      1,
      `il segnale del prune deve restare uno solo anche con il flag in forma stringa: ${JSON.stringify(warnings)}`,
    );
    // ...e la coercizione e' una riga SUA, che il predicato non deve contare come
    // segnale: e' il difetto che #941 nomina. Con /opt-out|recordScore|diagnost/
    // questa asserzione e quella sopra erano incompatibili.
    const coercizioni = warnings.filter(isCoercionWarning);
    assert.equal(coercizioni.length, 1, `attesa una riga di coercizione: ${JSON.stringify(warnings)}`);
    assert.ok(
      !isPruneSignal(coercizioni[0]),
      'la riga di coercizione non e\' il segnale del prune: due fatti diversi, due predicati diversi',
    );
  });

  it('una stringa VERA (`\'true\'`) non e\' un opt-out: il confine della forma env-derived', async () => {
    // Il gemello del caso sopra: se la coercizione sbagliasse verso, un flag
    // diagnostico spento diventerebbe una scrittura in produzione — e viceversa
    // un `'true'` letto come falsy perderebbe punteggi senza dirlo.
    const realWarn = console.warn;
    const warnings = [];
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    let stale;
    try {
      ({ stale } = await _discoverProvider(cfg, { recordScore: 'true' }));
    } finally {
      console.warn = realWarn;
    }

    assert.ok(stale > 0, 'il ramo markStale non e\' scattato: il test misurerebbe il nulla');
    assert.ok(getStats().dirtyModels > 0, '\'true\' e\' una richiesta di registrare, non un opt-out');
    assert.deepEqual(
      warnings.filter(isPruneSignal),
      [],
      'nessun opt-out, nessun segnale di prune diagnostico',
    );
    assert.equal(
      warnings.filter(isCoercionWarning).length,
      1,
      `la stringa va comunque segnalata una volta: ${JSON.stringify(warnings)}`,
    );
  });

  it('col default la discovery continua a scrivere', async () => {
    const realWarn = console.warn;
    const warnings = [];
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    let stale;
    try {
      ({ stale } = await _discoverProvider(cfg));
    } finally {
      console.warn = realWarn;
    }

    assert.ok(stale > 0, 'il ramo markStale non e\' scattato: il test misurerebbe il nulla');
    assert.ok(
      getStats().dirtyModels > 0,
      'la produzione deve continuare a persistere gli id decommissionati: spegnere anche questo non sarebbe un opt-out',
    );
    // Il segnale di #844 descrive una catena potata da un DIAGNOSTICO: emetterlo
    // anche in produzione lo renderebbe una riga che non distingue piu' niente.
    assert.deepEqual(
      warnings.filter(isPruneSignal),
      [],
      'la discovery di produzione non deve emettere il segnale di opt-out',
    );
  });
});


/**
 * ── #843 — LA PORTA PUBBLICA DELLA DISCOVERY: RESET E SILENZIO ─────────────
 *
 * I due casi di #783.2 qui sopra chiamano `_discoverProvider` DIRETTAMENTE, e
 * cosi' schivano il latch `_discoveryDone` che sta un livello sopra, in
 * `discoverFreeModels()`. Chi passa dalla porta pubblica lo trova invece:
 *
 *   (a) `resetState()` non lo azzerava. Il reset butta via marchi, potature e
 *       punteggi — cioe' tutto cio' che la sweep precedente aveva prodotto — ma
 *       lasciava `true` il flag che dice «gia' fatta»: la discovery restava
 *       congelata per il resto del processo su un esito che non esisteva piu',
 *       e nessun chiamante successivo poteva piu' ricostruirla. Senza questo
 *       caso il test non distingue il reset dalla fortuna.
 *   (b) un secondo chiamante con un `recordScore` diverso riceve l'esito del
 *       primo: il suo flag non ha nessun effetto. L'idempotenza e' voluta, il
 *       silenzio no — `initScoreStore()` fa la discovery col default, quindi e'
 *       proprio l'auto-init a vincere di norma la corsa contro un diagnostico.
 */
describe('#843 — discoverFreeModels(): il latch di processo muore con resetState()', () => {
  const PREFIX = 'openrouter/';
  const DEAD = `${PREFIX}zz-decommissioned-843:free`;
  // Ogni chiave di discovery: azzerate tutte tranne OpenRouter, altrimenti un
  // provider con la chiave presente nell'ambiente girerebbe contro lo stub e
  // aggiungerebbe id col SUO prefisso, rendendo il conteggio non deterministico.
  const DISCOVERY_KEYS = [
    'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY',
    'NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY', 'SAMBANOVA_API_KEY', 'TOGETHER_API_KEY',
    'FIREWORKS_API_KEY', 'COHERE_API_KEY', 'CHUTES_API_KEY', 'HUGGINGFACE_API_KEY',
    'ZAI_API_KEY', 'ZHIPU_API_KEY', 'CF_ACCOUNT_ID', 'CF_API_TOKEN',
  ];
  let chainBackup;
  let realFetch;
  let realWarn;
  let keyBackup = {};
  let warnings = [];

  beforeEach(() => {
    keyBackup = Object.fromEntries(DISCOVERY_KEYS.map((k) => [k, process.env[k]]));
    for (const k of DISCOVERY_KEYS) delete process.env[k];
    process.env.OPENROUTER_API_KEY = 'test-key';
    chainBackup = [...DEFAULT_CHAIN];
    realFetch = globalThis.fetch;
    // Un solo id offerto, diverso da quello morto: `offeredIds.size > 0` supera
    // la guardia anti-glitch, quindi il ramo markStale scatta davvero.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      // `context_length` esplicito: il `pick` di OpenRouter impone il floor
      // MIN_DISCOVERY_CONTEXT_TOKENS, e un id senza contesto verrebbe scartato
      // → `offeredIds.size === 0` → la guardia anti-glitch spegne markStale.
      json: async () => ({ data: [{ id: 'zz-alive-843:free', context_length: 200_000 }] }),
    });
    realWarn = console.warn;
    warnings = [];
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    resetState();
  });

  afterEach(() => {
    console.warn = realWarn;
    globalThis.fetch = realFetch;
    for (const k of DISCOVERY_KEYS) {
      if (keyBackup[k] === undefined) delete process.env[k];
      else process.env[k] = keyBackup[k];
    }
    DEFAULT_CHAIN.length = 0;
    DEFAULT_CHAIN.push(...chainBackup);
    resetState();
  });

  it('dopo resetState() la discovery si rifa\', e il recordScore del nuovo chiamante vale', async () => {
    DEFAULT_CHAIN.push(DEAD);
    await discoverFreeModels();
    assert.ok(
      getStats().dirtyModels > 0,
      'la prima discovery col default doveva scrivere: senza, il caso non misura il reset ma il nulla',
    );

    resetState();
    assert.equal(getStats().dirtyModels, 0, 'resetState() deve aver ripulito il ledger in sospeso');

    // La sweep precedente ha potato l'id morto dalla catena; il reset butta via
    // il suo marchio ma non lo rimette in catena. Lo rimettiamo noi: e' cio' che
    // la seconda discovery deve tornare a vedere se sta davvero rigirando.
    DEFAULT_CHAIN.push(DEAD);
    await discoverFreeModels({ recordScore: false });

    assert.ok(
      getStats().exhaustedModels.includes(DEAD),
      "la seconda discovery non e' stata eseguita: il latch _discoveryDone e' sopravvissuto a resetState(), quindi l'esito del primo chiamante e' congelato per tutto il processo",
    );
    assert.ok(!DEFAULT_CHAIN.includes(DEAD), 'il prune della catena deve valere anche nella sweep post-reset');
    assert.equal(
      getStats().dirtyModels,
      0,
      `il recordScore:false del secondo chiamante non ha avuto effetto: ha sporcato ${getStats().dirtyModels} modelli`,
    );
  });

  it('senza reset, un flag diverso e\' un no-op — ma nominato', async () => {
    DEFAULT_CHAIN.push(DEAD);
    await discoverFreeModels();
    const dirtyAfterFirst = getStats().dirtyModels;
    assert.ok(dirtyAfterFirst > 0, 'la prima discovery col default doveva scrivere');

    warnings = [];
    DEFAULT_CHAIN.push(DEAD);
    await discoverFreeModels({ recordScore: false });

    assert.ok(
      warnings.some(isIgnoredSignal),
      `un opt-out ignorato deve lasciare un segnale, warning visti: ${JSON.stringify(warnings)}`,
    );
    // L'idempotenza resta: la seconda chiamata non rifa' il giro, quindi non
    // scrive nulla di nuovo e non ripota la catena.
    assert.equal(getStats().dirtyModels, dirtyAfterFirst, 'la seconda chiamata non deve rieseguire la discovery');
    assert.ok(DEFAULT_CHAIN.includes(DEAD), 'nessuna seconda sweep: l\'id rimesso in catena resta li\'');
  });

  it('stesso flag, nessun warning: il confine che tiene il segnale utile', async () => {
    await discoverFreeModels({ recordScore: false });
    warnings = [];
    await discoverFreeModels({ recordScore: 'false' });

    assert.deepEqual(
      warnings.filter(isIgnoredSignal),
      [],
      `stessa modalita' (\'false\' e false coincidono dopo coerceRecordScore): nessun warning atteso, visti: ${JSON.stringify(warnings)}`,
    );
  });
});


/**
 * ── #845 — IL WRITER DELLA VALIDAZIONE DI CONTENUTO ────────────────────────
 *
 * `recordModelContentFailure()` e' ESPORTATO e vive fuori da `callLLM`: chi lo
 * chiama sono i validatori di contenuto (`body2-payload-verdict.mjs`,
 * `itLanguageCheck.mjs` lo citano come il meccanismo con cui la generazione
 * ruota modello dopo un payload rifiutato). Il gate `recordScore` di `callLLM`
 * sta sui SUOI call site interni e non poteva quindi coprirlo: un flusso
 * diagnostico che passasse dalla validazione scriveva `ai_model_scores/_all`
 * mentre l'opt-out era attivo su ogni altra superficie — era l'ultimo writer
 * del modulo rimasto senza parametro.
 *
 * Qui si misura la promessa, non la firma:
 *   1. in opt-out, N fallimenti di contenuto (>= MAX_CONSECUTIVE_CONTENT_FAILURES)
 *      lasciano `_dirtyModels` vuoto e `scoreBoard` fermo — cioe' ne' la penale
 *      di `recordModelFailure` ne' il `markModelExhausted('content')` arrivano
 *      al documento condiviso;
 *   2. ...ma il ban di run RESTA (#846): l'opt-out spegne il ledger, non il
 *      circuit breaker;
 *   3. il default continua a scrivere — e' il confine che rende la misura vera;
 *   4. `'false'` (la forma che arriva da `process.env`) e' un opt-out vero come
 *      il booleano, perche' il valore passa da `coerceRecordScore()` (#783).
 */
describe('#845 — recordModelContentFailure({ recordScore }) non tocca il ledger in opt-out', () => {
  const MODEL = 'openai/gpt-4o-mini-content-test';

  beforeEach(() => { resetState(); });
  afterEach(() => { resetState(); });

  for (const optOut of [false, 'false', 0, null, '']) {
    it(`recordScore: ${JSON.stringify(optOut)} — niente da persistere, ma il ban di run resta`, () => {
      recordModelContentFailure(MODEL, { recordScore: optOut });
      recordModelContentFailure(MODEL, { recordScore: optOut });

      const stats = getStats();
      assert.equal(
        stats.dirtyModels,
        0,
        `la validazione di contenuto ha sporcato ${stats.dirtyModels} modelli in opt-out: al prossimo flush finiscono in ai_model_scores/_all, che ordina la produzione`,
      );
      assert.deepEqual(
        stats.scoreBoard,
        [],
        `nessun punteggio doveva muoversi, visti: ${JSON.stringify(stats.scoreBoard)}`,
      );
      assert.ok(
        stats.exhaustedModels.includes(MODEL),
        `il ban di run deve valere anche in opt-out (#846), visti: ${stats.exhaustedModels.join(', ') || 'nessuno'}`,
      );
    });
  }

  it('il default SCRIVE — confine che rende la misura vera', () => {
    recordModelContentFailure(MODEL);
    recordModelContentFailure(MODEL);

    const stats = getStats();
    assert.ok(
      stats.dirtyModels > 0,
      'il default deve continuare a proporre al ledger: un opt-out che vale per tutti e\' una regressione silenziosa della produzione',
    );
    assert.ok(
      stats.scoreBoard.some((e) => e.model === MODEL && e.score < 0),
      `il default deve continuare a penalizzare in memoria, visti: ${JSON.stringify(stats.scoreBoard)}`,
    );
    assert.ok(stats.exhaustedModels.includes(MODEL), 'il ban di contenuto vale col default');
  });

  it('un fallimento in opt-out non lascia un delta che un writer di produzione poi spedisce', () => {
    // Il delta di contatore vive in una mappa SEPARATA da `_dirtyModels`: se
    // l'opt-out lo accumulasse comunque, il primo writer di produzione sullo
    // stesso modello lo troverebbe in coda e lo scriverebbe come incremento
    // atomico. Il tally di run invece deve restare: e' memoria di processo.
    recordModelContentFailure(MODEL, { recordScore: false });
    const outcomes = getStats().runOutcomes.find((o) => o.model === MODEL);
    assert.ok(outcomes && outcomes.failures >= 1, `il tally di run resta anche in opt-out, visto: ${JSON.stringify(outcomes)}`);

    recordModelSuccess(MODEL);
    const entry = getStats().scoreBoard.find((e) => e.model === MODEL);
    assert.ok(entry, 'il writer di produzione deve comunque registrare');
    assert.equal(
      entry.failures,
      0,
      `il fallimento diagnostico e' rientrato dalla finestra nei dettagli persistiti: ${JSON.stringify(entry)}`,
    );
  });
});

/**
 * ── IL FLAG DEVE ARRIVARE DAL CALL SITE DI PRODUZIONE (#845) ────────────────
 *
 * `recordModelContentFailure()` e' esportata e ha UN solo call site di
 * produzione in tutto l'albero: `callLLM()` di `create-article.mjs`, nel ramo
 * «output JSON incompleto». Il parametro `recordScore` senza quella
 * propagazione e' irraggiungibile da qualunque percorso reale — l'opt-out
 * esisterebbe nel modulo e non nella produzione, e un chiamante diagnostico
 * scriverebbe comunque `ai_model_scores/_all`.
 *
 * Misurato sul SORGENTE perche' `create-article.mjs` non e' importabile dalle
 * gate del generatore (girano `node --test` senza `npm ci`): stessa tecnica di
 * split-merge-abort-flag.test.mjs.
 */
describe('propagazione di recordScore dal call site di produzione', () => {
  const SRC = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/create-article.mjs'),
    'utf-8',
  );

  it('create-article.mjs passa opts.recordScore a recordModelContentFailure', () => {
    const calls = [...SRC.matchAll(/recordModelContentFailure\(([^)]*)\)/g)]
      .map((m) => m[1])
      .filter((args) => !/^\s*$/.test(args));

    assert.equal(calls.length, 1, `atteso un solo call site, visti: ${JSON.stringify(calls)}`);
    assert.match(
      calls[0],
      /recordScore:\s*opts\.recordScore/,
      `il call site non propaga il flag — l'opt-out del ledger resta irraggiungibile: ${calls[0]}`,
    );
  });
});

/**
 * ── #887 — IL FLAG SI FERMA AL LEDGER, E DOVE NON ARRIVA LO DICE ───────────
 *
 * Due meta' della stessa decisione, entrambe misurate qui.
 *
 * 1. `recordModelContentSuccess()` NON prende il flag come gate. Non propone
 *    niente al ledger: cancella una voce di `_consecutiveContentFailures`, che
 *    e' stato in-processo. Gatarlo sarebbe attivamente peggio che lasciarlo
 *    fuori, perche' il gemello `recordModelContentFailure` incrementa lo streak
 *    ANCHE in opt-out (misurato sopra, #845/#846): un reset che ubbidisse al
 *    flag lascerebbe il chiamante diagnostico capace solo di spingere il
 *    breaker di contenuto VERSO il ban, mai di riportarlo a zero. L'opt-out
 *    promette neutralita', non una direzione.
 *
 * 2. Non-gatato non vuol dire silenzioso: un `recordScore` falsy ESPLICITO
 *    ottiene un warning warn-once, gemello di quello del prune di discovery
 *    (#844). Chi condivide il processo con un diagnostico non ha nessun altro
 *    modo di sapere che lo streak accumulato dalla produzione e' stato azzerato.
 *
 * E il source-guard sui call site interni di `callLLM`: dopo #846 il gate sta
 * sul PARAMETRO, mai attorno alla chiamata. Attorno alla chiamata si perde con
 * essa il TALLY DI RUN — che non e' un dato di ledger, muore col processo, ed e'
 * cio' che `printRunSummary` legge — e una run diagnostica si stampa `0ok/0ko`
 * su modelli che ha chiamato davvero.
 */
describe('#887 — recordModelContentSuccess: reset in-processo, flag fuori ma nominato', () => {
  const MODEL = 'openai/gpt-4o-mini-content-887';

  beforeEach(() => { resetState(); });
  afterEach(() => { resetState(); });

  for (const optOut of [false, 'false', 0, null, '']) {
    it(`recordScore: ${JSON.stringify(optOut)} non sopprime il reset dello streak`, () => {
      recordModelContentFailure(MODEL, { recordScore: optOut });
      recordModelContentSuccess(MODEL, { recordScore: optOut });
      // Se il reset fosse stato gatato, questo secondo fallimento sarebbe il
      // SECONDO consecutivo e farebbe scattare il ban di contenuto.
      recordModelContentFailure(MODEL, { recordScore: optOut });

      assert.ok(
        !getStats().exhaustedModels.includes(MODEL),
        'il reset dello streak deve valere anche in opt-out: gatarlo lascia il chiamante diagnostico capace solo di far salire il breaker',
      );
    });
  }

  it('due fallimenti consecutivi SENZA reset bannano — confine che rende la misura vera', () => {
    recordModelContentFailure(MODEL, { recordScore: false });
    recordModelContentFailure(MODEL, { recordScore: false });
    assert.ok(
      getStats().exhaustedModels.includes(MODEL),
      'senza reset lo streak deve arrivare al ban, altrimenti il caso sopra passerebbe per la ragione sbagliata',
    );
  });

  it('un opt-out esplicito non e\' silenzioso, ed e\' una-tantum', () => {
    const seen = [];
    const orig = console.warn;
    console.warn = (...a) => seen.push(a.join(' '));
    try {
      recordModelContentSuccess(MODEL, { recordScore: false });
      recordModelContentSuccess(MODEL, { recordScore: false });
      recordModelContentSuccess('altro/modello-887', { recordScore: false });
    } finally {
      console.warn = orig;
    }

    const hits = seen.filter((l) => l.includes('recordModelContentSuccess'));
    assert.equal(
      hits.length,
      1,
      `atteso un solo avviso per ciclo di vita dello stato, visti: ${JSON.stringify(hits)}`,
    );
    assert.match(hits[0], /recordScore:false ignorato/);
  });

  it('col default (e col flag vero) non dice niente: e\' il confine che tiene il segnale utile', () => {
    const seen = [];
    const orig = console.warn;
    console.warn = (...a) => seen.push(a.join(' '));
    try {
      recordModelContentSuccess(MODEL);
      recordModelContentSuccess(MODEL, {});
      recordModelContentSuccess(MODEL, { recordScore: true });
    } finally {
      console.warn = orig;
    }
    assert.deepEqual(
      seen.filter((l) => l.includes('recordModelContentSuccess')),
      [],
      'un warning sul percorso normale e\' rumore, e insegna a ignorare quello che conta',
    );
  });

  it('resetState() azzera il latch, come per i suoi fratelli (#843)', () => {
    const seen = [];
    const orig = console.warn;
    console.warn = (...a) => seen.push(a.join(' '));
    try {
      recordModelContentSuccess(MODEL, { recordScore: false });
      resetState();
      recordModelContentSuccess(MODEL, { recordScore: false });
    } finally {
      console.warn = orig;
    }
    assert.equal(
      seen.filter((l) => l.includes('recordModelContentSuccess')).length,
      2,
      'sopravvivere al reset significa che dopo la prima run nessuno rivede piu\' la riga',
    );
  });
});

/**
 * ── #846/#887 — I CALL SITE INTERNI STANNO SUL PARAMETRO ───────────────────
 *
 * Misurato sul sorgente perche' la differenza non e' osservabile dal ledger:
 * entrambe le forme lo lasciano intatto in opt-out. Cio' che cambia e' il tally
 * di run, e un test che lo leggesse direttamente misurerebbe una sola delle
 * chiamate; il source-guard copre l'intera classe in una riga.
 */
describe('#887 — nessun gate `recordScore` attorno alla chiamata', () => {
  const SRC = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/lib/ai-models.mjs'),
    'utf-8',
  );

  it('i writer di esito sono chiamati sempre, col flag sul parametro', () => {
    const guards = [...SRC.matchAll(/if\s*\(\s*(?:_shouldRecordScore|coerceRecordScore)\([^)]*\)\s*\)\s*\{?\s*\n?\s*record(?:Model)?(?:Content)?(?:Success|Failure)/g)];
    assert.deepEqual(
      guards.map((m) => m[0]),
      [],
      'un gate attorno alla chiamata salta anche il tally di run: la run diagnostica si stampa 0ok/0ko sui modelli che ha chiamato',
    );

    for (const fn of ['recordModelSuccess', 'recordModelFailure']) {
      const calls = [...SRC.matchAll(new RegExp(`\\n\\s+${fn}\\(model[,)]`, 'g'))];
      assert.ok(calls.length > 0, `atteso almeno un call site interno di ${fn}`);
    }
  });
});
