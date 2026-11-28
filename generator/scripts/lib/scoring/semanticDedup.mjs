// scripts/lib/scoring/semanticDedup.mjs
//
// Semantic near-duplicate gate for the article publish pipeline.
//
// The lexical Jaccard signals in create-article.mjs (`checkForDuplicates`)
// miss articles that re-tell the SAME story with different vocabulary. Real
// case (2026-05-29): "Aumento salari Svizzera 2024: +1.5-2% ma solo per
// specialisti" vs the already-published "Aumenti salariali Ticino fino al 2%
// nel 2025" share ~0 title tokens (aumento≠aumenti, salari≠salariali,
// svizzera≠ticino, 2024≠2025) so every Jaccard gate reads ~0 — yet they sit
// at cosine 0.876, i.e. the same article.
//
// This gate embeds the new title+excerpt in the SAME text format the
// published corpus uses (build-article-embeddings.mjs `articleText`:
// `${title}\n\n${excerpt}` sliced to 4000 chars) and rejects when the nearest
// published neighbour is at/above EMBEDDING_NEAR_DUP_COSINE.
//
// Two modes. Default (unit tests, exploratory callers): fail-open, a no-op
// when the embedding store is absent or the embed call fails. Production
// callers pass `failClosed: true` (M6, 2026-11-28): an absent/incompatible
// store, a failed or empty embedding and an unverifiable model throw
// DedupGateUnavailableError instead of publishing without dedup. The marker
// GENERATION_DEDUP_STORE records `failClosed` so the outcome is measurable.

import { EMBEDDING_DIM, EMBEDDING_MODEL } from '../evidence/constants.mjs';
import { embedOne, lastUsedEmbeddingModel } from '../evidence/embeddingClient.mjs';
import { findTopK, loadEmbeddingStore, loadEmbeddingMeta } from './embeddingMatcher.mjs';
import {
  EMBEDDING_NEAR_DUP_CORPUS_BASELINE,
  EMBEDDING_NEAR_DUP_CORPUS_SCALE_K,
  EMBEDDING_NEAR_DUP_COSINE,
  EMBEDDING_NEAR_DUP_COSINE_CEILING,
  EMBEDDING_TOP_K,
  computeAdaptiveNearDupCosine,
} from './constants.mjs';

/**
 * The dedup gate could not run and the caller asked for fail-closed. The
 * message deliberately avoids the word that `isDuplicateError()` in
 * create-article.mjs matches: this is an infrastructure failure, not a clean
 * "duplicate, try another topic" deferral.
 */
export class DedupGateUnavailableError extends Error {
  constructor(status, detail) {
    super(`❌ DEDUP SEMANTICO NON ESEGUIBILE (fail-closed, ${status}): ${detail}. Nessun articolo pubblicato senza il controllo.`);
    this.name = 'DedupGateUnavailableError';
    this.code = 'DEDUP_GATE_UNAVAILABLE';
    this.status = status;
  }
}

/** True per l'errore del gate fail-closed (esito DICHIARATO dal chiamante, mai un guasto non dichiarato). */
export function isDedupGateUnavailableError(e) {
  return e?.code === 'DEDUP_GATE_UNAVAILABLE'
    || /DEDUP SEMANTICO NON ESEGUIBILE \(fail-closed/.test(String(e?.message ?? ''));
}

function emitStoreObservation(log, data, opts, store, meta, status, {
  queryModel = null,
  gateApplied = false,
  policyThreshold = null,
  effectiveThreshold = null,
  thresholdSource = null,
} = {}) {
  const attemptValue = Number.parseInt(
    opts.generationAttempt ?? process.env.CREATE_ARTICLE_GENERATION_ATTEMPT ?? '',
    10,
  );
  log(`GENERATION_DEDUP_STORE ${JSON.stringify({
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    section: opts.section || 'unknown',
    generationAttempt: Number.isInteger(attemptValue) && attemptValue > 0 ? attemptValue : null,
    candidateId: typeof data?.id === 'string' ? data.id : null,
    status,
    storePresent: !!store,
    storeCount: Number.isInteger(store?.count) && store.count >= 0 ? store.count : null,
    storeDimension: Number.isInteger(store?.dim) && store.dim > 0 ? store.dim : null,
    metaPresent: !!meta,
    metaCount: Number.isInteger(meta?.count) && meta.count >= 0 ? meta.count : null,
    metaDimension: Number.isInteger(meta?.dim) && meta.dim > 0 ? meta.dim : null,
    metaMappedCount: meta?.perArticle && typeof meta.perArticle === 'object'
      ? Object.keys(meta.perArticle).length : null,
    metaModel: typeof meta?.model === 'string' ? meta.model : null,
    expectedModel: EMBEDDING_MODEL,
    expectedDimension: EMBEDDING_DIM,
    queryModel,
    gateApplied,
    policyThreshold,
    policyParameters: {
      baseThreshold: EMBEDDING_NEAR_DUP_COSINE,
      ceiling: EMBEDDING_NEAR_DUP_COSINE_CEILING,
      corpusBaseline: EMBEDDING_NEAR_DUP_CORPUS_BASELINE,
      corpusScaleK: EMBEDDING_NEAR_DUP_CORPUS_SCALE_K,
    },
    effectiveThreshold,
    thresholdSource,
    failClosed: opts.failClosed === true && !gateApplied && status !== 'empty_input',
  })}`);
}

/**
 * Build the corpus-comparable embedding text for an article. Must stay in
 * sync with build-article-embeddings.mjs `articleText` or cosines drift.
 *
 * @param {string} title
 * @param {string} excerpt
 * @returns {string}
 */
export function buildDedupText(title, excerpt) {
  return `${title || ''}\n\n${excerpt || ''}`.slice(0, 4000);
}

/**
 * Reject a candidate article when it is a semantic near-duplicate of an
 * already-published one. Throws on duplicate (consistent with
 * checkForDuplicates), returns the data object otherwise.
 *
 * Dependencies are injectable so the gate is unit-testable without the
 * embedding API or the on-disk store (mirrors cascadedScore's opts shape).
 *
 * @param {object} data — article data; reads data.content.it.{title,excerpt},
 *   data.id, data.slugs?.it / data.slug for self-exclusion.
 * @param {{
 *   embedFn?: (text: string) => Promise<Float32Array>,
 *   store?: object,
 *   meta?: object,
 *   threshold?: number,
 *   k?: number,
 *   ignoreNeighbor?: (slug: string|null) => boolean,
 *   log?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<object>} the same data object when not a duplicate
 * @throws {Error} when a published neighbour is at/above the threshold
 */
export async function checkSemanticNearDuplicate(data, opts = {}) {
  const log = opts.log || ((msg) => console.error(msg));
  const k = typeof opts.k === 'number' ? opts.k : EMBEDDING_TOP_K;

  const store = opts.store !== undefined ? opts.store : loadEmbeddingStore();
  const meta = opts.meta !== undefined ? opts.meta : loadEmbeddingMeta();
  if (!store) {
    emitStoreObservation(log, data, opts, null, meta, 'store_missing');
    if (opts.failClosed === true) throw new DedupGateUnavailableError('store_missing', 'store embedding assente o illeggibile');
    log('  ⏭️  Dedup semantico saltato (store embedding assente)');
    return data;
  }
  // Explicit opts.threshold (used by unit tests / callers that want a fixed
  // gate) is honoured as-is; otherwise scale with this section's corpus
  // size — see computeAdaptiveNearDupCosine in constants.mjs.
  const threshold = typeof opts.threshold === 'number'
    ? opts.threshold
    : computeAdaptiveNearDupCosine(store.count);
  const thresholdSource = typeof opts.threshold === 'number' ? 'explicit_override' : 'runtime_store_count';

  const title = data?.content?.it?.title || '';
  const excerpt = data?.content?.it?.excerpt || '';
  const text = buildDedupText(title, excerpt);
  if (!text.trim()) {
    emitStoreObservation(log, data, opts, store, meta, 'empty_input', {
      policyThreshold: threshold,
      thresholdSource,
    });
    return data;
  }

  const embedFn = opts.embedFn || embedOne;
  let vec;
  try {
    vec = await embedFn(text);
  } catch (err) {
    emitStoreObservation(log, data, opts, store, meta, 'embedding_failed', {
      policyThreshold: threshold,
      thresholdSource,
    });
    if (opts.failClosed === true) throw new DedupGateUnavailableError('embedding_failed', `embed fallito: ${err.message}`);
    log(`  ⏭️  Dedup semantico saltato (embed fallito: ${err.message})`);
    return data;
  }
  if (!(vec instanceof Float32Array) || vec.length === 0) {
    emitStoreObservation(log, data, opts, store, meta, 'embedding_empty', {
      policyThreshold: threshold,
      thresholdSource,
    });
    if (opts.failClosed === true) throw new DedupGateUnavailableError('embedding_empty', 'embedding vuoto');
    log('  ⏭️  Dedup semantico saltato (embedding vuoto)');
    return data;
  }

  // Gate cross-provider cosine: the query was embedded by whichever provider
  // actually answered (Mistral or its Cohere fallback). If that model differs
  // from the model the store was built with, findTopK degrades to a clean skip.
  const queryModel = opts.queryModel !== undefined ? opts.queryModel : lastUsedEmbeddingModel();
  if (store.dim !== vec.length) {
    emitStoreObservation(log, data, opts, store, meta, 'dimension_mismatch', {
      queryModel,
      policyThreshold: threshold,
      thresholdSource,
    });
    if (opts.failClosed === true) throw new DedupGateUnavailableError('dimension_mismatch', `dimensione query ${vec.length} diversa dallo store ${store.dim}`);
    log(`  ⏭️  Dedup semantico saltato (dimensione query ${vec.length} ≠ store ${store.dim})`);
    return data;
  }
  if (typeof meta?.model === 'string' && queryModel && meta.model !== queryModel) {
    emitStoreObservation(log, data, opts, store, meta, 'model_mismatch', {
      queryModel,
      policyThreshold: threshold,
      thresholdSource,
    });
    if (opts.failClosed === true) throw new DedupGateUnavailableError('model_mismatch', `modello dello store '${meta.model}' diverso dal provider attivo '${queryModel}'`);
    log(`  ⏭️  Dedup semantico saltato (store model '${meta.model}' ≠ provider attivo '${queryModel}' — cosine cross-provider non valida)`);
    return data;
  }
  if (opts.failClosed === true && !(typeof meta?.model === 'string' && queryModel)) {
    emitStoreObservation(log, data, opts, store, meta, 'compared_model_unverified', {
      queryModel,
      policyThreshold: threshold,
      thresholdSource,
    });
    throw new DedupGateUnavailableError('compared_model_unverified', 'modello dello store o della query non verificabile');
  }
  const ignoreNeighbor = typeof opts.ignoreNeighbor === 'function'
    ? opts.ignoreNeighbor
    : null;
  // If the caller excludes a recurring family, search the complete store so
  // several excluded editions cannot hide a real non-family duplicate just
  // beyond the normal top-K window.
  const searchK = ignoreNeighbor && Number.isInteger(store.count)
    ? Math.max(k, store.count)
    : k;
  const topK = findTopK(vec, { store, meta, k: searchK, queryModel });

  // The new article isn't in the store yet, but a re-publish could match
  // itself — exclude any neighbour that resolves to this same article.
  const selfSlug = data?.slugs?.it || data?.slug || data?.id;
  const nearest = topK.find((t) => (
    t.slug
    && t.slug !== selfSlug
    && t.slug !== data?.id
    && !ignoreNeighbor?.(t.slug)
  ));

  if (nearest && nearest.cosine >= threshold) {
    emitStoreObservation(log, data, opts, store, meta, 'duplicate_rejected', {
      queryModel,
      gateApplied: true,
      policyThreshold: threshold,
      effectiveThreshold: threshold,
      thresholdSource,
    });
    throw new Error(
      `❌ DUPLICATO SEMANTICO RILEVATO:\n`
      + `   Nuovo:     "${title}" [${data?.id}]\n`
      + `   Esistente: [${nearest.slug}]\n`
      + `   Cosine:    ${nearest.cosine.toFixed(3)} ≥ ${threshold} (near-duplicate)\n`
      + `   Stessa notizia con parole diverse — scegli un argomento distinto o più specifico.`,
    );
  }

  emitStoreObservation(log, data, opts, store, meta,
    typeof meta?.model === 'string' && queryModel ? 'compared' : 'compared_model_unverified', {
      queryModel,
      gateApplied: true,
      policyThreshold: threshold,
      effectiveThreshold: threshold,
      thresholdSource,
    });
  log(
    '  ✅ Nessun duplicato semantico'
    + (nearest ? ` (vicino più simile: ${nearest.slug} @ ${nearest.cosine.toFixed(3)})` : ''),
  );
  return data;
}
