import test from 'node:test';
import assert from 'node:assert/strict';
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
