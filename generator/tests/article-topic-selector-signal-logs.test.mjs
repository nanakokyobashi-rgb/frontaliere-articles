import assert from 'node:assert/strict';
import test from 'node:test';
import { rankAndSelectHeadlines } from '../scripts/lib/article-topic-selector.mjs';

test('cascade scoring failures do not log signal headline text or free-form errors', async () => {
  const candidate = {
    headline: 'private trend candidate headline',
    source: 'trends',
    url: null,
    _discoveryCandidate: { source: 'google-trends' },
  };
  const evidence = new Proxy({ windowDays: 90 }, {
    get(target, property, receiver) {
      if (property === 'gsc') throw new Error(`error echoed private trend candidate headline`);
      return Reflect.get(target, property, receiver);
    },
  });
  const warnings = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(' '));
  let picks;
  try {
    picks = await rankAndSelectHeadlines([candidate], null, {
      evidence,
      classifierOpts: { forceRegex: true },
      cascadeOpts: {},
    });
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.deepEqual(picks, []);
  assert.deepEqual(warnings, [
    '[cascade] scoring failed candidate_index=1 error_type=Error; candidate skipped',
  ]);
});

test('classifier errors and malformed responses never log the signal title', async () => {
  const headline = 'private classifier signal headline';
  const candidate = { headline, source: 'trends', url: null };
  const originalConsoleWarn = console.warn;

  for (const [name, callLLM, expectedWarning] of [
    [
      'classifier error',
      async () => { throw new Error(`provider echoed ${headline}`); },
      '[classifier] LLM call failed; regex fallback',
    ],
    [
      'malformed classifier response',
      async () => `not-json: ${headline}`,
      '[classifier] LLM returned malformed JSON; regex fallback',
    ],
  ]) {
    const warnings = [];
    console.warn = (...parts) => warnings.push(parts.join(' '));
    try {
      await rankAndSelectHeadlines([candidate], null, {
        classifierOpts: { callLLM },
        minScore: Number.POSITIVE_INFINITY,
      });
    } finally {
      console.warn = originalConsoleWarn;
    }
    assert.deepEqual(warnings, [expectedWarning], name);
    assert.doesNotMatch(warnings.join('\n'), /private classifier signal headline|provider echoed/);
  }
});
