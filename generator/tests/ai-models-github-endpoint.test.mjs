import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  AI_MODELS,
  callSingleModel,
  callLLM,
  classifyExhaustionCause,
  classifyNonRetryableError,
  getStats,
  getScoreBoard,
  isRetryableError,
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

const NVIDIA_EOL_BODY = '{"type":"about:blank","title":"Gone","status":410,"detail":"The model \'meta/llama-3.1-8b-instruct\' has reached its end of life on 2026-08-26T09:00:00Z..."}';
const OPENROUTER_AGENTIC_BODY = '{"error":{"message":"thinkingmachines/inkling-small:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app..."}}';
const OPENROUTER_AGENTIC_BUSY_TRAP = '{"error":{"message":"thinkingmachines/inkling-small:free is only available on agentic harnesses. The cluster is busy serving those apps."}}';
const TRANSIENT_UNAVAILABLE_BODY = '{"error":{"message":"temporarily unavailable"}}';
const TRANSIENT_RATE_LIMIT_BODY = '{"error":{"message":"rate limit exceeded, retry later"}}';
const TRANSIENT_BUSY_BODY = '{"error":{"message":"model is busy"}}';
const WAF_IP_403_BODY = '{"error":{"message":"Your IP has been blocked by the WAF"}}';
const CREDENTIAL_403_BODY = '{"error":{"message":"invalid api key"}}';
const ROUTING_410_BODY = '{"error":{"message":"No healthy upstream; origin routing changed"}}';
const GROQ_DECOMMISSION_410 = '{"error":{"message":"model llama-3.1-8b-instant has been decommissioned"}}';

describe('matrice 403/410: isRetryableError e classifyNonRetryableError', () => {
  const matrix = [
    {
      label: 'OpenRouter 403 temporarily unavailable',
      status: 403,
      provider: 'OpenRouter',
      body: TRANSIENT_UNAVAILABLE_BODY,
      retryable: true,
      classification: { nonRetryable: false, markExhausted: false },
    },
    {
      label: 'NVIDIA 410 temporarily unavailable',
      status: 410,
      provider: 'NVIDIA',
      body: TRANSIENT_UNAVAILABLE_BODY,
      retryable: true,
      classification: { nonRetryable: false, markExhausted: false },
    },
    {
      label: 'Groq 403 rate limit',
      status: 403,
      provider: 'Groq',
      body: TRANSIENT_RATE_LIMIT_BODY,
      retryable: true,
      classification: { nonRetryable: false, markExhausted: false },
    },
    {
      label: 'HuggingFace 403 model is busy',
      status: 403,
      provider: 'HuggingFace',
      body: TRANSIENT_BUSY_BODY,
      retryable: true,
      classification: { nonRetryable: false, markExhausted: false },
    },
    {
      label: 'OpenRouter 403 agentic harnesses',
      status: 403,
      provider: 'OpenRouter',
      body: OPENROUTER_AGENTIC_BODY,
      retryable: false,
      classification: { nonRetryable: true, markExhausted: true },
    },
    {
      label: 'OpenRouter 403 agentic + busy (false-positive trap)',
      status: 403,
      provider: 'OpenRouter',
      body: OPENROUTER_AGENTIC_BUSY_TRAP,
      retryable: false,
      classification: { nonRetryable: true, markExhausted: true },
    },
    {
      label: 'NVIDIA 410 end of life',
      status: 410,
      provider: 'NVIDIA',
      body: NVIDIA_EOL_BODY,
      retryable: false,
      classification: { nonRetryable: true, markExhausted: true },
    },
    {
      label: 'Groq 410 decommissioned',
      status: 410,
      provider: 'Groq',
      body: GROQ_DECOMMISSION_410,
      retryable: false,
      classification: { nonRetryable: true, markExhausted: true },
    },
    {
      label: 'OpenRouter 403 WAF/IP',
      status: 403,
      provider: 'OpenRouter',
      body: WAF_IP_403_BODY,
      retryable: false,
      classification: { nonRetryable: true, markExhausted: true, exhaustProvider: true },
    },
    {
      label: 'Cerebras 403 invalid api key',
      status: 403,
      provider: 'Cerebras',
      body: CREDENTIAL_403_BODY,
      retryable: false,
      classification: { nonRetryable: true, markExhausted: true, exhaustProvider: true },
    },
    {
      label: 'NVIDIA 410 routing / intermediary',
      status: 410,
      provider: 'NVIDIA',
      body: ROUTING_410_BODY,
      retryable: false,
      classification: { nonRetryable: true, markExhausted: false },
    },
    {
      label: 'NVIDIA 410 empty body (no EOL evidence)',
      status: 410,
      provider: 'NVIDIA',
      body: '',
      retryable: false,
      classification: { nonRetryable: true, markExhausted: false },
    },
    {
      label: 'GitHub 403 bad credentials still falls through',
      status: 403,
      provider: 'GitHub',
      body: '{"message":"bad credentials"}',
      retryable: false,
      classification: { nonRetryable: false, markExhausted: false },
    },
    {
      label: 'GitHub 403 rate limit stays retryable',
      status: 403,
      provider: 'GitHub',
      body: TRANSIENT_RATE_LIMIT_BODY,
      retryable: true,
      classification: { nonRetryable: false, markExhausted: false },
    },
  ];

  for (const { label, status, provider, body, retryable, classification } of matrix) {
    test(label, () => {
      assert.equal(isRetryableError(status, body), retryable, `${label}: isRetryableError`);
      assert.deepEqual(
        classifyNonRetryableError(status, body, provider),
        classification,
        `${label}: classifyNonRetryableError`,
      );
    });
  }
});

describe('call-path 403/410: sibling exhaustion vs model-only vs routing', () => {
  const originalOr = process.env.OPENROUTER_API_KEY;
  const originalNv = process.env.NVIDIA_API_KEY;
  const originalGemini = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'or-test';
    process.env.NVIDIA_API_KEY = 'nv-test';
    delete process.env.GEMINI_API_KEY;
    delete process.env.VITE_GEMINI_API_KEY;
  });

  afterEach(() => {
    if (originalOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOr;
    if (originalNv === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = originalNv;
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
  });

  const orA = AI_MODELS.OR_LLAMA_3_3;
  const orB = AI_MODELS.OR_GEMMA_3_27B;
  const nvA = 'nvidia/meta/llama-3.1-8b-instruct';
  const nvB = 'nvidia/nvidia/nemotron-3-super-120b-a12b';

  test('un 403 provider-wide esaurisce i sibling, un 403 per-modello no', async () => {
    const seen = [];
    globalThis.fetch = async (_url, init) => {
      seen.push(JSON.parse(init.body).model);
      return new Response(WAF_IP_403_BODY, {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], {
        chain: [orA, orB],
        maxRetriesPerModel: 1,
        backoffMs: 1,
        timeout: 5000,
        recordScore: false,
      }),
    );

    assert.equal(seen.length, 1, 'il sibling OpenRouter non deve essere composto dopo un 403 WAF');
    assert.ok(getStats().exhaustedModels.includes(orA), `atteso ${orA} esaurito, visti: ${getStats().exhaustedModels.join(', ')}`);
    assert.equal(getStats().activeCooldowns.openrouter, Infinity);

    resetState();
    seen.length = 0;
    globalThis.fetch = async (_url, init) => {
      seen.push(JSON.parse(init.body).model);
      return new Response(OPENROUTER_AGENTIC_BODY, {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], {
        chain: [orA, orB],
        maxRetriesPerModel: 1,
        backoffMs: 1,
        timeout: 5000,
        recordScore: false,
      }),
    );

    assert.equal(seen.length, 2, 'un 403 agentic-harness esaurisce solo il modello, il fratello resta componibile');
    assert.ok(getStats().exhaustedModels.includes(orA));
    assert.ok(getStats().exhaustedModels.includes(orB));
    assert.equal(getStats().activeCooldowns.openrouter, undefined);
  });

  test('un 403 GitHub continua a cadere nel fall-through multi-PAT, senza esaurire i sibling', async () => {
    const seen = [];
    globalThis.fetch = async (_url, init) => {
      seen.push(JSON.parse(init.body).model);
      return new Response('{"message":"bad credentials"}', {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], {
        chain: [AI_MODELS.GPT4O, AI_MODELS.GPT4O_MINI],
        githubModelsCatalog: [
          { id: 'openai/gpt-4o' },
          { id: 'openai/gpt-4o-mini' },
        ],
        maxRetriesPerModel: 1,
        backoffMs: 1,
        timeout: 5000,
        recordScore: false,
      }),
    );

    assert.deepEqual(seen, ['openai/gpt-4o', 'openai/gpt-4o-mini']);
    assert.deepEqual(getStats().exhaustedModels, []);
    assert.equal(getStats().activeCooldowns.github, undefined);
  });

  test('un 410 EOL ritira il modello; un 410 di routing no', async () => {
    const seen = [];
    globalThis.fetch = async (_url, init) => {
      seen.push(JSON.parse(init.body).model);
      return new Response(NVIDIA_EOL_BODY, {
        status: 410,
        headers: { 'content-type': 'application/json' },
      });
    };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], {
        chain: [nvA, nvB],
        maxRetriesPerModel: 1,
        backoffMs: 1,
        timeout: 5000,
        recordScore: false,
      }),
    );

    assert.equal(seen.length, 2, 'il 410 EOL e\' per-modello: il fratello NVIDIA viene comunque composto');
    assert.ok(getStats().exhaustedModels.includes(nvA), `atteso ${nvA} esaurito, visti: ${getStats().exhaustedModels.join(', ')}`);
    assert.ok(getStats().exhaustedModels.includes(nvB));

    resetState();
    seen.length = 0;
    globalThis.fetch = async (_url, init) => {
      seen.push(JSON.parse(init.body).model);
      return new Response(ROUTING_410_BODY, {
        status: 410,
        headers: { 'content-type': 'application/json' },
      });
    };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], {
        chain: [nvA, nvB],
        maxRetriesPerModel: 1,
        backoffMs: 1,
        timeout: 5000,
        recordScore: false,
      }),
    );

    assert.equal(seen.length, 2);
    assert.deepEqual(
      getStats().exhaustedModels,
      [],
      `un 410 di routing non deve ritirare un modello vivo, visti: ${getStats().exhaustedModels.join(', ')}`,
    );
  });
});
