import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  AI_MODELS,
  callSingleModel,
  classifyNonRetryableError,
  qualifyGitHubModelId,
  resetState,
} from '../scripts/lib/ai-models.mjs';

const originalFetch = globalThis.fetch;
const originalGhModelsPat = process.env.GH_MODELS_PAT;

beforeEach(() => {
  process.env.GH_MODELS_PAT = 'test-pat';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGhModelsPat === undefined) delete process.env.GH_MODELS_PAT;
  else process.env.GH_MODELS_PAT = originalGhModelsPat;
  resetState();
});

describe('GitHub Models request contract', () => {
  test('qualifica solo il publisher osservato e non cambia il roster', () => {
    const bareRosterIds = Object.values(AI_MODELS)
      .filter((id) => typeof id === 'string' && !id.includes('/') && !/^(gemini|gemma)-/.test(id));
    assert.equal(bareRosterIds.length, 22);
    for (const id of bareRosterIds) {
      assert.equal(
        qualifyGitHubModelId(id, [{ id: `observed/${id}` }]),
        `observed/${id}`,
      );
    }
    assert.equal(AI_MODELS.GPT4O, 'gpt-4o');
  });

  test('emette publisher/model nel payload e conserva l id bare per il tracking', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const modelUsedRef = {};

    await callSingleModel([{ role: 'user', content: 'x' }], {
      model: AI_MODELS.GPT4O,
      githubModelsCatalog: [{ id: 'openai/gpt-4o' }],
      maxRetriesPerModel: 1,
      modelUsedRef,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://models.github.ai/inference/chat/completions');
    assert.equal(JSON.parse(calls[0].init.body).model, 'openai/gpt-4o');
    assert.equal(modelUsedRef.model, AI_MODELS.GPT4O);
  });

  test('rifiuta un id bare quando il catalogo è ancora non osservabile', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error('non dovrebbe essere chiamato');
    };

    await assert.rejects(
      () => callSingleModel([{ role: 'user', content: 'x' }], {
        model: AI_MODELS.GPT4O,
        maxRetriesPerModel: 3,
      }),
      (error) => error.nonRetryable === true
        && error.nonRetryableReason === 'github_models_catalog_brownout',
    );
    assert.equal(fetchCalls, 0);
  });
});

test('classifica il brownout GitHub Models 410 come permanente', () => {
  assert.deepEqual(
    classifyNonRetryableError(410, '{"error":{"code":"github_models_retirement_brownout"}}'),
    {
      nonRetryable: true,
      markExhausted: true,
      reason: 'github_models_retirement_brownout',
    },
  );
});
