import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, test } from 'node:test';

import {
  AI_MODELS,
  callLLM,
  resetState,
} from '../scripts/lib/ai-models.mjs';

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
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetState();
});

test('Gemini resta disabilitato anche se una vecchia variabile viene reiniettata', async () => {
  const error = await callLLM([{ role: 'user', content: 'x' }], {
    chain: [AI_MODELS.GEMINI_FLASH],
    maxRetriesPerModel: 1,
    backoffMs: 1,
    timeout: 5000,
    recordScore: false,
  }).then(() => null, (caught) => caught);

  assert.ok(error, 'il provider ritirato deve fallire chiuso');
  assert.match(error.message, /no API key for provider gemini/);
});
