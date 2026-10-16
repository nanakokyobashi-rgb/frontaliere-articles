import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countCantonHubContentWords } from '../../scripts/lib/canton-hub-content.mjs';

test('a truthy non-array curatedArticles payload falls back without throwing', () => {
  const count = countCantonHubContentWords({
    intro: '',
    keyFacts: [],
    dataBlocks: [],
    curatedArticles: { length: 1 },
    latestCantonArticles: [{ title: 'Fallback article' }],
  });

  assert.equal(count, 2);
});

test('malformed article-list payloads normalize to empty arrays', () => {
  const input = {
    intro: '',
    keyFacts: [],
    dataBlocks: [],
    curatedArticles: 'malformed',
    latestCantonArticles: { length: 1 },
  };

  assert.doesNotThrow(() => countCantonHubContentWords(input));
  assert.equal(countCantonHubContentWords(input), 0);
});
