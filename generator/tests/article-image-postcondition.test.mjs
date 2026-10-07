import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEntriesByImagePostcondition } from '../../scripts/lib/article-image-postcondition.mjs';

test('I2 esclude indice e bridge quando l’immagine dichiarata ricade sul fallback generico', () => {
  const result = filterEntriesByImagePostcondition({
    entries: [
      { articleId: 'degraded', paths: { it: 'degraded/index.html' }, flatPaths: { it: 'degraded.html' } },
      { articleId: 'healthy', paths: { it: 'healthy/index.html' }, flatPaths: { it: 'healthy.html' } },
      { articleId: 'resolved', paths: { it: 'resolved/index.html' }, flatPaths: { it: 'resolved.html' } },
    ],
    declaredImages: {
      degraded: '/images/blog/degraded.webp',
      healthy: '/og-image.png',
      resolved: '/images/blog/resolved.webp',
    },
    htmlByPath: {
      'degraded/index.html': '<meta property="og:image" content="/og-image.png">',
      'degraded.html': '<meta property="og:image" content="/og-image.png">',
      'healthy/index.html': '<meta property="og:image" content="/og-image.png">',
      'healthy.html': '<meta property="og:image" content="/og-image.png">',
      'resolved/index.html': '<meta property="og:image" content="/images/blog/resolved.webp">',
      'resolved.html': '<meta property="og:image" content="/images/blog/resolved.webp">',
    },
  });
  assert.deepEqual(result.entries.map((entry) => entry.articleId), ['healthy', 'resolved']);
  assert.equal(result.excludedPages, result.excludedArticles[0].paths.length);
});
