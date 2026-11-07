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

const GUARD_SOURCE = extractFunctionSource('function providerInputCapGuard(models) {');

function makeGuard(caps, floor = 5850) {
  return new Function(
    'getDeclaredRequestTokenLimit',
    'PROMPT_SCAFFOLD_FLOOR_TOKENS',
    `${GUARD_SOURCE}\nreturn providerInputCapGuard;`,
  )((model) => {
    if (caps instanceof Map) return caps.get(model);
    return caps(model);
  }, floor);
}

test('providerInputCapGuard rejects a roster whose every input cap is below the prompt floor', () => {
  const guard = makeGuard(new Map([
    ['small-a', 4000],
    ['small-b', 3000],
  ]));

  assert.deepEqual(guard(['small-a', 'small-b']), {
    ready: false,
    minimumInputTokens: 5850,
    eligibleModels: [],
    rejectedModels: [
      { model: 'small-a', requestLimit: 4000, reason: 'below-prompt-scaffold-floor' },
      { model: 'small-b', requestLimit: 3000, reason: 'below-prompt-scaffold-floor' },
    ],
  });
});

test('providerInputCapGuard keeps unbounded and exact-floor models eligible', () => {
  const guard = makeGuard(new Map([
    ['unbounded', undefined],
    ['floor', 5850],
    ['too-small', 4000],
  ]));

  assert.deepEqual(guard(['unbounded', 'floor', 'too-small']), {
    ready: true,
    minimumInputTokens: 5850,
    eligibleModels: [
      { model: 'unbounded', requestLimit: null },
      { model: 'floor', requestLimit: 5850 },
    ],
    rejectedModels: [
      { model: 'too-small', requestLimit: 4000, reason: 'below-prompt-scaffold-floor' },
    ],
  });
});

test('providerInputCapGuard fails closed on an unreadable cap and is wired before the scan', () => {
  const guard = makeGuard(() => {
    throw new Error('malformed model');
  });
  assert.deepEqual(guard(['broken']), {
    ready: false,
    minimumInputTokens: 5850,
    eligibleModels: [],
    rejectedModels: [{ model: 'broken', requestLimit: null, reason: 'input-cap-unreadable' }],
  });

  const preflightStart = SOURCE.indexOf('await initScoreStore();');
  const scanStart = SOURCE.indexOf('// ── Auto-scan mode:', preflightStart);
  assert.ok(preflightStart >= 0 && scanStart > preflightStart, 'preflight/scan delimiters missing');
  const preflight = SOURCE.slice(preflightStart, scanStart);
  assert.match(preflight, /providerInputCapGuard\(roster\.availableModels\)/);
  assert.match(preflight, /PROVIDER_INPUT_CAP ready=/);
  assert.match(preflight, /if \(!inputCapGuard\.ready\)/);
});
