import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countCantonHubContentWords } from '../../scripts/lib/canton-hub-content.mjs';

test('a truthy non-array list payload fails closed before counting', () => {
  assert.throws(() => countCantonHubContentWords({
    intro: '',
    keyFacts: [],
    dataBlocks: [],
    curatedArticles: { length: 1 },
    latestCantonArticles: [{ title: 'Fallback article' }],
    links: [],
  }), /curatedArticles deve essere un array/);
});

test('a truthy non-array block.items payload fails closed before counting', () => {
  assert.throws(() => countCantonHubContentWords({
    intro: '',
    keyFacts: [],
    dataBlocks: [{ title: 'blocco', items: { length: 1 } }],
    curatedArticles: [],
    latestCantonArticles: [],
    links: [],
  }), /dataBlocks\[0\]\.items deve essere un array/);
});

test('null data-block and item entries fail closed before counting', () => {
  const base = {
    intro: '',
    keyFacts: [],
    curatedArticles: [],
    latestCantonArticles: [],
    links: [],
  };

  assert.throws(() => countCantonHubContentWords({ ...base, dataBlocks: [null] }), /dataBlocks\[0\] deve essere un oggetto/);
  assert.throws(() => countCantonHubContentWords({ ...base, dataBlocks: [{ title: 'blocco', items: [null] }] }), /dataBlocks\[0\]\.items\[0\] deve essere un oggetto/);
});
