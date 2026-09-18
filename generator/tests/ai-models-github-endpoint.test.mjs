import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  AI_MODELS,
  callSingleModel,
  callLLM,
  classifyExhaustionCause,
  classifyNonRetryableError,
  getDeclaredRequestTokenLimit,
  getStats,
  getScoreBoard,
  githubModelIdForLookup,
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

  test('usa il primo envelope successivo popolato dopo uno vuoto', () => {
    assert.equal(
      qualifyGitHubModelId(AI_MODELS.GPT4O, {
        models: [],
        data: [{ id: 'openai/gpt-4o' }],
      }),
      'openai/gpt-4o',
    );
  });

  test('rifiuta envelope con piu liste popolate', () => {
    assert.throws(
      () => qualifyGitHubModelId(AI_MODELS.GPT4O, {
        models: [{ id: 'openai/gpt-4o' }],
        data: [{ id: 'azure/gpt-4o' }],
      }),
      (error) => error.githubModelsCatalogFault === true
        && error.transportFault === true
        && error.nonRetryable === false,
    );
  });

  test('il consumer valida lo stesso envelope ambiguo scaricato dal provider', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/catalog/models')) {
        return new Response(JSON.stringify({
          models: [{ id: 'openai/gpt-4o' }],
          data: [{ id: 'azure/gpt-4o' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('la completion non deve partire');
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

  test('un ID gia qualificato usa il bare per policy e il qualificato nel payload', async () => {
    assert.equal(githubModelIdForLookup('openai/Phi-4-reasoning'), AI_MODELS.PHI_4_REASON);
    assert.equal(githubModelIdForLookup(AI_MODELS.PHI_4_REASON), AI_MODELS.PHI_4_REASON);
    assert.equal(
      qualifyGitHubModelId('openai/Phi-4-reasoning', [{ id: 'azure/Phi-4-reasoning' }]),
      'openai/Phi-4-reasoning',
    );
    assert.equal(getDeclaredRequestTokenLimit('openai/gpt-4o-mini'), 4000);

    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await callSingleModel([{ role: 'user', content: 'x' }], {
      model: 'openai/Phi-4-reasoning',
      githubModelsCatalog: [{ id: 'openai/Phi-4-reasoning' }],
      maxTokens: 3000,
      maxRetriesPerModel: 1,
    });
    await callSingleModel([{ role: 'user', content: 'y' }], {
      model: `microsoft/${AI_MODELS.PHI_4_MINI_REASON}`,
      githubModelsCatalog: [{ id: `microsoft/${AI_MODELS.PHI_4_MINI_REASON}` }],
      maxTokens: 8000,
      maxRetriesPerModel: 1,
    });

    const reasoning = JSON.parse(calls[0].init.body);
    assert.equal(reasoning.model, 'openai/Phi-4-reasoning');
    assert.equal(reasoning.max_completion_tokens, 3000);
    assert.equal(reasoning.max_tokens, undefined);

    const mini = JSON.parse(calls[1].init.body);
    assert.equal(mini.model, `microsoft/${AI_MODELS.PHI_4_MINI_REASON}`);
    assert.equal(mini.max_completion_tokens, 4000);
    assert.equal(mini.max_tokens, undefined);
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

test('classifica 410 e 403 generici senza alterare il brownout GitHub', () => {
  const nvidiaGoneBody = '{"type":"about:blank","title":"Gone","status":410,"detail":"The model \'meta/llama-3.1-8b-instruct\' has reached its end of life on 2026-08-26T09:00:00Z..."}';
  const openRouterForbiddenBody = '{"error":{"message":"thinkingmachines/inkling-small:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app..."}}';
  const githubForbiddenBody = '{"message":"bad credentials"}';
  const transientBody = '{"error":{"message":"temporarily unavailable"}}';
  const githubBrownoutBody = '{"error":{"code":"github_models_retirement_brownout"}}';

  // Finding 1: this classifier runs before isRetryableError, so transient
  // bodies must fall through instead of being marked exhausted by status alone.
  // Finding 2: a GitHub 403 must also fall through; `nonretryable` would stop
  // the multi-PAT rotation that account-specific failures rely on.
  assert.deepEqual(classifyNonRetryableError(403, githubForbiddenBody, 'GitHub'), {
    nonRetryable: false,
    markExhausted: false,
  });
  assert.deepEqual(classifyNonRetryableError(403, transientBody, 'OpenRouter'), {
    nonRetryable: false,
    markExhausted: false,
  });
  assert.deepEqual(classifyNonRetryableError(410, transientBody, 'NVIDIA'), {
    nonRetryable: false,
    markExhausted: false,
  });

  // The measured PR cases remain non-retryable: neither body is transient and
  // neither request is for GitHub Models.
  assert.deepEqual(classifyNonRetryableError(410, nvidiaGoneBody, 'NVIDIA'), {
    nonRetryable: true,
    markExhausted: true,
  });
  assert.deepEqual(classifyNonRetryableError(403, openRouterForbiddenBody, 'OpenRouter'), {
    nonRetryable: true,
    markExhausted: true,
  });
  assert.deepEqual(classifyNonRetryableError(410, githubBrownoutBody, 'GitHub'), {
    nonRetryable: true,
    markExhausted: true,
    reason: 'github_models_retirement_brownout',
  });
});

test('403 e 410 non diventano transitori nel tally di exhaustion', () => {
  const cases = [
    {
      label: 'skip 403 dopo exhausted',
      reason: 'openrouter/thinkingmachines/inkling:free: skipped — exhausted (non-retryable provider error (HTTP 403))',
      transient: 0,
      persistent: 1,
    },
    {
      label: 'skip 410 dopo exhausted',
      reason: 'nvidia/meta/llama-3.1-8b-instruct: skipped — exhausted (non-retryable provider error (HTTP 410))',
      transient: 0,
      persistent: 1,
    },
    // Nei fallimenti diretti 403/410, "ambiguo" è un vuoto, non una garanzia: aggiungere 403 alla persistentRe
    // sarebbe un miglioramento e renderebbe rossa l'asserzione persistent=0; l'invariante è mai transient (niente differimento silenzioso).
    {
      label: 'fallimento diretto 403',
      reason: 'openrouter/thinkingmachines/inkling:free: [OpenRouter/thinkingmachines/inkling:free] HTTP 403: {"error":{"message":"only available on agentic harnesses"}}',
      transient: 0,
    },
    {
      label: 'fallimento diretto 410',
      reason: 'nvidia/meta/llama-3.1-8b-instruct: [NVIDIA/meta/llama-3.1-8b-instruct] HTTP 410: {"title":"Gone","detail":"has reached its end of life"}',
      transient: 0,
    },
    {
      label: 'controllo quota 429',
      reason: 'openai/gpt-4o: [OpenAI/gpt-4o] HTTP 429: {"error":{"message":"quota exceeded"}}',
      transient: 1,
      persistent: 0,
    },
  ];

  for (const { label, reason, transient, persistent } of cases) {
    const verdict = classifyExhaustionCause(reason);
    assert.equal(verdict.transient, transient, label);
    if (persistent !== undefined) assert.equal(verdict.persistent, persistent, label);
    assert.equal(verdict.total, 1, label);
  }
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
