import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, test } from 'node:test';

import {
  AI_MODELS,
  callLLM,
  getStats,
  resetState,
} from '../scripts/lib/ai-models.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  VITE_GEMINI_API_KEY: process.env.VITE_GEMINI_API_KEY,
  AI_MODELS_FORCE_CHAIN: process.env.AI_MODELS_FORCE_CHAIN,
};

beforeEach(() => {
  resetState();
  process.env.GEMINI_API_KEY = 'gemini-content-test';
  delete process.env.VITE_GEMINI_API_KEY;
  delete process.env.AI_MODELS_FORCE_CHAIN;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: { invalid: true } }] } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetState();
});

test('Gemini tratta il testo non-stringa come content failure', async () => {
  const error = await callLLM([{ role: 'user', content: 'x' }], {
    chain: [AI_MODELS.GEMINI_FLASH],
    maxRetriesPerModel: 1,
    backoffMs: 1,
    timeout: 5000,
    recordScore: false,
  }).then(() => null, (caught) => caught);

  assert.ok(error, 'il payload Gemini malformato deve fallire');
  assert.match(error.message, /non-string content: object/);
  assert.equal(getStats().successes, 0, 'il payload malformato non deve contare come successo');
  assert.equal(getStats().retries, 0, 'un content failure non va ritentato nello stesso modello');
});

test('Gemini tratta parts non-array come content failure', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: {} } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const error = await callLLM([{ role: 'user', content: 'x' }], {
    chain: [AI_MODELS.GEMINI_FLASH],
    maxRetriesPerModel: 1,
    backoffMs: 1,
    timeout: 5000,
    recordScore: false,
  }).then(() => null, (caught) => caught);

  assert.ok(error, 'parts non-array deve fallire');
  assert.match(error.message, /invalid content parts: expected array/);
  assert.equal(getStats().successes, 0, 'il payload malformato non deve contare come successo');
  assert.equal(getStats().retries, 0, 'un content failure non va ritentato nello stesso modello');
});

test('Gemini interrompe subito il retry loop su una risposta HTTP 200 vuota', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const error = await callLLM([{ role: 'user', content: 'x' }], {
    chain: [AI_MODELS.GEMINI_FLASH],
    maxRetriesPerModel: 3,
    backoffMs: 1,
    timeout: 5000,
    recordScore: false,
  }).then(() => null, (caught) => caught);

  assert.ok(error, 'una risposta vuota deve fallire');
  assert.match(error.message, /Empty response/);
  assert.equal(calls, 1, 'il body vuoto non deve ripagare i retry del modello');
  assert.equal(getStats().successes, 0, 'il body vuoto non deve contare come successo');
  assert.equal(getStats().retries, 0, 'il content failure deve arrivare subito al breaker');
});
