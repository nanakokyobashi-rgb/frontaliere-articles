/**
 * fact-check-codex-fallback.test.mjs — Codex Luna Max as the primary verifier.
 *
 * Owner decision of 2026-10-06: Codex is first in the primary pair. When the
 * broker is unavailable, its circuit opens, or the primary request gives no
 * vote, llmFactCheck keeps the explicit one-model Codex fallback
 * (`codexOnly` → `chain: [codex], prefer: [codex]`). create-article.mjs cannot
 * be imported by a test (network call at module scope), so the wiring is read
 * from its source; the call itself runs through real callLLM against a fake
 * broker socket, the same pattern as codex-cli-json-request.test.mjs.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { AI_MODELS, callLLM, estimateRequestTokens, resetState } from '../scripts/lib/ai-models.mjs';
import { addIndependentVote, extractFactCheckJson } from '../scripts/lib/fact-check-response.mjs';
import { FACT_CHECK_CATEGORIES } from '../scripts/lib/article-factuality-gates.mjs';
import { cantonPromptLines } from '../scripts/lib/canton-section-profile.mjs';
import { extractSyntheticReferenceEvidence } from '../scripts/lib/editorial-originality.mjs';
import * as taxRates from '../scripts/lib/irpef-scaglioni.mjs';
import { JSON_QUOTE_SAFETY_RULE_IT } from '../scripts/lib/llm-json-repair.mjs';

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
  const ENV_KEYS = ['CODEX_AUTH_BROKER_SOCKET', 'ENABLE_CODEX_ARTICLE_FALLBACK', 'AI_MODELS_PREFER', 'AI_MODELS_SCHEMA_MODE', 'NVIDIA_API_KEY'];
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
    reply = '{"verdict":"FAIL","confidence":0.9,"editorialAssessment":{"classification":"unsupported_inference","finding":"La frase attribuisce alla fonte un fatto non supportato e cita una prova verificabile.","articleQuote":"La nostra redazione ha intervistato i residenti in Comune e ha verificato sul posto il cambiamento.","evidenceQuotes":["Il Comune ha registrato 120 domande di rinnovo nel 2024 e 156 nel 2025."]},"issues":[{"claim":"x","reason":"non in fonte","severity":"critical","category":"fatti_inventati"}]}';
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

  test('a fallback verdict cached under the answering model retains provenance', async () => {
    const model = 'nvidia/meta/llama-3.1-8b-instruct';
    const messages = [{ role: 'user', content: 'Verifica. Rispondi in JSON.' }];
    process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '0';
    process.env.NVIDIA_API_KEY = 'dummy-per-test';
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return Response.json({ choices: [{ message: { content: '{}' } }] });
    };
    const options = { ...codexOnlyOptions({}), chain: [CODEX, model], cache: true };
    const raw = await callLLM(messages, options);
    const modelUsedRef = {};
    const cached = await callLLM(messages, { ...options, model, modelUsedRef });
    assert.equal(cached, raw);
    assert.equal(requests, 1);
    assert.deepEqual(modelUsedRef, { model: 'cache', cachedServedBy: model });
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
  const start = SRC.indexOf('// ── Codex Luna Max safety fallback when the primary vote is missing ──');
  const failClosed = SRC.indexOf('if (modelResults.length === 0 || lacksSecondOpinion) {', start);
  const block = SRC.slice(start, failClosed);

  test('Codex is first, with a safe fallback before the article is discarded', () => {
    assert.notEqual(start, -1, 'blocco Codex sparito');
    assert.ok(failClosed > start, 'il blocco Codex deve precedere il fail-closed');
    const candidates = SRC.indexOf('const verificationCandidates = [');
    const codex = SRC.indexOf('AI_MODELS.CODEX_CLI_PRIMARY', candidates);
    const firstIndependent = SRC.indexOf('AI_MODELS.GROQ_GPT_OSS_120B', candidates);
    assert.ok(candidates >= 0 && candidates < start, 'candidati Codex non dichiarati prima del fallback');
    assert.ok(codex >= candidates && codex < firstIndependent, 'Codex non è il primo verificatore');
    assert.ok(SRC.indexOf('const modelsToQuery = verificationModels.slice(0, 2);') < start);
    // If the primary lane gives no vote, do not publish an article with a
    // single free opinion (review of PR #1871).
    assert.match(block, /if \(modelResults\.length < 2 && !codexAlreadyVoted && isModelAvailable\(AI_MODELS\.CODEX_CLI_PRIMARY\)\) \{/);
    assert.match(block, /editorialProofFailures\.size/);
    assert.match(block, /await _runSingleFactCheck\(codex, retryPrompt, \{ isEvergreen: isEvergreenArticle, editorialContext, codexOnly: true, deadlineMs: factCheckDeadlineMs \}\)/);
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


test('an infrastructure retry keeps a validated vote and seeks a different serving model', async () => {
  const start = SRC.indexOf('  const modelResults = [];', SRC.indexOf('const verificationCandidates = ['));
  const end = SRC.indexOf('  // ── Codex Luna Max safety fallback', start);
  assert.ok(start >= 0 && end > start);
  const votes = [
    { verdict: 'PASS', confidence: 0.9, issues: [], servedBy: 'first-serving-model' },
    null,
    null,
    { verdict: 'FAIL', confidence: 0.9, issues: [], servedBy: 'second-serving-model' },
  ];
  const calls = [];
  let now = 160_000;
  const result = await runInNewContext(`(async () => {
    ${SRC.slice(start, end)}
    return modelResults;
  })()`, {
    AI_MODELS,
    Date: { now: () => now },
    RUN_START_MS: 0,
    RUN_WALL_BUDGET_MS: 240_000,
    addIndependentVote,
    console: { error() {} },
    editorialContext: {},
    isEvergreenArticle: false,
    prompt: 'same article',
    compactPrompt: null,
    estimateRequestTokens,
    safeSignalDiagnosticTextForLog: String,
    setTimeout: (callback, delay) => { now += delay; callback(); },
    verificationModels: [CODEX, AI_MODELS.GROQ_GPT_OSS_120B],
    async _runSingleFactCheck(model, prompt, options) {
      calls.push({ model, prompt, options, now });
      const vote = votes.shift() ?? null;
      if (!vote) now = options.deadlineMs;
      return vote;
    },
  });
  assert.deepEqual(Array.from(result, ({ verdict, servedBy }) => [verdict, servedBy]), [
    ['PASS', 'first-serving-model'],
    ['FAIL', 'second-serving-model'],
  ]);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].prompt, 'same article');
  assert.equal(calls[3].options.fresh, true);
  assert.equal(calls[0].options.deadlineMs, 175_000);
  assert.equal(calls[2].options.deadlineMs, 175_000);
  assert.ok(calls[3].options.deadlineMs > calls[3].now);
  assert.ok(calls[3].options.deadlineMs < 220_000);
  assert.ok(calls[3].options.excludeModels.includes('first-serving-model'));
});

describe('fact-check retries under a reported input cap', () => {
  const start = SRC.indexOf('const MAX_FACTCHECK_ARTICLE_CHARS =');
  const end = SRC.indexOf('  // ── Codex Luna Max safety fallback', start);
  const factsStart = SRC.indexOf('const VERIFIED_DOMAIN_FACTS =');
  const factsEnd = SRC.indexOf('\n`;', factsStart) + '\n`;'.length;
  const domainFacts = runInNewContext(
    `${SRC.slice(factsStart, factsEnd)}\nVERIFIED_DOMAIN_FACTS`,
    { ...taxRates },
  );
  const sourceEnd = 'La serie della fonte termina a settembre.';
  const source = 'Il Comune ha pubblicato i conteggi trimestrali delle domande di rinnovo. '.repeat(78) + sourceEnd;
  const cantonFacts = 'Il riferimento annuale cantonale riporta le soglie del 2026.';
  const bodyEnd = 'Il confronto del corpo termina con il terzo trimestre.';
  const firstVote = { verdict: 'PASS', servedBy: 'first-serving-model' };
  const secondVote = { verdict: 'PASS', servedBy: 'second-serving-model' };
  const capError = (cap) => Object.assign(new Error('verificatori esauriti'), {
    code: 'ALL_MODELS_EXHAUSTED',
    retryRequestTokenBudget: cap,
  });
  const estimate = (content) => estimateRequestTokens([{ role: 'user', content }]);

  async function runRounds({
    canton = 'San Gallo', section = 'san-gallo', isCanton = true, isFrontaliere = false,
    sourceUrl = 'HTTPS://example.test/news', sourceText = source, padding = '', replies,
  }) {
    const calls = [];
    const logs = [];
    let now = 160_000;
    const cantonLines = cantonPromptLines({ cantonName: canton, section });
    const result = await runInNewContext(`
      ${SRC.slice(start, end)}
        return { modelResults, prompt, compactPrompt, editorialContext };
      }
      llmFactCheck({ body1: padding, body3: bodyEnd }, sourceText, sourceUrl, cantonFacts);
    `, {
      ...taxRates,
      Date: { now: () => now },
      RUN_START_MS: 0,
      RUN_WALL_BUDGET_MS: 240_000,
      console: { error: (message) => logs.push(message) },
      setTimeout: (callback, delay) => { now += delay; callback(); },
      AI_MODELS,
      addIndependentVote,
      estimateRequestTokens,
      isModelAvailable: () => true,
      safeSignalDiagnosticTextForLog: String,
      CANTON_LINES: cantonLines,
      IS_CANTON: isCanton,
      IS_FRONTALIERE: isFrontaliere,
      SECTION_NAME: section,
      CANTON_FACTS_BRIEF: '',
      evergreenFactsBriefFor: () => '',
      extractSyntheticReferenceEvidence,
      VERIFIED_DOMAIN_FACTS: domainFacts,
      JSON_QUOTE_SAFETY_RULE_IT,
      FACT_CHECK_CATEGORIES,
      bodyEnd,
      cantonFacts,
      padding,
      sourceText,
      sourceUrl,
      async _runSingleFactCheck(model, prompt, options) {
        assert.ok(calls.length < replies.length, 'chiamata di verifica inattesa');
        const reply = replies[calls.length];
        calls.push({ model, prompt, options });
        if (reply instanceof Error) throw reply;
        return reply;
      },
    });
    return { ...result, calls, logs, cantonLines };
  }

  async function loadFor(target, locale = {}) {
    const { prompt } = await runRounds({ ...locale, replies: [firstVote, secondVote] });
    const filler = 'Il registro mensile contiene una riga per ogni domanda. '.repeat(300);
    let chars = 0;
    while (chars < filler.length && estimate(prompt + filler.slice(0, chars)) < target) chars += 7;
    assert.ok(chars > 0 && chars <= filler.length);
    return filler.slice(0, chars);
  }

  for (const { target, cap, canton, section } of [
    { target: 7874, cap: 7000, canton: 'San Gallo', section: 'san-gallo' },
    { target: 8318, cap: 8000, canton: 'Lucerna', section: 'lucerna' },
  ]) {
    test(`recupera il secondo voto con carico ${target} e tetto ${cap}`, async () => {
      const locale = { canton, section };
      const padding = await loadFor(target, locale);
      const { calls, logs, modelResults, prompt, compactPrompt, editorialContext, cantonLines } = await runRounds({
        ...locale,
        padding,
        replies: [firstVote, capError(cap), capError(cap - 1000), secondVote],
      });
      const fullEstimate = estimate(prompt);
      const compactEstimate = estimate(compactPrompt);
      assert.ok(Math.abs(fullEstimate - target) <= 3);
      assert.ok(fullEstimate > cap);
      assert.ok(fullEstimate - compactEstimate >= 874);
      assert.ok(compactEstimate <= cap);

      assert.deepEqual(calls.map((call) => call.prompt), [prompt, prompt, prompt, compactPrompt]);
      assert.equal(calls[3].options.editorialContext, editorialContext);
      assert.ok(calls[3].options.excludeModels.includes(firstVote.servedBy));
      assert.deepEqual(Array.from(modelResults, ({ servedBy }) => servedBy), [firstVote.servedBy, secondVote.servedBy]);

      const evidenceEnd = (text) => text.indexOf('VERIFICA SISTEMATICA');
      const proofStart = (text) => text.indexOf('═══ VALUTAZIONE EDITORIALE E PROVE (OBBLIGATORIA) ═══');
      const evidence = compactPrompt.slice(0, evidenceEnd(compactPrompt));
      assert.equal(evidence, prompt.slice(0, evidenceEnd(prompt)));
      assert.ok(evidence.includes(bodyEnd));
      assert.ok(evidence.includes(source));
      assert.ok(evidence.includes(`${sourceEnd}\n"""`));
      assert.ok(evidence.includes('LAMAL non è "tassa sulla salute"'));
      assert.ok(evidence.includes(domainFacts));
      assert.ok(evidence.includes(cantonFacts));
      const instructions = compactPrompt.slice(evidenceEnd(compactPrompt), proofStart(compactPrompt));
      assert.match(instructions, /Consiglieri federali attuali: Baume-Schneider, Parmelin, Cassis, Keller-Sutter, Pfister, Jans, Rösti\./);
      assert.doesNotMatch(instructions, /\bAmherd\b/);
      assert.match(instructions, /critical:istituzioni: FINMA è autorità per mercati finanziari\/banche, NON per ospedali\/sanità/);
      assert.match(instructions, /senza riscontro nella fonte: critical:fatti_inventati/);
      assert.match(instructions, /infermiera segnala carenze igieniche a Lugano/);
      assert.match(instructions, /medico denuncia pratiche non etiche a Chiasso/);
      assert.match(instructions, /infermiere ORL ottiene un risarcimento/);
      assert.match(instructions, /medico del Civico di Lugano denuncia frode con indagine FINMA/);
      assert.match(instructions, /sigle inventate \(DEMAS, LCFL, CFL\)/);
      assert.match(instructions, /"LProtInfo del 2023" \(inesistente — è art\. 321a CO\)/);
      assert.match(instructions, /"LPAP del 2000" \(è LPers, non LPAP\)/);
      const suffix = compactPrompt.slice(proofStart(compactPrompt));
      assert.equal(suffix, prompt.slice(proofStart(prompt)));
      assert.match(suffix, /"articleQuote".*"citazione esatta/);
      assert.match(suffix, /"evidenceQuotes"/);
      assert.match(suffix, /"sourceQuote"/);
      const relevance = cantonLines.factCheckRelevance(false);
      assert.ok(prompt.includes(`\n\n${relevance}\n\n${suffix}`));
      assert.ok(compactPrompt.includes(`\n\n${relevance}\n\n${suffix}`));
      assert.deepEqual(logs.filter((line) => line.includes('istruzioni compatte')), [
        `  🔁 Fact-check: istruzioni compatte, input stimato ${fullEstimate} → ${compactEstimate} token (tetto ${cap})`,
      ]);
    });
  }

  for (const [label, error] of [
    ['outage senza tetto strutturato', Object.assign(new Error('verificatori indisponibili (429)'), { code: 'ALL_MODELS_EXHAUSTED' })],
    ['tetto insufficiente', capError(5000)],
    ['tetto testuale', capError('7000')],
    ['tetto frazionario', capError(7000.5)],
  ]) {
    test(`mantiene il prompt pieno con ${label}`, async () => {
      const padding = await loadFor(7874);
      const { calls, logs, prompt, compactPrompt } = await runRounds({
        padding,
        replies: [error, error, firstVote, secondVote],
      });
      assert.ok(estimate(compactPrompt) > 5000);
      assert.deepEqual(calls.map((call) => call.prompt), Array(4).fill(prompt));
      assert.ok(logs.every((line) => !line.includes('istruzioni compatte')));
    });
  }

  test('mantiene la forma compatta nei round successivi e annuncia una sola volta', async () => {
    const padding = await loadFor(7874);
    const outage = new Error('verificatori indisponibili');
    const { calls, logs, prompt, compactPrompt } = await runRounds({
      padding,
      replies: [capError(7000), outage, outage, outage, firstVote, secondVote],
    });
    assert.deepEqual(calls.map((call) => call.prompt), [prompt, prompt, ...Array(4).fill(compactPrompt)]);
    assert.equal(logs.filter((line) => line.includes('istruzioni compatte')).length, 1);
  });

  test('un tetto rilevato solo all’ultimo round non produce un altro tentativo', async () => {
    const padding = await loadFor(7874);
    const outage = new Error('verificatori indisponibili');
    const { calls, logs, prompt } = await runRounds({
      padding,
      replies: [outage, outage, outage, outage, capError(7000), capError(7000)],
    });
    assert.deepEqual(calls.map((call) => call.prompt), Array(6).fill(prompt));
    assert.ok(logs.every((line) => !line.includes('istruzioni compatte')));
  });

  for (const [section, isFrontaliere] of [['svizzera', false], ['frontaliere', true]]) {
    test(`recupera il consenso nella sezione ${section} sotto il tetto di 8000 token`, async () => {
      const scope = { section, isCanton: false, isFrontaliere };
      const padding = await loadFor(8803, scope);
      const { calls, modelResults, prompt, compactPrompt } = await runRounds({
        ...scope,
        padding,
        replies: [firstVote, capError(8000), capError(8000), secondVote],
      });
      assert.ok(estimate(prompt) > 8000);
      assert.ok(estimate(compactPrompt) <= 8000);
      assert.ok(compactPrompt.includes(bodyEnd));
      assert.ok(compactPrompt.includes(isFrontaliere ? 'RILEVANZA TOPICA AL FRONTALIERE' : 'RILEVANZA'));
      assert.deepEqual(calls.map((call) => call.prompt), [prompt, prompt, prompt, compactPrompt]);
      assert.equal(modelResults.length, 2);
    });
  }

  for (const [label, scope] of [
    ['fonte non HTTP', { sourceUrl: 'file:///fixture' }],
    ['evergreen', { sourceText: 'Riferimento breve.' }],
    ['dataset BFS', { sourceUrl: 'stats-bfs://fixture' }],
    ['dataset ASTRA', { sourceUrl: 'stats-astra://fixture' }],
  ]) {
    test(`la forma compatta è assente per ${label}`, async () => {
      const { calls, prompt, compactPrompt } = await runRounds({
        ...scope,
        replies: [capError(1000), capError(1000), firstVote, secondVote],
      });
      assert.equal(compactPrompt, null);
      assert.deepEqual(calls.map((call) => call.prompt), Array(4).fill(prompt));
    });
  }
});
