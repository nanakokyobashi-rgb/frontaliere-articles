import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  AI_MODELS,
  callSingleModel,
  callLLM,
  classifyNonRetryableError,
  getStats,
  getScoreBoard,
  qualifyGitHubModelId,
  resetState,
} from '../scripts/lib/ai-models.mjs';

const originalFetch = globalThis.fetch;
const originalGhModelsPats = Object.fromEntries(
  Array.from({ length: 9 }, (_, index) => {
    const key = index === 0 ? 'GH_MODELS_PAT' : `GH_MODELS_PAT_${index + 1}`;
    return [key, process.env[key]];
  }),
);

beforeEach(() => {
  process.env.GH_MODELS_PAT = 'test-pat';
  for (let i = 2; i <= 9; i++) delete process.env[`GH_MODELS_PAT_${i}`];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalGhModelsPats)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

  test('il consumer carica e riusa il catalogo osservato per gli ID bare', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/catalog/models')) {
        return new Response(JSON.stringify({ models: [{ id: 'openai/gpt-4o' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await callSingleModel([{ role: 'user', content: 'x' }], {
      model: AI_MODELS.GPT4O,
      maxRetriesPerModel: 1,
    });
    await callSingleModel([{ role: 'user', content: 'y' }], {
      model: AI_MODELS.GPT4O,
      maxRetriesPerModel: 1,
    });

    assert.equal(calls.filter(({ url }) => url.endsWith('/catalog/models')).length, 1);
    assert.equal(calls.filter(({ url }) => url.endsWith('/chat/completions')).length, 2);
    assert.equal(JSON.parse(calls[1].init.body).model, 'openai/gpt-4o');
  });

  test('ruota il catalogo osservato quando il primo PAT non espone il modello', async () => {
    process.env.GH_MODELS_PAT_2 = 'second-pat';
    const catalogAuth = [];
    const completions = [];
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target.endsWith('/catalog/models')) {
        catalogAuth.push(init.headers.Authorization);
        const models = init.headers.Authorization === 'Bearer second-pat'
          ? [{ id: 'openai/gpt-4o' }]
          : [];
        return new Response(JSON.stringify({ models }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      completions.push({ url: target, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await callSingleModel([{ role: 'user', content: 'x' }], {
      model: AI_MODELS.GPT4O,
      maxRetriesPerModel: 1,
    });

    assert.deepEqual(catalogAuth, ['Bearer test-pat', 'Bearer second-pat']);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].init.headers.Authorization, 'Bearer second-pat');
    assert.equal(JSON.parse(completions[0].init.body).model, 'openai/gpt-4o');
    assert.deepEqual(getStats().exhaustedModels, []);
  });

  test('ruota anche un failure account-specifico del catalogo 401', async () => {
    process.env.GH_MODELS_PAT_2 = 'second-pat';
    const catalogAuth = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/catalog/models')) {
        catalogAuth.push(init.headers.Authorization);
        if (init.headers.Authorization === 'Bearer test-pat') {
          return new Response('{"message":"bad credentials"}', { status: 401 });
        }
        return new Response(JSON.stringify({ models: [{ id: 'openai/gpt-4o' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await callSingleModel([{ role: 'user', content: 'x' }], {
      model: AI_MODELS.GPT4O,
      maxRetriesPerModel: 1,
    });

    assert.deepEqual(catalogAuth, ['Bearer test-pat', 'Bearer second-pat']);
    assert.deepEqual(getStats().exhaustedModels, []);
  });

  test('ruota anche un rate limit account-specifico del catalogo 429', async () => {
    process.env.GH_MODELS_PAT_2 = 'second-pat';
    const catalogAuth = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/catalog/models')) {
        catalogAuth.push(init.headers.Authorization);
        if (init.headers.Authorization === 'Bearer test-pat') {
          return new Response('{"message":"rate limited"}', { status: 429 });
        }
        return new Response(JSON.stringify({ models: [{ id: 'openai/gpt-4o' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await callSingleModel([{ role: 'user', content: 'x' }], {
      model: AI_MODELS.GPT4O,
      maxRetriesPerModel: 1,
    });

    assert.deepEqual(catalogAuth, ['Bearer test-pat', 'Bearer second-pat']);
    assert.deepEqual(getStats().exhaustedModels, []);
  });

  test('un guasto transitorio del catalogo resta un fault negativo per la run e si riapre dopo resetState', async () => {
    let catalogCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/catalog/models')) {
        catalogCalls++;
        if (catalogCalls === 1) return new Response('gateway unavailable', { status: 503 });
        return new Response(JSON.stringify({ models: [{ id: 'openai/gpt-4o' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await assert.rejects(
      () => callSingleModel([{ role: 'user', content: 'x' }], {
        model: AI_MODELS.GPT4O,
        maxRetriesPerModel: 1,
      }),
      (error) => error.githubModelsCatalogFault === true
        && error.transportFault === true
        && error.nonRetryable === false
        && error.markExhausted === false,
    );
    assert.deepEqual(getStats().exhaustedModels, []);
    assert.equal(
      getScoreBoard().some(({ model }) => model === AI_MODELS.GPT4O),
      false,
    );

    await assert.rejects(
      () => callSingleModel([{ role: 'user', content: 'y' }], {
        model: AI_MODELS.GPT4O,
        maxRetriesPerModel: 1,
      }),
      (error) => error.githubModelsCatalogFault === true
        && error.transportFault === true
        && error.nonRetryable === false
        && error.markExhausted === false,
    );
    assert.equal(catalogCalls, 1, 'lo stesso guasto non deve ripetere il GET per il modello successivo');

    resetState();
    await callSingleModel([{ role: 'user', content: 'z' }], {
      model: AI_MODELS.GPT4O,
      maxRetriesPerModel: 1,
    });
    assert.equal(catalogCalls, 2, 'resetState deve consentire il retry nel ciclo successivo');
  });

  test('i mapping GitHub non osservabili o ambigui sono persistenti nel verdetto della run', async () => {
    for (const githubModelsCatalog of [
      [],
      [{ id: 'openai/gpt-4o' }, { id: 'azure/gpt-4o' }],
    ]) {
      await assert.rejects(
        () => callLLM([{ role: 'user', content: 'x' }], {
          chain: [AI_MODELS.GPT4O],
          githubModelsCatalog,
          maxRetriesPerModel: 1,
          recordScore: false,
        }),
        (error) => {
          assert.equal(error.exhaustionBreakdown.transient, 0);
          assert.equal(error.exhaustionBreakdown.persistent, 1);
          assert.match(error.message, /\[authoritative-cause=persistent\]/);
          return true;
        },
      );
      resetState();
    }
  });

  test('un JSON del catalogo non valido è un guasto del provider, non un ban del modello', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/catalog/models')) return new Response('{', { status: 200 });
      throw new Error('la completion non deve partire');
    };

    await assert.rejects(
      () => callSingleModel([{ role: 'user', content: 'x' }], {
        model: AI_MODELS.GPT4O,
        maxRetriesPerModel: 1,
      }),
      (error) => error.githubModelsCatalogFault === true
        && error.nonRetryable === false
        && error.markExhausted === false,
    );
    assert.deepEqual(getStats().exhaustedModels, []);
    assert.equal(
      getScoreBoard().some(({ model }) => model === AI_MODELS.GPT4O),
      false,
    );
  });

  test('usa l id bare per il parametro e il cap dei modelli qualificati', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await callSingleModel([{ role: 'user', content: 'x' }], {
      model: AI_MODELS.PHI_4_REASON,
      githubModelsCatalog: [{ id: 'openai/Phi-4-reasoning' }],
      maxTokens: 3000,
      maxRetriesPerModel: 1,
    });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'openai/Phi-4-reasoning');
    assert.equal(body.max_completion_tokens, 3000);
    assert.equal(body.max_tokens, undefined);
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
        githubModelsCatalog: null,
        maxRetriesPerModel: 3,
        recordScore: false,
      }),
      (error) => error.nonRetryable === true
        && error.nonRetryableReason === 'github_models_catalog_brownout',
    );
    assert.equal(fetchCalls, 0);
    assert.deepEqual(getStats().exhaustedModels, [AI_MODELS.GPT4O]);
    assert.equal(getStats().dirtyModels, 0);
  });

  test('cacheizza solo il brownout 410 intenzionale del catalogo', async () => {
    let catalogCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/catalog/models')) {
        catalogCalls++;
        return new Response(
          '{"error":{"code":"github_models_retirement_brownout"}}',
          { status: 410, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error('la completion non deve partire');
    };

    for (const model of [AI_MODELS.GPT4O, AI_MODELS.GPT4O_MINI]) {
      await assert.rejects(
        () => callSingleModel([{ role: 'user', content: 'x' }], {
          model,
          maxRetriesPerModel: 1,
        }),
        (error) => error.nonRetryableReason === 'github_models_catalog_brownout',
      );
    }

    assert.equal(catalogCalls, 1);
    assert.deepEqual(getStats().exhaustedModels, [AI_MODELS.GPT4O, AI_MODELS.GPT4O_MINI]);
  });
});

test('classifica il brownout 410 solo per GitHub Models', () => {
  const body = '{"error":{"code":"github_models_retirement_brownout"}}';
  assert.deepEqual(classifyNonRetryableError(410, body, 'GitHub'), {
    nonRetryable: true,
    markExhausted: true,
    reason: 'github_models_retirement_brownout',
  });
  assert.deepEqual(classifyNonRetryableError(410, body, 'Gemini'), {
    nonRetryable: false,
    markExhausted: false,
  });
});

test('i brownout GitHub sono persistenti nel verdetto aggregato', async () => {
  const persistentVerdict = (label) => (error) => {
    assert.equal(error.exhaustionBreakdown.transient, 0, label);
    assert.equal(error.exhaustionBreakdown.persistent, 1, label);
    assert.match(error.message, /\[authoritative-cause=persistent\]/, label);
    return true;
  };

  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 'github_models_retirement_brownout' } }),
    { status: 410, headers: { 'content-type': 'application/json' } },
  );
  await assert.rejects(
    () => callLLM([{ role: 'user', content: 'x' }], {
      chain: [AI_MODELS.GPT4O],
      githubModelsCatalog: [{ id: 'openai/gpt-4o' }],
      maxRetriesPerModel: 1,
      recordScore: false,
    }),
    persistentVerdict('il 410 di brownout deve votare persistente'),
  );

  resetState();
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ error: { code: 'github_models_retirement_brownout' } }), {
      status: 410,
      headers: { 'content-type': 'application/json' },
    });
  };
  await assert.rejects(
    () => callLLM([{ role: 'user', content: 'x' }], {
      chain: [AI_MODELS.GPT4O],
      maxRetriesPerModel: 1,
      recordScore: false,
    }),
    persistentVerdict('il catalogo in brownout deve votare persistente'),
  );
  assert.deepEqual(fetchCalls, ['https://models.github.ai/catalog/models']);
});
