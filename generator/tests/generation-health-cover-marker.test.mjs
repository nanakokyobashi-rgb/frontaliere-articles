import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCoverOutcomes } from '../../scripts/ci/scan-generation-health.mjs';

test('the cover parser accepts a redacted signal article token', () => {
  assert.deepEqual(parseCoverOutcomes(
    '[cover] article=[signal_article_id_redacted] source=catalog-fallback reason=[signal-related diagnostic redacted]',
  ), [{
    articleId: '[signal_article_id_redacted]',
    kind: 'fallback',
    source: 'catalog-fallback',
    reason: '[signal-related diagnostic redacted]',
  }]);
});
