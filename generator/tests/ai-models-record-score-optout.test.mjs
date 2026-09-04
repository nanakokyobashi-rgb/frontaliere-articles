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
 *      questo processo e' stato inquinato;
 *   2. il default (flag assente) continua a scrivere: e' il confine che rende
 *      il test una misura e non una tautologia — senza questo caso, un
 *      `recordScore` che spegnesse TUTTO passerebbe il punto 1 comunque;
 *   3. il ramo host-irraggiungibile di #475 e' coperto quanto gli altri.
 *      Esiste solo in questo repo (il gemello `identical` del sito non ce
 *      l'ha), quindi la discesa 1:1 del flag dal sito lo lasciava scoperto:
 *      `markModelExhausted` scrive `_dirtyModels` come `recordModelFailure`.
 *      Il cooldown del provider, che invece e' in-processo, resta attivo — la
 *      meta' di #475 che risparmia un connect morto per id fratello serve
 *      esattamente al chiamante diagnostico, che la catena la percorre tutta.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  callLLM,
  coerceRecordScore,
  getStats,
  resetState,
  DEFAULT_CHAIN,
  _discoverProvider,
} from '../scripts/lib/ai-models.mjs';

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
    assert.deepEqual(
      stats.exhaustedModels,
      [],
      `nessun modello doveva essere marchiato esausto, visti: ${stats.exhaustedModels.join(', ')}`,
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
    assert.deepEqual(
      stats.exhaustedModels,
      [],
      `nessun ban doveva raggiungere il ledger, visti: ${stats.exhaustedModels.join(', ')}`,
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
      assert.deepEqual(stats.exhaustedModels, [], `nessun ban doveva raggiungere il ledger con recordScore=${JSON.stringify(value)}`);
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

  it('col default la discovery continua a scrivere', async () => {
    const { stale } = await _discoverProvider(cfg);

    assert.ok(stale > 0, 'il ramo markStale non e\' scattato: il test misurerebbe il nulla');
    assert.ok(
      getStats().dirtyModels > 0,
      'la produzione deve continuare a persistere gli id decommissionati: spegnere anche questo non sarebbe un opt-out',
    );
  });
});
