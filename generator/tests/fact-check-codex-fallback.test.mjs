/**
 * fact-check-codex-fallback.test.mjs — Codex Luna Max as the last verifier.
 *
 * Owner decision of 2026-09-25: «se i verificatori non funzionano usa codex
 * luna Max senza secondo parere». When the free verifiers give no verdict, or
 * no independent second opinion, llmFactCheck asks Codex, pinned to that one
 * model (`codexOnly` in _runSingleFactCheck → `chain: [codex], prefer:
 * [codex]`). create-article.mjs cannot be imported by a test (network call at
 * module scope), so the wiring is read from its source; the call itself runs
 * through the real callLLM against a fake broker socket, the same pattern as
 * codex-cli-json-request.test.mjs.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { AI_MODELS, callLLM, resetState } from '../scripts/lib/ai-models.mjs';
import { extractFactCheckJson } from '../scripts/lib/fact-check-response.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');
const CODEX = AI_MODELS.CODEX_CLI_PRIMARY;

// The options _runSingleFactCheck builds for the Codex fallback, minus the
// run clock (deadlineMs) and the cache flag, which do not change the route.
function codexOnlyOptions(modelUsedRef) {
  return {
    model: CODEX,
    temperature: 0.0,
    maxTokens: 4000,
    timeout: 60_000,
    bypassForceChain: true,
    modelUsedRef,
    jsonMode: true,
    chain: [CODEX],
    prefer: [CODEX],
    recordScore: false,
  };
}

describe('the call is pinned to Codex', () => {
  const ENV_KEYS = ['CODEX_AUTH_BROKER_SOCKET', 'ENABLE_CODEX_ARTICLE_FALLBACK', 'AI_MODELS_PREFER', 'AI_MODELS_SCHEMA_MODE'];
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let server;
  let root;
  let requests;
  let reply;
  let originalFetch;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fact-check-'));
    const socketPath = path.join(root, 'auth.sock');
    requests = [];
    reply = '{"verdict":"FAIL","confidence":0.9,"issues":[{"claim":"x","reason":"non in fonte","severity":"critical","category":"fatti_inventati"}]}';
    server = net.createServer({ allowHalfOpen: true }, (client) => {
      let buffer = '';
      client.setEncoding('utf8');
      client.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        requests.push(JSON.parse(buffer.slice(0, newline)));
        client.end(`${JSON.stringify({ ok: true, result: reply })}\n`);
      });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    process.env.CODEX_AUTH_BROKER_SOCKET = socketPath;
    process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '1';
    delete process.env.AI_MODELS_SCHEMA_MODE;
    // Any HTTP provider reached would be a leak out of the pinned chain.
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => { throw new Error(`network call outside the pinned chain: ${url}`); };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetState();
  });

  test('Codex answers the verdict, and the reply reads as one vote', async () => {
    const modelUsedRef = { model: null };
    const raw = await callLLM([{ role: 'user', content: 'Verifica questo articolo. Rispondi SOLO in JSON valido.' }], codexOnlyOptions(modelUsedRef));
    assert.equal(requests.length, 1);
    assert.match(requests[0].prompt, /Return exactly one valid JSON object/);
    assert.equal(modelUsedRef.model, CODEX);
    const { result, error } = extractFactCheckJson(raw);
    assert.equal(error, null);
    assert.equal(result.verdict, 'FAIL');
  });

  test('an AI_MODELS_PREFER for another model does not slip in front of Codex', async () => {
    process.env.AI_MODELS_PREFER = 'nvidia/google/gemma-4-31b-it';
    const modelUsedRef = { model: null };
    await callLLM([{ role: 'user', content: 'Verifica.' }], codexOnlyOptions(modelUsedRef));
    assert.equal(modelUsedRef.model, CODEX);
    assert.equal(requests.length, 1);
  });

  test('with the lane off the call fails without walking the free cascade', async () => {
    process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '0';
    await assert.rejects(
      callLLM([{ role: 'user', content: 'Verifica.' }], codexOnlyOptions({ model: null })),
      (error) => error?.code === 'ALL_MODELS_EXHAUSTED'
        && error.message.includes(`Chain: [${CODEX}]`),
    );
    assert.equal(requests.length, 0);
  });
});

describe('llmFactCheck wiring', () => {
  const start = SRC.indexOf('// ── Codex Luna Max when the free verifiers are not enough ──');
  const failClosed = SRC.indexOf('if (modelResults.length === 0 || lacksSecondOpinion) {', start);
  const block = SRC.slice(start, failClosed);

  test('Codex is asked after the free verifiers and before the article is discarded', () => {
    assert.notEqual(start, -1, 'blocco Codex sparito');
    assert.ok(failClosed > start, 'il blocco Codex deve precedere il fail-closed');
    assert.ok(SRC.indexOf('const modelsToQuery = verificationModels.slice(0, 2);') < start, 'Codex non deve precedere i verificatori free');
    // Fewer than two votes: none at all, one verifier failed, or the two
    // collapsed into one model (review of PR #1871: the plain failure was
    // left out and a single free PASS published the article).
    assert.match(block, /if \(modelResults\.length < 2 && isModelAvailable\(AI_MODELS\.CODEX_CLI_PRIMARY\)\) \{/);
    assert.match(block, /await _runSingleFactCheck\(codex, prompt, \{ isEvergreen, codexOnly: true \}\)/);
  });

  test('its verdict is one vote like any other', () => {
    assert.doesNotMatch(block, /modelResults\.push\(/, 'il voto di Codex deve passare da addIndependentVote');
    assert.match(block, /if \(vote\) addIndependentVote\(modelResults, codex, vote\);/);
    // After Codex, one vote decides only when it is Codex's own.
    assert.match(SRC.slice(failClosed - 300, failClosed), /const lacksSecondOpinion = modelResults\.length === 1 && modelResults\[0\]\.servedBy !== AI_MODELS\.CODEX_CLI_PRIMARY;/);
  });

  test('the call line pins the chain to Codex only for the fallback', () => {
    const line = SRC.split('\n').find((l) => l.includes('buildFactCheckCallOptions({ model,'));
    assert.match(line, /\.\.\.\(opts\.codexOnly \? \{ chain: \[model\], prefer: \[model\] \} : \{\}\)/);
  });

  test('the log says when Codex verifies the article it wrote', () => {
    assert.match(block, /_codexWroteThisHeadline \? ' — ha scritto anche questo articolo: si verifica da solo \(decisione del proprietario\)' : ''/);
    assert.match(SRC, /if \(modelUsedRef\.model === AI_MODELS\.CODEX_CLI_PRIMARY\) _codexWroteThisHeadline = true;/);
    assert.match(SRC, /_localFallbackUsedThisHeadline = false;\n\s+_codexWroteThisHeadline = false;/);
  });
});
