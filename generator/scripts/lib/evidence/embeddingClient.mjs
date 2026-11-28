// Embedding client — LOCAL inference, NO API keys / quota / rate limits.
//
// Runs `multilingual-e5-small` (384-dim, IT/EN/DE/FR) via @huggingface/transformers
// (onnxruntime) directly on the CI runner. This REPLACED the Mistral → Cohere →
// Gemini API chain: every free-tier key had died/exhausted (Mistral 401, Cohere
// trial 1000/month spent, Gemini free 1000/day < the ~2700-article corpus), so a
// full re-embed was impossible and the embedding store froze (→ P1
// B.6.embedding-store-outdated → "Quality alerts" main-red). Local inference
// embeds the whole corpus in one run, deterministically, free forever.
//
// The model weights download once from the public HuggingFace CDN (no key) and
// are cached under `.cache/transformers` (env.cacheDir below; CI-cacheable).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBEDDING_DIM, EMBEDDING_MODEL } from './constants.mjs';

const NO_PROVIDER_MSG = 'local embedding model unavailable';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Cartella della cache dei pesi, sempre assoluta: un percorso relativo si
 * risolve contro la cwd del processo (un worktree, una sottocartella), non
 * contro la radice del repo dove `.gitignore` e actions/cache la aspettano.
 */
export function resolveTransformersCacheDir(env = process.env, repoRoot = REPO_ROOT) {
  const configured = env.TRANSFORMERS_CACHE || '.cache/transformers';
  return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
}

/**
 * L2-normalize a vector in place and return it. The pipeline already returns
 * normalized vectors (`normalize: true`); this is a defensive belt so any future
 * pooling/option change can't silently emit non-unit vectors into the store.
 */
function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

// Lazy singleton: the model loads once per process. Injectable for tests
// (setEmbedderForTests) so unit tests never download/run the real model.
let _extractor = null;
let _extractorOverride = null;

/** Test seam: inject a fake feature-extraction callable; pass null to reset. */
export function setEmbedderForTests(fn) {
  _extractorOverride = fn;
  _extractor = null;
}

/** Tentativi e backoff del download/inizializzazione del modello (M6). */
export const MODEL_INIT_ATTEMPTS = 3;
export const MODEL_INIT_BASE_BACKOFF_MS = 5000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Esegue `load` con un numero limitato di tentativi e backoff esponenziale
 * (5 s, poi 20 s). Il download del modello (~470 MB dalla CDN pubblica
 * HuggingFace) e' l'unico passo del dedup che dipende dalla rete: un guasto
 * transitorio non deve fermare il run, uno persistente deve salire al gate
 * fail-closed come esito dichiarato (DedupGateUnavailableError), non come
 * errore non dichiarato. `EMBEDDING_INIT_BACKOFF_MS` sostituisce la base (0 nei test).
 *
 * @param {() => Promise<T>} load
 * @param {{attempts?: number, baseBackoffMs?: number, sleep?: (ms: number) => Promise<void>, log?: (msg: string) => void}} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function initWithRetry(load, opts = {}) {
  const attempts = opts.attempts ?? MODEL_INIT_ATTEMPTS;
  const envBase = Number(process.env.EMBEDDING_INIT_BACKOFF_MS);
  const base = opts.baseBackoffMs ?? (Number.isFinite(envBase) && envBase >= 0 ? envBase : MODEL_INIT_BASE_BACKOFF_MS);
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((msg) => console.error(msg));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await load();
    } catch (err) {
      lastError = err;
      const message = String(err?.message ?? err).slice(0, 200);
      if (attempt < attempts) {
        const delay = base * 4 ** (attempt - 1);
        log(`EMBEDDING_MODEL_INIT_RETRY attempt=${attempt}/${attempts} delayMs=${delay} error=${JSON.stringify(message)}`);
        await sleep(delay);
      } else {
        log(`EMBEDDING_MODEL_INIT_FAILED attempts=${attempts} error=${JSON.stringify(message)}`);
      }
    }
  }
  throw lastError;
}

/** Tentativi dell'inferenza ONNX (un errore transitorio di sessione/memoria non perde l'articolo). */
export const INFERENCE_ATTEMPTS = 2;
export const INFERENCE_BACKOFF_MS = 1000;

/**
 * Un solo ritentativo, con attesa breve, sulla chiamata di inferenza. Copre
 * solo l'errore dell'estrattore: la validazione della forma/dimensione dei
 * vettori resta fuori (e' deterministica, ritentarla non la cambia). Il tetto
 * a 2 tentativi evita che un guasto vero (input non valido, OOM persistente)
 * allunghi il run; poi l'errore sale e il gate fail-closed lo dichiara.
 */
async function runInferenceWithRetry(run) {
  const envBackoff = Number(process.env.EMBEDDING_INIT_BACKOFF_MS);
  const delay = Number.isFinite(envBackoff) && envBackoff >= 0 ? Math.min(envBackoff, INFERENCE_BACKOFF_MS) : INFERENCE_BACKOFF_MS;
  let lastError;
  for (let attempt = 1; attempt <= INFERENCE_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      if (attempt < INFERENCE_ATTEMPTS) {
        console.error(`EMBEDDING_INFERENCE_RETRY attempt=${attempt}/${INFERENCE_ATTEMPTS} delayMs=${delay} error=${JSON.stringify(String(err?.message ?? err).slice(0, 200))}`);
        await defaultSleep(delay);
      }
    }
  }
  throw lastError;
}

async function getExtractor() {
  if (_extractorOverride) return _extractorOverride;
  if (!_extractor) {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Cache model weights in the repo (.cache/transformers) instead of
    // node_modules so CI can persist them across runs (actions/cache).
    env.cacheDir = resolveTransformersCacheDir();
    // dtype pinned for reproducibility: the committed store is built with this
    // exact dtype so daily incremental additions stay in one consistent vector
    // space (model id alone doesn't distinguish dtype). fp32 (~470MB) is used
    // because it's what the committed store was generated with; switching to
    // 'q8' (~110MB, 4× smaller CI cache, negligible quality loss) is a safe
    // follow-up but requires regenerating the committed store with q8 in the
    // same change so the spaces match.
    _extractor = await initWithRetry(() => pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'fp32' }));
  }
  return _extractor;
}

// Model id that produced the most recent successful embedding (always the local
// model). The incremental build reads this to detect provider/model drift vs the
// persisted store (meta.model) and force a one-time full re-embed when it
// changes — exactly what happened switching mistral-embed → e5.
let _lastUsedModel = null;
export function lastUsedEmbeddingModel() {
  return _lastUsedModel;
}

/**
 * Embed a batch of strings locally. Returns one unit-norm Float32Array(384) per
 * input, in order. No network, no key, no batch-size cap (CPU-bound only).
 *
 * prefix: e5 task prefix applied before each input.
 *   "passage" (default) — for document/passage encoding: store building,
 *     dedup where both sides are full article text (title + excerpt).
 *   "query" — for the retrieval query side: a shorter text (e.g. a headline)
 *     searched against a passage-encoded store. Use embedQuery() instead of
 *     calling this directly with prefix:"query".
 *
 * @param {object} options
 * @param {string[]} options.inputs
 * @param {'passage'|'query'} [options.prefix='passage']
 * @returns {Promise<Float32Array[]>}
 */
export async function embedBatch({ inputs, prefix = 'passage' } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const extractor = await getExtractor();
  const prefixed = inputs.map((t) => `${prefix}: ${String(t ?? '')}`);
  const out = await runInferenceWithRetry(() => extractor(prefixed, { pooling: 'mean', normalize: true }));
  const rows = typeof out?.tolist === 'function' ? out.tolist() : out;
  if (!Array.isArray(rows) || rows.length !== inputs.length) {
    throw new Error(`local embedder returned ${rows?.length} vectors for ${inputs.length} inputs`);
  }
  const vecs = rows.map((v) => l2normalize(Float32Array.from(v)));
  for (const v of vecs) {
    if (v.length !== EMBEDDING_DIM) {
      throw new Error(`local embedding dim=${v.length} expected ${EMBEDDING_DIM}`);
    }
  }
  _lastUsedModel = EMBEDDING_MODEL;
  return vecs;
}

/** Convenience wrapper: passage-encode a single string (store building, symmetric dedup). */
export async function embedOne(text, options = {}) {
  const [vec] = await embedBatch({ inputs: [text], ...options });
  return vec;
}

/**
 * Query-encode a single string for asymmetric retrieval against the passage-encoded
 * article store. Use in scoreFromEmbedding (headline → findTopK) where the querying
 * side is shorter than the stored passages. Mirrors the multilingual-e5-small
 * training setup: query: prefix on the search side, passage: on the document side.
 */
export async function embedQuery(text) {
  const [vec] = await embedBatch({ inputs: [text], prefix: 'query' });
  return vec;
}

/**
 * Backwards-compat shim: the API-chain era returned the first keyed provider (or
 * null) so callers could graceful-skip when no key was set. The local model is
 * always available, so a provider is always "selectable". `build-article-embeddings`
 * uses this to decide whether to attempt embedding at all.
 * @returns {{id:string, model:string, dim:number}}
 */
export function selectProvider() {
  return { id: 'local', model: EMBEDDING_MODEL, dim: EMBEDDING_DIM };
}

export { NO_PROVIDER_MSG };
