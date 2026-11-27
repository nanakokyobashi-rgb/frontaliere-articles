import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { AI_MODELS, callSingleModel, resetState } from '../scripts/lib/ai-models.mjs';

test('array JSON mode leaves the object-only HTTP response format unset', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    resetState();
  });

  process.env.OPENROUTER_API_KEY = 'fixture-key';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.response_format, undefined);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '[{"q":"Domanda?","a":"Risposta."}]' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const text = await callSingleModel([{ role: 'user', content: 'Produci una FAQ.' }], {
    model: AI_MODELS.OR_LLAMA_3_3,
    jsonMode: true,
    jsonTopLevelType: 'array',
    maxRetriesPerModel: 1,
    recordScore: false,
  });
  assert.equal(text, '[{"q":"Domanda?","a":"Risposta."}]');
});

test('i consumatori che chiedono array dichiarano il tipo JSON anche alla cascata', () => {
  const faqSource = readFileSync(new URL('../scripts/batch-add-faq-to-articles.mjs', import.meta.url), 'utf8');
  assert.equal(
    (faqSource.match(/jsonMode: true, jsonTopLevelType: 'array'/g) || []).length,
    2,
    'generazione FAQ e top-up devono dichiarare entrambe l’array atteso',
  );

  const topicSource = readFileSync(new URL('../scripts/lib/article-topic-selector.mjs', import.meta.url), 'utf8');
  assert.match(topicSource, /jsonMode: true,\s*jsonTopLevelType: 'array'/);
});
