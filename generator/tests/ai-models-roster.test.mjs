import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_MODELS,
  DEFAULT_CHAIN,
  DISCOVERY_PROVIDERS,
} from '../scripts/lib/ai-models.mjs';

const nvidia = DISCOVERY_PROVIDERS.find((provider) => provider.name === 'NVIDIA');

describe('roster NVIDIA', () => {
  test('mantiene in catena il modello live usato come fallback affidabile', () => {
    assert.equal(AI_MODELS.NV_NEMOTRON_SUPER, 'nvidia/nvidia/nemotron-3-super-120b-a12b');
    assert.ok(DEFAULT_CHAIN.includes(AI_MODELS.NV_NEMOTRON_SUPER));
  });

  test('non reinserisce gli id NVIDIA osservati come HTTP 410', () => {
    assert.ok(nvidia, 'provider NVIDIA non trovato');
    for (const id of [
      'meta/llama-3.1-8b-instruct',
      'mistralai/mistral-small-4-119b-2603',
      'nvidia/nemotron-nano-9b-v2',
    ]) {
      assert.equal(nvidia.pick({ id }), null, `id ritirato accettato: ${id}`);
    }
    assert.equal(nvidia.pick({ id: 'nemotron-3-super-120b-a12b' }), 'nemotron-3-super-120b-a12b');
  });
});
