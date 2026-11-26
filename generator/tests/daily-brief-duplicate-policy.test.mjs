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
import { EMBEDDING_MODEL } from '../scripts/lib/evidence/constants.mjs';

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

test('semantic dedup emits runtime store, model, threshold and fail-open evidence', async () => {
  const logs = [];
  const rowVector = new Float32Array(384);
  rowVector[0] = 1;
  const queryVector = new Float32Array(384);
  queryVector[1] = 1;
  const rowHash = 'e'.repeat(64);
  const store = { dim: 384, count: 1, vectors: [rowVector], hashes: [rowHash] };
  const meta = {
    model: EMBEDDING_MODEL,
    dim: 384,
    count: 1,
    perArticle: { 'existing-article': { hash: rowHash } },
  };

  await checkSemanticNearDuplicate(CANDIDATE, {
    section: 'canton-ti',
    generationAttempt: 2,
    store,
    meta,
    embedFn: async () => queryVector,
    queryModel: EMBEDDING_MODEL,
    log: (message) => logs.push(message),
  });
  const activePayload = JSON.parse(logs.find((message) => message.startsWith('GENERATION_DEDUP_STORE ')).slice('GENERATION_DEDUP_STORE '.length));
  assert.equal(activePayload.section, 'canton-ti');
  assert.equal(activePayload.generationAttempt, 2);
  assert.equal(activePayload.storePresent, true);
  assert.equal(activePayload.storeCount, 1);
  assert.equal(activePayload.metaModel, EMBEDDING_MODEL);
  assert.equal(activePayload.queryModel, EMBEDDING_MODEL);
  assert.equal(activePayload.policyThreshold, 0.86);
  assert.equal(activePayload.effectiveThreshold, activePayload.policyThreshold);
  assert.equal(activePayload.thresholdSource, 'runtime_store_count');
  assert.equal(activePayload.gateApplied, true);

  const missingLogs = [];
  await checkSemanticNearDuplicate(CANDIDATE, {
    section: 'canton-ti',
    store: null,
    meta: null,
    log: (message) => missingLogs.push(message),
  });
  const missingPayload = JSON.parse(missingLogs.find((message) => message.startsWith('GENERATION_DEDUP_STORE ')).slice('GENERATION_DEDUP_STORE '.length));
  assert.equal(missingPayload.status, 'store_missing');
  assert.equal(missingPayload.storePresent, false);
  assert.equal(missingPayload.policyThreshold, null);
  assert.equal(missingPayload.effectiveThreshold, null);
  assert.equal(missingPayload.gateApplied, false);

  const mismatchLogs = [];
  await checkSemanticNearDuplicate(CANDIDATE, {
    section: 'canton-ti',
    store,
    meta,
    embedFn: async () => queryVector,
    queryModel: 'different-model',
    log: (message) => mismatchLogs.push(message),
  });
  const mismatchPayload = JSON.parse(mismatchLogs.find((message) => message.startsWith('GENERATION_DEDUP_STORE ')).slice('GENERATION_DEDUP_STORE '.length));
  assert.equal(mismatchPayload.status, 'model_mismatch');
  assert.equal(mismatchPayload.policyThreshold, 0.86);
  assert.equal(mismatchPayload.effectiveThreshold, null);
  assert.equal(mismatchPayload.gateApplied, false);
});

test('the shared writer exposes the recurring policy only to the daily producer', () => {
  const writer = readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
  const producer = readFileSync(path.join(ROOT, 'generator/scripts/generate-daily-brief-article.mjs'), 'utf8');
  assert.match(writer, /allowRecurringDailyEdition/);
  assert.match(writer, /excludeDailyBriefArticles/);
  assert.match(writer, /ignoreNeighbor: allowRecurringDailyEdition/);
  assert.match(producer, /registerArticleFiles\(data, \{ allowRecurringDailyEdition: true \}\)/);
});
