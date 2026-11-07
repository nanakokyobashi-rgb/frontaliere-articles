import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.join(HERE, '../scripts/create-article.mjs');
const SOURCE = readFileSync(CREATE_ARTICLE, 'utf8');

function extractFunctionSource(signature) {
  const start = SOURCE.indexOf(signature);
  assert.notEqual(start, -1, `${signature} missing from create-article.mjs`);
  const end = SOURCE.slice(start).search(/\n\}\n/);
  assert.notEqual(end, -1, `${signature} has no closing brace`);
  return SOURCE.slice(start, start + end + 2);
}

const GUARD_SOURCE = extractFunctionSource('function providerInputCapGuard(');
const CALL_GUARD_SOURCE = extractFunctionSource('function guardProviderInputCapForCall(');
const FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS = Number(
  SOURCE.match(/const PROMPT_UNIQUE_SCAFFOLD_FLOOR_TOKENS = (\d+);/)?.[1],
);
assert.ok(Number.isSafeInteger(FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS), 'full prompt floor constant missing');

function makeGuard(caps, splitMode = 'auto', estimates = null) {
  const guard = new Function(
    'getDeclaredRequestTokenLimit',
    'PROMPT_SCAFFOLD_FLOOR_TOKENS',
    'PROMPT_UNIQUE_SCAFFOLD_FLOOR_TOKENS',
    `${GUARD_SOURCE}\nreturn providerInputCapGuard;`,
  )((model) => {
    if (caps instanceof Map) return caps.get(model);
    return caps(model);
  }, 5850, FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS);
  return (models, minimumInputTokensOverride = null) => guard(
    models,
    splitMode,
    minimumInputTokensOverride,
    estimates
      ? (model) => (estimates instanceof Map ? estimates.get(model) : estimates(model))
      : null,
  );
}

test('providerInputCapGuard rejects a roster whose every input cap is below the prompt floor', () => {
  const guard = makeGuard(new Map([
    ['small-a', 4000],
    ['small-b', 3000],
  ]));

  assert.deepEqual(guard(['small-a', 'small-b']), {
    ready: false,
    minimumInputTokens: FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS,
    eligibleModels: [],
    rejectedModels: [
      { model: 'small-a', requestLimit: 4000, reason: 'below-minimum-input-floor' },
      { model: 'small-b', requestLimit: 3000, reason: 'below-minimum-input-floor' },
    ],
  });
});

test('providerInputCapGuard keeps unbounded and exact-floor models eligible', () => {
  const guard = makeGuard(new Map([
    ['unbounded', undefined],
    ['floor', 5850],
    ['too-small', 4000],
  ]), 'on');

  assert.deepEqual(guard(['unbounded', 'floor', 'too-small']), {
    ready: true,
    minimumInputTokens: 5850,
    eligibleModels: [
      { model: 'unbounded', requestLimit: null },
      { model: 'floor', requestLimit: 5850 },
    ],
    rejectedModels: [
      { model: 'too-small', requestLimit: 4000, reason: 'below-minimum-input-floor' },
    ],
  });
});

test('providerInputCapGuard keeps auto conservative until split is decided', () => {
  const guard = makeGuard(new Map([
    ['body-floor', 5850],
    ['full-floor', FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS],
  ]), 'auto');

  assert.deepEqual(guard(['body-floor', 'full-floor']), {
    ready: true,
    minimumInputTokens: FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS,
    eligibleModels: [
      { model: 'full-floor', requestLimit: FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS },
    ],
    rejectedModels: [
      { model: 'body-floor', requestLimit: 5850, reason: 'below-minimum-input-floor' },
    ],
  });
});

test('providerInputCapGuard uses the single-call scaffold floor when split is off', () => {
  const guard = makeGuard(new Map([
    ['body-floor', 5850],
    ['full-floor-minus-one', FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS - 1],
    ['full-floor', FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS],
  ]), 'off');

  assert.deepEqual(guard(['body-floor', 'full-floor-minus-one', 'full-floor']), {
    ready: true,
    minimumInputTokens: FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS,
    eligibleModels: [
      { model: 'full-floor', requestLimit: FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS },
    ],
    rejectedModels: [
      { model: 'body-floor', requestLimit: 5850, reason: 'below-minimum-input-floor' },
      { model: 'full-floor-minus-one', requestLimit: FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS - 1, reason: 'below-minimum-input-floor' },
    ],
  });

  const splitGuard = makeGuard(new Map([['body-floor', 5850]]), 'on');
  assert.equal(splitGuard(['body-floor']).ready, true, 'on deve usare il floor della chiamata split');
});

test('providerInputCapGuard does not treat the zero-content scaffold as the real body floor', () => {
  const guard = makeGuard(new Map([
    ['learned-small', 6000],
    ['body-minimum', 6800],
  ]), 'on');

  assert.deepEqual(guard(['learned-small', 'body-minimum'], 6800), {
    ready: true,
    minimumInputTokens: 6800,
    eligibleModels: [{ model: 'body-minimum', requestLimit: 6800 }],
    rejectedModels: [
      { model: 'learned-small', requestLimit: 6000, reason: 'below-minimum-input-floor' },
    ],
  });
});

test('providerInputCapGuard compares each effective model with its provider-accurate estimate', () => {
  const guard = makeGuard(
    new Map([
      ['groq/usable-without-schema', 8000],
      ['github/schema-would-overrun', 8000],
    ]),
    'off',
    new Map([
      ['groq/usable-without-schema', 7990],
      ['github/schema-would-overrun', 8200],
    ]),
  );

  assert.deepEqual(guard(['groq/usable-without-schema', 'github/schema-would-overrun'], 8200), {
    ready: true,
    minimumInputTokens: 8200,
    eligibleModels: [{
      model: 'groq/usable-without-schema',
      requestLimit: 8000,
      estimatedRequestTokens: 7990,
    }],
    rejectedModels: [{
      model: 'github/schema-would-overrun',
      requestLimit: 8000,
      estimatedRequestTokens: 8200,
      reason: 'below-request-estimate',
    }],
  });
});

test('providerInputCapGuard fails closed on an unreadable cap and is wired before the scan', () => {
  const guard = makeGuard(() => {
    throw new Error('malformed model');
  });
  assert.deepEqual(guard(['broken']), {
    ready: false,
    minimumInputTokens: FULL_PROMPT_SCAFFOLD_FLOOR_TOKENS,
    eligibleModels: [],
    rejectedModels: [{ model: 'broken', requestLimit: null, reason: 'input-cap-unreadable' }],
  });

  const preflightStart = SOURCE.indexOf('await initScoreStore();');
  const scanStart = SOURCE.indexOf('// ── Auto-scan mode:', preflightStart);
  assert.ok(preflightStart >= 0 && scanStart > preflightStart, 'preflight/scan delimiters missing');
  const preflight = SOURCE.slice(preflightStart, scanStart);
  assert.match(preflight, /const promptSplitMode = getPromptSplitMode\(\);/);
  assert.match(preflight, /providerInputCapGuard\(roster\.availableModels, promptSplitMode\)/);
  assert.match(preflight, /PROVIDER_INPUT_CAP_PRECHECK ready=/);
  assert.match(preflight, /if \(!inputCapGuard\.ready\)/);

  const callGeminiStart = SOURCE.indexOf('async function callGemini(');
  const promptGuard = SOURCE.indexOf('const _promptInputCapGuard = typeof providerInputCapGuard');
  assert.ok(callGeminiStart >= 0 && promptGuard > callGeminiStart, 'prompt-built input-cap guard missing inside callGemini');
  const promptGuardBlock = SOURCE.slice(SOURCE.lastIndexOf('const _promptCallModel', promptGuard), promptGuard + 1100);
  assert.match(promptGuardBlock, /_minimumPromptCall\.est/);
  assert.match(promptGuardBlock, /estimateProviderRequestTokens\(_minimumPromptCall\.msgs, _minimumPromptCall\.schema, candidate\)/);
  assert.match(promptGuardBlock, /generationCallRosterOptions\(\{ model: _promptCallModel, prefer: _promptCallPrefer \}\)/);
  assert.match(promptGuardBlock, /phase: 'prompt-built-minimum-request'/);

  const splitStart = SOURCE.indexOf('const _call2 = _buildHalf(\'meta\'', callGeminiStart);
  assert.ok(splitStart >= 0, 'metadata call anchor missing');
  const metadataBlock = SOURCE.slice(splitStart, splitStart + 2400);
  assert.match(metadataBlock, /guardProviderInputCapForCall\(_call2/);
  assert.match(metadataBlock, /prefer: _metadataPrefer/);
  assert.match(metadataBlock, /phase: 'prompt-built-metadata-call'/);
});

test('an empty effective roster stays on callLLM exhaustion handling', () => {
  const roster = {
    availableModels: [],
    unavailableModels: [{ model: 'claude-cli/haiku', reason: 'per-run-call-cap' }],
  };
  const guard = new Function(
    'getProviderRosterStatus',
    'generationCallRosterOptions',
    'providerInputCapGuard',
    'estimateProviderRequestTokens',
    'providerInputCapGuardError',
    'console',
    `${CALL_GUARD_SOURCE}\nreturn guardProviderInputCapForCall;`,
  )(
    () => roster,
    () => ({ chain: ['requested'] }),
    () => { throw new Error('the cap guard must not inspect an empty roster'); },
    () => { throw new Error('the token estimator must not inspect an empty roster'); },
    () => { throw new Error('the cap error must not be created for an empty roster'); },
    { error() {} },
  );

  assert.deepEqual(
    guard({ msgs: [], schema: {}, est: 9000 }, { model: 'requested' }),
    { roster, inputCapGuard: null },
  );

  const promptGuardStart = SOURCE.indexOf('const _promptInputCapGuard =');
  const promptGuardEnd = SOURCE.indexOf('// Costruita QUI', promptGuardStart);
  assert.ok(promptGuardStart >= 0 && promptGuardEnd > promptGuardStart, 'prompt-built guard delimiters missing');
  assert.match(
    SOURCE.slice(promptGuardStart, promptGuardEnd),
    /_promptRoster\.availableModels\.length > 0/,
    'the prompt-built guard must not run when the effective roster is empty',
  );
});
