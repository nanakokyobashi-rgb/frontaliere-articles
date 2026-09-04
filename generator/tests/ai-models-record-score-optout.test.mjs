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
  getStats,
  resetState,
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
