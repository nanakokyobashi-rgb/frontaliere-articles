import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiscoveryPool } from '../scripts/lib/discovery/discoveryPool.mjs';

test('Google Trends discovery can build a sourced candidate without evidence-index context', async () => {
  const nowMs = Date.parse('2026-11-05T10:00:00.000Z');
  const signalHeadline = 'Permessi frontalieri in Ticino';
  const pool = await buildDiscoveryPool(null, {
    nowMs,
    orphanFn: (evidence) => {
      assert.equal(evidence, null);
      return [];
    },
    suggestFn: async (evidence) => {
      assert.equal(evidence, null);
      return [];
    },
    trendsFn: async (evidence) => {
      assert.equal(evidence, null);
      return [{
        headline: signalHeadline,
        source: 'trends',
        meta: { score: 42, seed: signalHeadline },
      }];
    },
    newsFn: async (evidence, options = {}) => {
      assert.equal(evidence, null);
      if (!Array.isArray(options.seeds)) return [];
      return [{
        headline: 'Nuove regole per i permessi dei frontalieri in Ticino',
        url: 'https://news.example.test/frontaliere-permessi',
        meta: {
          seed: signalHeadline,
          pubDate: '2026-11-05T09:00:00.000Z',
          publisherHost: 'news.example.test',
        },
      }];
    },
  });

  assert.equal(pool.perSource.trendSignals, 1);
  assert.equal(pool.candidates.length, 1);
  assert.equal(pool.candidates[0].source, 'trends');
  assert.equal(pool.candidates[0].meta.signalProvider, 'google-trends');
  assert.equal(pool.candidates[0].meta.evidenceProvider, 'google-news-rss');
  assert.equal(pool.candidates[0].meta.signalHeadline, signalHeadline);
});
