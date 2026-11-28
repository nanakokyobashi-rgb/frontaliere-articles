import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getLlmProviderRequestsByStage,
  recordLlmProviderRequest,
  resetLlmProviderRequests,
  withLlmCallStage,
} from '../scripts/lib/llm-call-metrics.mjs';

test('LLM model attempts inherit async stage context and nested stages override it', async () => {
  resetLlmProviderRequests();

  await withLlmCallStage('selection', async () => {
    recordLlmProviderRequest();
    await Promise.all([
      withLlmCallStage('generation', async () => {
        recordLlmProviderRequest();
        await Promise.resolve();
        await withLlmCallStage('factCheck', async () => recordLlmProviderRequest());
        recordLlmProviderRequest();
      }),
      withLlmCallStage('translation', async () => recordLlmProviderRequest()),
    ]);
    recordLlmProviderRequest();
  });
  recordLlmProviderRequest();

  assert.deepEqual(getLlmProviderRequestsByStage(), {
    selection: 2,
    generation: 2,
    factCheck: 1,
    translation: 1,
    unclassified: 1,
  });
});

test('stage snapshots are copies and unknown stage labels fail closed', async () => {
  resetLlmProviderRequests();
  await withLlmCallStage('other', async () => recordLlmProviderRequest());
  const snapshot = getLlmProviderRequestsByStage();
  snapshot.unclassified = 99;
  assert.equal(getLlmProviderRequestsByStage().unclassified, 1);
});

test('demand-ranker classifier provider calls are wired to the selection stage', async () => {
  const createArticle = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
  const rankerCallStart = createArticle.indexOf(
    "const picks = await withLlmCallStage('selection', () => _rankAndSelectHeadlines(",
  );
  assert.notEqual(rankerCallStart, -1, 'the production demand-ranker call must bind its classifier to selection');
  const rankerCallEnd = createArticle.indexOf('\n                if (picks.length > 0)', rankerCallStart);
  assert.notEqual(rankerCallEnd, -1, 'the wrapped ranker call must retain its original result handling');
  assert.match(createArticle.slice(rankerCallStart, rankerCallEnd), /\}\)\);$/);

  resetLlmProviderRequests();
  const mockRankerWithClassifier = async () => {
    recordLlmProviderRequest();
    await Promise.resolve();
    recordLlmProviderRequest();
  };
  await withLlmCallStage('selection', mockRankerWithClassifier);
  assert.deepEqual(getLlmProviderRequestsByStage(), {
    selection: 2,
    generation: 0,
    factCheck: 0,
    translation: 0,
    unclassified: 0,
  });
});
