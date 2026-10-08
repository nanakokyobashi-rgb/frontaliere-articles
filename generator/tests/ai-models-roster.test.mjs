import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_MODELS,
  DEFAULT_CHAIN,
  DISCOVERY_PROVIDERS,
  RETIRED_FREE_PROVIDERS,
  discoverFreeModels,
  getProviderRosterStatus,
  getProviderForModel,
  providerRosterReady,
  resetState,
} from '../scripts/lib/ai-models.mjs';

const nvidia = DISCOVERY_PROVIDERS.find((provider) => provider.name === 'NVIDIA');

test('providerRosterReady fallisce chiuso e rende osservabile la lane servibile', () => {
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousViteGemini = process.env.VITE_GEMINI_API_KEY;
  const previousForceChain = process.env.AI_MODELS_FORCE_CHAIN;
  delete process.env.GEMINI_API_KEY;
  delete process.env.VITE_GEMINI_API_KEY;
  delete process.env.AI_MODELS_FORCE_CHAIN;
  resetState();
  try {
    const chain = [AI_MODELS.GEMINI_FLASH];
    const blocked = getProviderRosterStatus({ chain, respectForceChain: false });
    assert.equal(providerRosterReady({ chain, respectForceChain: false }), false);
    assert.equal(blocked.ready, false);
    assert.equal(blocked.reason, 'no-servable-provider');
    assert.deepEqual(blocked.availableModels, []);
    assert.deepEqual(blocked.availableProviders, []);
    assert.equal(blocked.unavailableModels[0].provider, 'gemini');

    process.env.GEMINI_API_KEY = 'roster-test-key';
    const ready = getProviderRosterStatus({ chain, respectForceChain: false });
    assert.equal(providerRosterReady({ chain, respectForceChain: false }), true);
    assert.equal(ready.reason, 'provider-available');
    assert.deepEqual(ready.availableModels, chain);
    assert.deepEqual(ready.availableProviders, ['gemini']);
  } finally {
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
    if (previousViteGemini === undefined) delete process.env.VITE_GEMINI_API_KEY;
    else process.env.VITE_GEMINI_API_KEY = previousViteGemini;
    if (previousForceChain === undefined) delete process.env.AI_MODELS_FORCE_CHAIN;
    else process.env.AI_MODELS_FORCE_CHAIN = previousForceChain;
    resetState();
  }
});

test('providerRosterReady non usa il roster di default quando il contratto e\' invalido', () => {
  assert.equal(providerRosterReady({ chain: null, respectForceChain: false }), false);
  assert.equal(getProviderRosterStatus({ chain: null, respectForceChain: false }).reason, 'invalid-roster');
  assert.equal(providerRosterReady(null), false);
  assert.equal(providerRosterReady({ chain: [null, AI_MODELS.GEMINI_FLASH], respectForceChain: false }), false);
});

test('il gate segue la catena forzata effettiva, ignorando una override vuota', () => {
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousForceChain = process.env.AI_MODELS_FORCE_CHAIN;
  process.env.GEMINI_API_KEY = 'roster-test-key';
  process.env.AI_MODELS_FORCE_CHAIN = ' , ';
  resetState();
  try {
    const status = getProviderRosterStatus({ chain: [AI_MODELS.GEMINI_FLASH], respectForceChain: true });
    assert.equal(status.ready, true);
    assert.deepEqual(status.availableModels, [AI_MODELS.GEMINI_FLASH]);
  } finally {
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
    if (previousForceChain === undefined) delete process.env.AI_MODELS_FORCE_CHAIN;
    else process.env.AI_MODELS_FORCE_CHAIN = previousForceChain;
    resetState();
  }
});

describe('roster NVIDIA', () => {
  test('mantiene in catena il modello live usato come fallback affidabile', () => {
    assert.equal(AI_MODELS.NV_NEMOTRON_SUPER, 'nvidia/nvidia/nemotron-3-super-120b-a12b');
    assert.ok(DEFAULT_CHAIN.includes(AI_MODELS.NV_NEMOTRON_SUPER));
  });

  test('non reinserisce gli id NVIDIA osservati come HTTP 410', () => {
    assert.ok(nvidia, 'provider NVIDIA non trovato');
    for (const id of [
      'meta/llama-3.1-8b-instruct',
      'mistralai/mistral-small-4-119b-2603',
      'nvidia/nemotron-nano-9b-v2',
    ]) {
      assert.equal(nvidia.pick({ id }), null, `id ritirato accettato: ${id}`);
    }
    assert.equal(nvidia.pick({ id: 'nemotron-3-super-120b-a12b' }), 'nemotron-3-super-120b-a12b');
  });
});

// Decisione del proprietario (2026-09-25): i provider free che rispondono
// 402/401/412 in modo permanente escono dalla catena e dalla discovery, e le
// chiamate che servivano le prende Codex Luna Max. Evidenza nel blocco di
// RETIRED_FREE_PROVIDERS in ai-models.mjs.
describe('provider free spenti', () => {
  const SPENTI = ['mistral', 'sambanova', 'cerebras', 'huggingface', 'together', 'fireworks'];

  test('sono esattamente quelli trovati morti dallo smoke-test', () => {
    assert.deepEqual([...RETIRED_FREE_PROVIDERS].sort(), [...SPENTI].sort());
  });

  test('DEFAULT_CHAIN non offre piu\' nessun loro modello', () => {
    const offerti = DEFAULT_CHAIN.filter((model) => RETIRED_FREE_PROVIDERS.includes(getProviderForModel(model)));
    assert.deepEqual(offerti, []);
    // Il catalogo resta: riattivare un provider significa rimettere gli id in catena.
    assert.equal(getProviderForModel(AI_MODELS.MISTRAL_SMALL), 'mistral');
    assert.equal(getProviderForModel(AI_MODELS.HF_LLAMA_3_3_70B), 'huggingface');
  });

  test('la discovery non ne interroga il listing, e interroga ancora gli altri', async () => {
    const CHIAVI = [
      'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY',
      'NVIDIA_API_KEY', 'SAMBANOVA_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY',
      'COHERE_API_KEY',
    ];
    const envPrima = Object.fromEntries(CHIAVI.map((k) => [k, process.env[k]]));
    const fetchPrima = globalThis.fetch;
    const warnPrima = console.warn;
    const errorPrima = console.error;
    const interrogati = [];
    const righe = [];
    for (const k of CHIAVI) process.env[k] = 'chiave-finta';
    globalThis.fetch = async (url) => {
      interrogati.push(String(url));
      return { ok: false, status: 503, json: async () => ({}) };
    };
    console.warn = () => {};
    console.error = (...args) => { righe.push(args.join(' ')); };
    const catenaPrima = [...DEFAULT_CHAIN];
    try {
      resetState();
      await discoverFreeModels({ recordScore: false });
    } finally {
      globalThis.fetch = fetchPrima;
      console.warn = warnPrima;
      console.error = errorPrima;
      for (const [k, v] of Object.entries(envPrima)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetState();
    }
    for (const host of ['api.mistral.ai', 'api.cerebras.ai', 'api.sambanova.ai', 'api.together.xyz', 'api.fireworks.ai']) {
      assert.ok(!interrogati.some((url) => url.includes(host)), `listing spento interrogato: ${host}`);
    }
    // Senza questo controllo il test passerebbe anche con la discovery spenta del tutto.
    for (const host of ['openrouter.ai', 'api.groq.com', 'integrate.api.nvidia.com']) {
      assert.ok(interrogati.some((url) => url.includes(host)), `listing attivo non interrogato: ${host}`);
    }
    assert.deepEqual(DEFAULT_CHAIN, catenaPrima);
    assert.equal(righe.filter((r) => r.includes('provider spenti non interrogati')).length, 1);
    // Le voci restano, per il giorno in cui l'account torna utilizzabile.
    assert.ok(DISCOVERY_PROVIDERS.some((cfg) => cfg.name === 'Mistral'));
  });
});
