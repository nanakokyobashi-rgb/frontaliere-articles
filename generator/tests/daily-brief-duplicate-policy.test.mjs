/**
 * The daily edition is a recurring product, not a second copy of one of its
 * prior dated editions. Its exact identity and slug gates remain strict while
 * the similarity gates ignore only that dated family.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSemanticNearDuplicate } from '../scripts/lib/scoring/semanticDedup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function embeddingStore(rows) {
  return {
    dim: 2,
    count: rows.length,
    vectors: rows.map(({ vector }) => Float32Array.from(vector)),
    hashes: rows.map(({ hash }) => hash),
  };
}

function embeddingMeta(rows) {
  return {
    perArticle: Object.fromEntries(rows.map(({ slug, hash }) => [slug, { hash }])),
  };
}

const DAILY = {
  slug: 'bollettino-frontaliere-2026-11-09',
  hash: 'd'.repeat(64),
  vector: [1, 0],
};

const ORDINARY = {
  slug: 'ordinary-article',
  hash: 'o'.repeat(64),
  vector: [0.999, 0.045],
};

const CANDIDATE = {
  id: 'bollettino-frontaliere-2026-11-10',
  content: { it: { title: 'Bollettino del Frontaliere', excerpt: 'Dati verificati del giorno.' } },
};

// The production path supplies the canonical daily-family predicate. This
// test predicate deliberately names only the fixture row so the semantic gate
// can be exercised without importing the content builder's TypeScript-backed
// published-source scanner.
const ignoreDailyFixture = (slug) => slug === DAILY.slug;

test('semantic dedup ignores prior daily editions but still sees a real neighbour past them', async () => {
  const rows = [DAILY, ORDINARY];
  await assert.rejects(
    checkSemanticNearDuplicate(CANDIDATE, {
      store: embeddingStore(rows),
      meta: embeddingMeta(rows),
      embedFn: async () => Float32Array.from([1, 0]),
      threshold: 0.9,
      k: 1,
      ignoreNeighbor: ignoreDailyFixture,
      log: () => {},
    }),
    /DUPLICATO SEMANTICO RILEVATO/,
  );
});

test('semantic dedup does not block a new daily edition when only prior daily editions match', async () => {
  await assert.doesNotReject(
    checkSemanticNearDuplicate(CANDIDATE, {
      store: embeddingStore([DAILY]),
      meta: embeddingMeta([DAILY]),
      embedFn: async () => Float32Array.from([1, 0]),
      threshold: 0.9,
      ignoreNeighbor: ignoreDailyFixture,
      log: () => {},
    }),
  );
});

test('the shared writer exposes the recurring policy only to the daily producer', () => {
  const writer = readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
  const producer = readFileSync(path.join(ROOT, 'generator/scripts/generate-daily-brief-article.mjs'), 'utf8');
  assert.match(writer, /allowRecurringDailyEdition/);
  assert.match(writer, /excludeDailyBriefArticles/);
  assert.match(writer, /ignoreNeighbor: allowRecurringDailyEdition/);
  assert.match(producer, /registerArticleFiles\(data, \{ allowRecurringDailyEdition: true \}\)/);
});
