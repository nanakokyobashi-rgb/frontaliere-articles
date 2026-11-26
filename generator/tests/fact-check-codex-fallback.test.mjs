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
import { MIN_EDITORIAL_ARTICLE_ANCHORS, extractSyntheticReferenceEvidence, validateEditorialAssessment } from '../scripts/lib/editorial-originality.mjs';
import * as taxRates from '../scripts/lib/irpef-scaglioni.mjs';
import { JSON_QUOTE_SAFETY_RULE_IT } from '../scripts/lib/llm-json-repair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');
const CODEX = AI_MODELS.CODEX_CLI_PRIMARY;
const proofRetryStart = SRC.indexOf('function buildFactCheckProofRetryPrompt(');
const proofRetryEnd = SRC.indexOf('\n}', proofRetryStart);
assert.ok(proofRetryStart >= 0 && proofRetryEnd > proofRetryStart);
const buildFactCheckProofRetryPrompt = runInNewContext(
  '(' + SRC.slice(proofRetryStart, proofRetryEnd + 2) + ')',
);
const missingSourceQuote = 'manca una citazione esatta della fonte o di un riferimento verificato che sostenga l’analisi';

test('independent fact-check retries a missing verdict inside its original window', async () => {
  const start = SRC.indexOf('async function _runSingleFactCheck(');
  const end = SRC.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const check = runInNewContext(`(${SRC.slice(start, end + 2)})`, {
    AI_MODELS,
    Date: { now: () => 1_000 },
    console: { error() {} },
    extractFactCheckJson,
    isFactCheckCacheEnabled: () => true,
    buildFactCheckCallOptions: (options, cache) => ({ ...options, cache }),
    factCheckRawSnippet: (raw) => raw,
    safeSignalDiagnosticTextForLog: (value) => value,
    normalizeFactCheckIssues: (issues) => issues,
    validateEditorialAssessment: () => ({ verifiable: true }),
    async _aiCallLLM(_messages, options) {
      calls.push(options);
      options.modelUsedRef.model = calls.length === 1 ? 'first-free' : 'second-free';
      return calls.length === 1 ? '{}' : '{"verdict":"PASS","issues":[]}';
    },
  });
  const result = await check('free-primary', 'verify', {
    deadlineMs: 17_000,
    excludeModels: [CODEX],
    invalidVerdictModels: new Set(),
    retryInvalidVerdict: true,
  });
  assert.equal(result.servedBy, 'second-free');
  assert.equal(calls.length, 2);
  assert.deepEqual(Array.from(calls[1].excludeModels), [CODEX, 'first-free']);
  assert.equal(calls[1].deadlineMs, calls[0].deadlineMs);
  assert.equal(calls[1].cache, false);
});


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

test('fact-check rounds share the cutoff that leaves time for translation', () => {
  const start = SRC.indexOf('  const remainingAtFactCheckMs =');
  const end = SRC.indexOf('  // Cap on retry-after', start);
  const deadline = (now, preTranslationDeadlineMs = Infinity) => runInNewContext(
    `${SRC.slice(start, end)}\nfactCheckDeadlineMs`,
    { runDeadlineMs: 300_000, preTranslationDeadlineMs, Date: { now: () => now } },
  );
  assert.equal(deadline(40_000, 120_000), 120_000);
  assert.equal(deadline(115_000, 120_000), 120_000);
  assert.equal(deadline(125_000, 120_000), 120_000);
  assert.equal(deadline(115_000), 253_750);
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
    const primaryPair = SRC.indexOf('const primaryModels = verificationModels.slice(0, 2);', candidates);
    assert.ok(primaryPair > firstIndependent && primaryPair < start, 'le due preferenze primarie devono precedere il fallback');
    // If the primary lane gives no vote, do not publish an article with a
    // single free opinion (review of PR #1871).
    assert.match(block, /if \(modelResults\.length < 2 && !codexAlreadyVoted && isModelAvailable\(AI_MODELS\.CODEX_CLI_PRIMARY\)\) \{/);
    assert.match(block, /const retryPrompt = buildFactCheckProofRetryPrompt\(prompt, editorialProofFailures\);/);
    assert.match(block, /await _runSingleFactCheck\(codex, retryPrompt, \{ isEvergreen: isEvergreenArticle, editorialContext, codexOnly: true, deadlineMs: factCheckDeadlineMs \}\)/);
  });

  test('the last verifier receives the failed proof requirement only when recorded', async () => {
    const secondReason = 'la valutazione editoriale non usa una classificazione ammessa';
    const prompt = 'Testo da verificare';
    const editorialContext = { articleBody: 'Corpo', evidenceText: 'Fonte' };
    for (const failures of [[], [missingSourceQuote, secondReason]]) {
      const calls = [];
      await runInNewContext(`(async () => { ${block} })()`, {
        AI_MODELS: { CODEX_CLI_PRIMARY: 'codex' },
        isModelAvailable: () => true,
        _codexWroteThisHeadline: false,
        isEvergreenArticle: false,
        factCheckDeadlineMs: 1000,
        modelResults: [],
        console: { error: () => {} },
        buildFactCheckProofRetryPrompt,
        editorialProofFailures: new Set(failures),
        prompt,
        editorialContext,
        _runSingleFactCheck: (...args) => { calls.push(args); return null; },
      });
      assert.equal(calls.length, 1);
      const [model, retryPrompt, options] = calls[0];
      assert.equal(model, 'codex');
      assert.equal(options.editorialContext, editorialContext);
      assert.equal(options.deadlineMs, 1000);
      assert.equal(options.codexOnly, true);
      if (failures.length) {
        assert.equal(retryPrompt, prompt + '\n\nCONTROLLO DELLE PROVE PRIMA DI INVIARE IL JSON:\n'
          + `I verdetti precedenti sono stati scartati per questi requisiti: ${missingSourceQuote} | ${secondReason}.\n`
          + 'Prima scegli e copia i passaggi esatti dai blocchi forniti, poi formula il giudizio in base a quei passaggi.');
      } else {
        assert.equal(retryPrompt, prompt);
      }
    }
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


describe('infrastructure retries with a retained vote', () => {
  const start = SRC.indexOf('  const modelResults = [];', SRC.indexOf('const verificationCandidates = ['));
  const end = SRC.indexOf('  // An original editorial contribution', start);
  const groq = AI_MODELS.GROQ_GPT_OSS_120B;
  const editorialContext = { articleBody: 'Corpo sintetico', evidenceText: 'Fonte sintetica' };
  const prompt = 'same article';

  async function runRounds(firstServingModel, respond, initialTime = 130_000) {
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const logs = [];
    let now = initialTime;
    const result = await runInNewContext(`(async () => {
      ${SRC.slice(start, end)}
      return { votes: modelResults };
    })()`, {
      AI_MODELS,
      Date: { now: () => now },
      RUN_START_MS: 0,
      RUN_WALL_BUDGET_MS: 240_000,
      preTranslationDeadlineMs: Infinity,
      addIndependentVote,
      console: { error: (message) => logs.push(message) },
      editorialContext,
      isEvergreenArticle: false,
      isModelAvailable: () => true,
      _codexWroteThisHeadline: false,
      remediationSourceText: '',
      isSharedTransientFactCheckRosterOutage: () => false,
      prompt,
      compactPrompt: null,
      buildFactCheckProofRetryPrompt,
      estimateRequestTokens,
      safeSignalDiagnosticTextForLog: String,
      setTimeout: (callback, delay) => { now += delay; callback(); },
      verificationModels: [CODEX, groq],
      async _runSingleFactCheck(model, prompt, options) {
        calls.push({ model, prompt, options, now });
        if (calls.length === 2 && model === groq) {
          return { verdict: 'PASS', confidence: 0.9, issues: [], servedBy: firstServingModel };
        }
        const servedBy = respond(model, options, now);
        if (servedBy) return { verdict: 'FAIL', confidence: 0.9, issues: [], servedBy };
        // The parallel Codex call and first recovery consume the round's budget.
        if (calls.length <= 3 || options.codexOnly) now = options.deadlineMs;
        throw new Error('synthetic broker timeout');
      },
    });
    for (const call of calls) {
      assert.equal(call.prompt, prompt);
      assert.equal(call.options.editorialContext, editorialContext);
    }
    assert.ok(logs.some((line) => line.includes('synthetic broker timeout')));
    return { result, calls, logs };
  }

  test('the retained vote gets a fresh Groq-first retry after Codex times out', async () => {
    const first = 'first-serving-model';
    const second = 'second-serving-model';
    const { result, calls } = await runRounds(first, (model, options, now) => (
      model === groq && options.fresh && now < options.deadlineMs
        && options.excludeModels.includes(first) && options.excludeModels.includes(CODEX) ? second : null
    ));
    assert.deepEqual(calls.map(({ model }) => model), [CODEX, groq, CODEX, groq]);
    assert.deepEqual(calls.map(({ options }) => options.fresh), [false, false, undefined, true]);
    assert.deepEqual(calls.slice(0, 3).map(({ options }) => options.deadlineMs), [147_500, 147_500, 147_500]);
    assert.deepEqual(Array.from(calls[3].options.excludeModels), [first, CODEX]);
    assert.equal(calls[3].options.invalidVerdictModels, calls[0].options.invalidVerdictModels);
    assert.ok(calls[3].options.deadlineMs > calls[3].now);
    assert.ok(calls[3].options.deadlineMs < 220_000);
    assert.deepEqual(Array.from(result.votes, ({ verdict, servedBy }) => [verdict, servedBy]), [
      ['PASS', first],
      ['FAIL', second],
    ]);
  });

  test('an initially timed-out verifier can recover a distinct vote within the same round', async () => {
    const first = 'first-serving-model';
    const second = 'second-serving-model';
    const { result, calls, logs } = await runRounds(first, (model, options, now) => (
      model === CODEX && options.excludeModels.includes(first) && now < options.deadlineMs
        ? second : null
    ), 0);
    assert.deepEqual(calls.map(({ model }) => model), [CODEX, groq, CODEX]);
    assert.equal(calls[2].now, 35_000);
    assert.equal(calls[2].options.deadlineMs, 50_000);
    assert.deepEqual(Array.from(result.votes, ({ servedBy }) => servedBy), [first, second]);
    assert.ok(!logs.some((line) => line.includes('un solo parere indipendente')));
  });

  test('a long verification budget reserves extra time for the last Codex call', async () => {
    const { calls } = await runRounds(groq, () => null, 0);
    // 240s total, 60s for post-check work, 30s for final verification and
    // three 50s rounds, each with a 15s recovery window.
    assert.equal(calls[0].options.deadlineMs, 35_000);
    assert.equal(calls[2].now, 35_000);
    assert.equal(calls[2].options.deadlineMs, 50_000);
    assert.equal(calls.at(-1).options.codexOnly, true);
    assert.equal(calls.at(-1).options.deadlineMs, 180_000);
  });

  test('a retained vote leaves thirty seconds for final Codex verification when time is tight', async () => {
    const { calls } = await runRounds('groq/openai/gpt-oss-20b', () => null, 160_000);
    const final = calls.at(-1);
    assert.equal(final.options.codexOnly, true);
    assert.equal(final.options.deadlineMs, 220_000);
    assert.ok(final.options.deadlineMs - final.now >= 30_000);
  });

  test('requires the full 45-second initial window before reserving final Codex time', async () => {
    const atThreshold = await runRounds('groq/openai/gpt-oss-20b', () => null, 180_000);
    const thresholdFinal = atThreshold.calls.at(-1);
    assert.equal(thresholdFinal.options.codexOnly, true);
    assert.equal(thresholdFinal.options.deadlineMs - thresholdFinal.now, 30_000);

    const belowThreshold = await runRounds('groq/openai/gpt-oss-20b', () => null, 181_000);
    const belowFinal = belowThreshold.calls.at(-1);
    assert.equal(belowFinal.options.codexOnly, true);
    assert.ok(belowFinal.options.deadlineMs - belowFinal.now < 30_000);
  });

  test('a serving Groq vote leaves no unused preference for immediate recovery', async () => {
    const { result, calls } = await runRounds(groq, () => null, 150_000);
    const retries = calls.slice(3, -1);
    assert.ok(retries.length > 0);
    assert.equal(new Set(retries.map(({ options }) => options.deadlineMs)).size, retries.length);
    for (const { model, options } of retries) {
      assert.equal(model, CODEX);
      assert.equal(options.fresh, true);
      assert.deepEqual(Array.from(options.excludeModels), [groq]);
    }
    assert.equal(calls.at(-1).model, CODEX);
    assert.equal(calls.at(-1).options.codexOnly, true);
    assert.equal(result.passed, false);
    assert.equal(result.unverified, true);
    assert.match(result.issues[0].reason, /Un solo verificatore/);
  });

  test('failed Groq-first retry recovers once through fresh Codex on the same deadline', async () => {
    const first = 'first-serving-model';
    const { result, calls } = await runRounds(first, (model, options, now) => (
      model === CODEX && options.fresh && now < options.deadlineMs ? CODEX : null
    ));
    assert.deepEqual(calls.map(({ model }) => model), [CODEX, groq, CODEX, groq, CODEX]);
    assert.equal(calls[3].options.fresh, true);
    assert.equal(calls[4].options.fresh, true);
    assert.equal(calls[4].options.deadlineMs, calls[3].options.deadlineMs);
    assert.deepEqual(Array.from(calls[4].options.excludeModels), [first]);
    assert.deepEqual(Array.from(result.votes, ({ servedBy }) => servedBy), [first, CODEX]);
  });
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
    initialTime = 130_000, consumeWindow = false, declaredInputCap,
  }) {
    const calls = [];
    const logs = [];
    let now = initialTime;
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
      getDeclaredRequestTokenLimit: (model) => model === AI_MODELS.GROQ_GPT_OSS_120B ? declaredInputCap : undefined,
      isModelAvailable: () => true,
      safeSignalDiagnosticTextForLog: String,
      CANTON_LINES: cantonLines,
      IS_CANTON: isCanton,
      IS_FRONTALIERE: isFrontaliere,
      SECTION_NAME: section,
      CANTON_FACTS_BRIEF: '',
      evergreenFactsBriefFor: () => '',
      MIN_EDITORIAL_ARTICLE_ANCHORS,
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
        if (consumeWindow) now = Math.max(now, options.deadlineMs);
        if (reply instanceof Error) throw reply;
        return typeof reply === 'function' ? reply(model, prompt, options) : reply;
      },
    });
    return { ...result, calls, logs, cantonLines };
  }

  const structuredReply = (hasSourceQuote) => (model, _prompt, options) => {
    const editorialAssessment = validateEditorialAssessment({
      classification: 'grounded_analysis',
      articleQuote: bodyEnd,
      finding: 'Il confronto del terzo trimestre collega la fine della serie ai conteggi comunali delle domande.',
      evidenceQuotes: hasSourceQuote ? [sourceEnd] : [],
    }, options.editorialContext);
    if (!hasSourceQuote) {
      assert.equal(editorialAssessment.verifiable, false);
      assert.equal(editorialAssessment.reason, missingSourceQuote);
      options.editorialProofFailures.add(editorialAssessment.reason);
      options.invalidVerdictModels.add(model);
      return null;
    }
    assert.equal(editorialAssessment.passed, true);
    return { verdict: 'PASS', confidence: 0.9, issues: [], servedBy: model, editorialAssessment };
  };

  test('duplicate free votes recover through a different model before using Codex again', async () => {
    const { modelResults, calls } = await runRounds({ replies: [firstVote, firstVote, secondVote] });
    assert.equal(calls[2].model, AI_MODELS.GROQ_GPT_OSS_120B);
    assert.deepEqual(Array.from(calls[2].options.excludeModels), [firstVote.servedBy, CODEX]);
    assert.deepEqual(Array.from(modelResults, ({ servedBy }) => servedBy), [
      firstVote.servedBy, secondVote.servedBy,
    ]);
  });

  test('two invalid proofs recover through independent votes in the ordinary retry', async () => {
    const reject = structuredReply(false);
    const answerWithEvidence = (model, request, options) => {
      if (!request.includes(missingSourceQuote)) return reject(model, request, options);
      return structuredReply(true)(model, request, options);
    };
    const { calls, modelResults, prompt } = await runRounds({
      replies: [reject, reject, answerWithEvidence, answerWithEvidence],
    });
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.slice(0, 2).map((call) => call.prompt), [prompt, prompt]);
    const annotated = buildFactCheckProofRetryPrompt(prompt, new Set([missingSourceQuote]));
    assert.deepEqual(calls.slice(2).map((call) => call.prompt), [annotated, annotated]);
    assert.deepEqual(Array.from(modelResults, ({ verdict, servedBy, editorialAssessment }) =>
      [verdict, servedBy, editorialAssessment.evidenceQuotes]), [
      ['PASS', CODEX, [sourceEnd]],
      ['PASS', AI_MODELS.GROQ_GPT_OSS_120B, [sourceEnd]],
    ]);
  });

  test('a compact retry preserves its evidence when the proof feedback would exceed the input cap', async () => {
    const baseline = await runRounds({ replies: [firstVote, secondVote] });
    const cap = estimate(baseline.compactPrompt);
    assert.ok(estimate(baseline.prompt) > cap);
    assert.ok(estimate(buildFactCheckProofRetryPrompt(baseline.compactPrompt, new Set([missingSourceQuote]))) > cap);

    const answer = structuredReply(true);
    const { calls, modelResults, editorialContext } = await runRounds({
      replies: [structuredReply(false), capError(cap), answer, answer],
    });
    assert.deepEqual(calls.map((call) => call.prompt), [
      baseline.prompt, baseline.prompt, baseline.compactPrompt, baseline.compactPrompt,
    ]);
    assert.deepEqual({ ...editorialContext }, { ...baseline.editorialContext });
    assert.ok(calls.every(({ options }) => options.editorialContext === editorialContext));
    assert.deepEqual(Array.from(modelResults, ({ servedBy }) => servedBy), [CODEX, AI_MODELS.GROQ_GPT_OSS_120B]);
    for (const vote of modelResults) {
      assert.equal(vote.editorialAssessment.articleQuote, bodyEnd);
      assert.deepEqual(vote.editorialAssessment.evidenceQuotes, [sourceEnd]);
    }
  });

  test('a tighter cap reported by a compact round suppresses feedback on the next retry', async () => {
    const baseline = await runRounds({ replies: [firstVote, secondVote] });
    const annotated = buildFactCheckProofRetryPrompt(baseline.compactPrompt, new Set([missingSourceQuote]));
    const initialCap = estimate(annotated);
    const tighterCap = estimate(baseline.compactPrompt);
    assert.ok(estimate(baseline.prompt) > initialCap);
    assert.ok(initialCap > tighterCap);

    const answer = structuredReply(true);
    const { calls, modelResults } = await runRounds({
      replies: [structuredReply(false), capError(initialCap), capError(tighterCap), capError(tighterCap), answer, answer],
    });
    assert.deepEqual(calls.map((call) => call.prompt), [
      baseline.prompt, baseline.prompt, annotated, annotated, baseline.compactPrompt, baseline.compactPrompt,
    ]);
    assert.deepEqual(Array.from(modelResults, ({ servedBy }) => servedBy), [CODEX, AI_MODELS.GROQ_GPT_OSS_120B]);
  });

  test('keeps a usable verification window when a 429 arrives late', async () => {
    const rateLimit = new Error('HTTP 429');
    const { calls, modelResults, logs } = await runRounds({
      initialTime: 214_000,
      replies: [rateLimit, rateLimit, rateLimit],
    });
    assert.equal(modelResults.length, 0);
    assert.ok(calls.length >= 2);
    assert.ok(calls.every(({ options }) => options.deadlineMs === 233_500));
    assert.ok(!logs.some((message) => message.includes('tentativo 2')));
  });

  test("a late 429 leaves time for the final verifier", async () => {
    const rateLimit = new Error("HTTP 429");
    const { calls } = await runRounds({
      initialTime: 180_000,
      consumeWindow: true,
      replies: [rateLimit, rateLimit, rateLimit],
    });
    assert.ok(calls.length >= 2);
    assert.ok(calls.every(({ options }) => options.deadlineMs === 195_000));
  });

  async function loadFor(target, locale = {}) {
    const { prompt } = await runRounds({ ...locale, replies: [firstVote, secondVote] });
    const filler = 'Il registro mensile contiene una riga per ogni domanda. '.repeat(300);
    let chars = 0;
    while (chars < filler.length && estimate(prompt + filler.slice(0, chars)) < target) chars += 7;
    assert.ok(chars > 0 && chars <= filler.length);
    return filler.slice(0, chars);
  }

  test('either verifier can fall through below the declared 8000-token cap on the first attempt', async () => {
    const section = { section: 'frontaliere', isFrontaliere: true, isCanton: false };
    const padding = await loadFor(9131, section);
    const { calls, prompt, compactPrompt } = await runRounds({
      ...section,
      padding,
      declaredInputCap: 8000,
      replies: [firstVote, secondVote],
    });
    assert.ok(estimate(prompt) > 8000);
    assert.ok(estimate(compactPrompt) <= 8000, `compact estimate: ${estimate(compactPrompt)}`);
    assert.deepEqual(calls.map((call) => call.prompt), [compactPrompt, compactPrompt]);
  });

  test('the declared cap keeps proof feedback on the compact retry when it fits', async () => {
    const padding = await loadFor(8318);
    const { calls, prompt, compactPrompt, modelResults } = await runRounds({
      padding,
      declaredInputCap: 8000,
      replies: [structuredReply(false), structuredReply(false), structuredReply(true), structuredReply(true)],
    });
    const annotated = buildFactCheckProofRetryPrompt(compactPrompt, new Set([missingSourceQuote]));
    assert.ok(estimate(prompt) > 8000);
    assert.ok(estimate(annotated) <= 8000);
    assert.deepEqual(calls.map((call) => call.prompt), [compactPrompt, compactPrompt, annotated, annotated]);
    assert.equal(modelResults.length, 2);
  });

  for (const { target, cap, canton, section } of [
    { target: 7874, cap: 7000, canton: 'San Gallo', section: 'san-gallo' },
    { target: 8318, cap: 8000, canton: 'Lucerna', section: 'lucerna' },
    { target: 9439, cap: 8000, canton: 'Ginevra', section: 'canton-ge' },
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
      const responseFormat = (text) => text.slice(text.indexOf('Rispondi SOLO in JSON valido:'));
      assert.equal(responseFormat(compactPrompt), responseFormat(prompt));
      assert.match(suffix, /almeno 40 caratteri e 7 parole/);
      assert.match(suffix, /almeno 16 caratteri consecutivi dalla fonte o da un riferimento verificato/);
      assert.match(suffix, /almeno 35 caratteri e 6 parole/);
      assert.match(suffix, /FAIL con almeno 1 critical o 3 major/);
      assert.match(suffix, /critical:.*fatto specifico assente sia dalla fonte sia dai fatti verificati/);
      assert.match(suffix, /Per evergreen la sola assenza dalla fonte non basta/);
      assert.match(suffix, /"articleQuote".*"citazione esatta/);
      assert.match(suffix, /"evidenceQuotes"/);
      assert.match(suffix, /"sourceQuote"/);
      const relevance = cantonLines.factCheckRelevance(false);
      assert.ok(prompt.includes(`\n\n${relevance}\n\n${prompt.slice(proofStart(prompt))}`));
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

  test('un evergreen nazionale sopra il tetto conserva corpo e riferimenti nel fact-check compatto', async () => {
    const scope = { section: 'svizzera', isCanton: false, sourceUrl: 'evergreen://fixture' };
    const padding = await loadFor(8250, scope);
    const { calls, prompt, compactPrompt, modelResults } = await runRounds({
      ...scope, padding, declaredInputCap: 8000, replies: [firstVote, secondVote],
    });
    assert.ok(estimate(prompt) > 8000);
    assert.ok(estimate(compactPrompt) <= 8000);
    for (const marker of [bodyEnd, 'NOTA: Articolo evergreen', 'Riferimenti: confronta', 'articleQuote', 'evidenceQuotes']) {
      assert.ok(compactPrompt.includes(marker), marker);
    }
    assert.match(compactPrompt, /luogo o ente, ruolo, azione ed esito.*senza riferimento verificato è critical:fatti_inventati/);
    assert.deepEqual(calls.map((call) => call.prompt), [compactPrompt, compactPrompt]);
    assert.equal(modelResults.length, 2);
  });

  for (const [label, scope] of [
    ['fonte non HTTP', { sourceUrl: 'file:///fixture' }],
    ['fonte HTTP troppo breve', { sourceText: 'Riferimento breve.' }],
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
