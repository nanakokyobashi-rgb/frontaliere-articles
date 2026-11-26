import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  AI_MODELS,
  callLLM,
  resetState,
} from '../scripts/lib/ai-models.mjs';

test('la deadline esatta blocca la cascata prima della prima chiamata provider', async () => {
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;
  const originalGhModelsPat = process.env.GH_MODELS_PAT;
  const deadlineMs = 1_000_000;
  let fetchCalls = 0;

  process.env.GH_MODELS_PAT = 'test-pat';
  Date.now = () => deadlineMs;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'unexpected' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const error = await callLLM([{ role: 'user', content: 'x' }], {
      chain: [AI_MODELS.GPT4O],
      deadlineMs,
      githubModelsCatalog: [{ id: 'openai/gpt-4o' }],
      maxRetriesPerModel: 1,
      recordScore: false,
    }).then(() => null, (caught) => caught);

    assert.ok(error, 'la cascata scaduta deve rifiutare la chiamata');
    assert.equal(error.code, 'ALL_MODELS_EXHAUSTED');
    assert.equal(error.deadlineExpiredBeforeCascade, true);
    assert.equal(fetchCalls, 0, 'il bordo esatto non deve raggiungere alcun provider');
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    if (originalGhModelsPat === undefined) delete process.env.GH_MODELS_PAT;
    else process.env.GH_MODELS_PAT = originalGhModelsPat;
    resetState();
  }
});
