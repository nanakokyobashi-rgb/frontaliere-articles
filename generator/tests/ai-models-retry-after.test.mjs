import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, test } from 'node:test';

import {
  AI_MODELS,
  callSingleModel,
  parseRetryAfter,
  parseStrictRetryAfterValue,
  resetState,
} from '../scripts/lib/ai-models.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GH_MODELS_PAT: process.env.GH_MODELS_PAT,
};
const NOW_MS = Date.parse('2026-10-25T08:00:00Z');

beforeEach(() => {
  resetState();
  process.env.GEMINI_API_KEY = 'retry-after-gemini-test';
  process.env.GH_MODELS_PAT = 'retry-after-github-test';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetState();
});

test('parseRetryAfter accetta delta-seconds e HTTP-date con cap bounded', () => {
  const response = (value) => ({ headers: { get: () => value } });

  assert.equal(parseRetryAfter(response('7'), NOW_MS), 7_000);
  assert.equal(
    parseRetryAfter(response('Sun, 25 Oct 2026 08:00:30 GMT'), NOW_MS),
    30_000,
  );
  assert.equal(
    parseRetryAfter(response('Sun, 25 Oct 2026 07:59:59 GMT'), NOW_MS),
    0,
  );
  assert.equal(parseRetryAfter(response('not-a-delay'), NOW_MS), 0);
  assert.equal(parseRetryAfter(response('10/25/2026'), NOW_MS), 0);
  assert.equal(parseRetryAfter(response('Mon, 25 Oct 2026 08:00:30 GMT'), NOW_MS), 0);
  assert.equal(parseRetryAfter(response('9'.repeat(100)), NOW_MS), 0);
  assert.equal(parseRetryAfter(response('86400'), NOW_MS), 120_000);
  assert.equal(parseStrictRetryAfterValue('10/25/2026', NOW_MS), 0);
  assert.equal(parseStrictRetryAfterValue('Mon, 25 Oct 2026 08:00:30 GMT', NOW_MS), 0);
  assert.equal(parseStrictRetryAfterValue('9007199254740992', NOW_MS), 0);
  assert.equal(parseStrictRetryAfterValue('9'.repeat(100), NOW_MS), 0);
});

async function assertHttpDateRetryIsHonored(model, successBody, options) {
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const sleeps = [];
  let calls = 0;
  const retryAt = new Date(NOW_MS + 30_000).toUTCString();

  Date.now = () => NOW_MS;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      // The production retry timer is deliberately bypassed here; the test
      // still observes the exact delay computed from the HTTP-date.
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay >= 20_000) {
          sleeps.push(delay);
          queueMicrotask(() => callback(...args));
          return { retryAfterTimer: true };
        }
        return originalSetTimeout(callback, delay, ...args);
      };
      return new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': retryAt },
      });
    }
    return new Response(successBody, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await callSingleModel([{ role: 'user', content: 'x' }], {
      ...options,
      maxRetriesPerModel: 2,
      backoffMs: 0,
      timeout: 1_000,
      recordScore: false,
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [30_000]);
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
}

test('il retry OpenAI-compatible interpreta Retry-After come HTTP-date', async () => {
  await assertHttpDateRetryIsHonored(
    AI_MODELS.GPT4O,
    JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    {
      model: AI_MODELS.GPT4O,
      githubModelsCatalog: [{ id: 'openai/gpt-4o' }],
    },
  );
});

test('il retry Gemini interpreta Retry-After come HTTP-date', async () => {
  await assertHttpDateRetryIsHonored(
    AI_MODELS.GEMINI_FLASH,
    JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    { model: AI_MODELS.GEMINI_FLASH },
  );
});
