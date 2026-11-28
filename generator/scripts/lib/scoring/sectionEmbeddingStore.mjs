// generator/scripts/lib/scoring/sectionEmbeddingStore.mjs
//
// Materializza lo store di embedding PER SEZIONE che il gate di dedup semantico
// (`checkSemanticNearDuplicate`) legge da `SECTION.embeddingsBinPath`.
//
// Perche' esiste (M6 della cadenza, 2026-11-28): nel corpus nessuno scriveva
// `data/article-embeddings.bin` e gli analoghi svizzera/cantonali. Il builder
// storico (`build-article-embeddings.mjs`) vive nel sito, copre solo la
// sezione frontaliere e i suoi artefatti non scendono in questo repo. Il gate
// quindi vedeva `store_missing` in ogni run e pubblicava senza dedup (19/19
// osservazioni del 27/11 sul marker GENERATION_DEDUP_STORE).
//
// Qui lo store si costruisce dalla stessa sorgente che il generatore gia' legge
// (`services/locales/<metaPrefix>-it.ts`), con lo stesso modello, lo stesso
// prefisso e lo stesso testo del gate:
//   - testo: `buildDedupText(title, excerpt)` (identico a `articleText` del sito);
//   - modello: `EMBEDDING_MODEL`, prefisso e5 `passage:` (default di `embedBatch`,
//     lo stesso che usa `embedOne` per il candidato);
//   - formato: EMBV1 (header 32 B + record da 32 B di sha256(id) + dim*4 B),
//     letto da `loadEmbeddingStore`.
// E' incrementale: un articolo e' ri-embeddato solo se manca o se il suo testo
// e' cambiato (`textSha` nel meta), e un meta di un altro modello/dimensione
// scarta tutto lo store (cosine fra spazi diversi e' priva di senso).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { EMBEDDING_DIM, EMBEDDING_MODEL } from '../evidence/constants.mjs';
import { embedBatch } from '../evidence/embeddingClient.mjs';
import { readStaticMetaFields } from '../meta-field-regex.mjs';
import { loadEmbeddingMeta, loadEmbeddingStore } from './embeddingMatcher.mjs';
import { DedupGateUnavailableError, buildDedupText } from './semanticDedup.mjs';

const MAGIC = Buffer.from('EMBV1\0\0\0', 'binary');
const HEADER_BYTES = 32;
const HASH_BYTES = 32;
const RECORD_PAYLOAD_BYTES = EMBEDDING_DIM * 4;
const RECORD_BYTES = HASH_BYTES + RECORD_PAYLOAD_BYTES;
const BATCH_SIZE = 32;
const ID_PATTERN = /^[a-z0-9-]+$/;

/** Versione del formato del testo/ del meta: cambiarla forza un rebuild completo. */
export const SECTION_STORE_SCHEMA = 'section-dedup-store-v1';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();

/**
 * Articoli della sezione con il testo che il gate confronta.
 *
 * @param {Array<{source: string, sourcePath: string}>} modules sorgenti IT gia' lette
 * @returns {Map<string, {text: string, textSha: string}>}
 */
export function collectSectionDedupArticles(modules) {
  const { title, excerpt } = readStaticMetaFields(modules, ['title', 'excerpt']);
  const titles = new Map();
  const excerpts = new Map();
  for (const { id, value } of title) if (!titles.has(id)) titles.set(id, value);
  for (const { id, value } of excerpt) if (!excerpts.has(id)) excerpts.set(id, value);
  const out = new Map();
  for (const id of [...new Set([...titles.keys(), ...excerpts.keys()])].sort()) {
    if (!ID_PATTERN.test(id)) continue;
    const text = buildDedupText(titles.get(id) ?? '', excerpts.get(id) ?? '');
    out.set(id, { text, textSha: sha256(text).toString('hex').slice(0, 16) });
  }
  return out;
}

function readReusableVectors(binPath, metaPath, log) {
  const reusable = new Map(); // id -> { payload: Buffer, textSha }
  const store = loadEmbeddingStore({ binPath, force: true });
  const meta = loadEmbeddingMeta({ metaPath, force: true });
  if (!store && !meta) return { reusable, discarded: null, compatible: false };
  const compatible = store && meta
    && meta.schema === SECTION_STORE_SCHEMA
    && meta.model === EMBEDDING_MODEL
    && meta.dim === EMBEDDING_DIM
    && store.dim === EMBEDDING_DIM
    && meta.perArticle && typeof meta.perArticle === 'object';
  if (!compatible) {
    const reason = !store ? 'store_unreadable' : !meta ? 'meta_unreadable'
      : meta.schema !== SECTION_STORE_SCHEMA ? `schema:${meta.schema ?? 'none'}`
        : meta.model !== EMBEDDING_MODEL ? `model:${meta.model}`
          : 'dimension_or_map';
    log(`  ♻️  Store dedup scartato (${reason}): ricostruzione completa`);
    return { reusable, discarded: reason, compatible: false };
  }
  const indexByHash = new Map(store.hashes.map((hash, index) => [hash, index]));
  for (const [id, entry] of Object.entries(meta.perArticle)) {
    const index = indexByHash.get(entry?.hash);
    if (index === undefined || typeof entry.textSha !== 'string') continue;
    const vector = store.vectors[index];
    reusable.set(id, {
      textSha: entry.textSha,
      payload: Buffer.from(vector.buffer, vector.byteOffset, RECORD_PAYLOAD_BYTES),
    });
  }
  return { reusable, discarded: null, compatible: true };
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * Porta lo store di una sezione allo stato della sua sorgente IT.
 *
 * @param {{
 *   section: string,
 *   binPath: string,
 *   metaPath: string,
 *   metaItPaths: string[],
 *   embedFn?: (args: {inputs: string[]}) => Promise<Float32Array[]>,
 *   log?: (msg: string) => void,
 *   now?: () => Date,
 * }} opts `metaItPaths` mancanti sono ignorati (sezione ancora vuota).
 * @returns {Promise<{section: string, total: number, reused: number, embedded: number, rebuilt: boolean}>}
 */
export async function buildSectionEmbeddingStore(opts) {
  const log = opts.log || ((msg) => console.error(msg));
  const embed = opts.embedFn || embedBatch;
  const modules = opts.metaItPaths
    .filter((path) => existsSync(path))
    .map((path) => ({ source: readFileSync(path, 'utf8'), sourcePath: path }));
  const articles = collectSectionDedupArticles(modules);

  const { reusable, discarded, compatible } = readReusableVectors(opts.binPath, opts.metaPath, log);
  const records = [];
  const toEmbed = [];
  let reused = 0;
  for (const [id, article] of articles) {
    const hit = reusable.get(id);
    if (hit && hit.textSha === article.textSha) {
      records.push({ id, textSha: article.textSha, payload: hit.payload });
      reused += 1;
    } else {
      toEmbed.push({ id, ...article });
    }
  }

  // Testi di lunghezza simile nello stesso batch: il padding al piu' lungo
  // domina il costo del forward su CPU, e l'ordine non cambia i vettori.
  toEmbed.sort((a, b) => a.text.length - b.text.length || (a.id < b.id ? -1 : 1));
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    const vectors = await embed({ inputs: batch.map((item) => item.text) });
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new Error(`embedder ha restituito ${vectors?.length} vettori per ${batch.length} testi`);
    }
    batch.forEach((item, j) => {
      const vector = vectors[j];
      if (!(vector instanceof Float32Array) || vector.length !== EMBEDDING_DIM) {
        throw new Error(`vettore non valido per ${item.id} (dim ${vector?.length}, attesa ${EMBEDDING_DIM})`);
      }
      records.push({
        id: item.id,
        textSha: item.textSha,
        payload: Buffer.from(vector.buffer, vector.byteOffset, RECORD_PAYLOAD_BYTES),
      });
    });
    log(`  🧮 Store dedup ${opts.section}: ${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length} embedding`);
  }

  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = Buffer.alloc(HEADER_BYTES + records.length * RECORD_BYTES);
  MAGIC.copy(out, 0);
  out.writeUInt32LE(records.length, 8);
  out.writeUInt32LE(EMBEDDING_DIM, 12);
  const perArticle = {};
  let offset = HEADER_BYTES;
  for (const record of records) {
    const hash = sha256(record.id);
    hash.copy(out, offset);
    record.payload.copy(out, offset + HASH_BYTES);
    perArticle[record.id] = { hash: hash.toString('hex'), byteOffset: offset, textSha: record.textSha };
    offset += RECORD_BYTES;
  }

  // Il bin per primo: un meta senza bin non e' leggibile, un bin senza meta
  // porta a `store_unreadable`/ricostruzione al giro dopo, mai a un confronto sbagliato.
  const unchanged = compatible && toEmbed.length === 0 && reusable.size === records.length;
  if (!unchanged) {
    atomicWrite(opts.binPath, out);
    atomicWrite(opts.metaPath, `${JSON.stringify({
      schema: SECTION_STORE_SCHEMA,
      model: EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      dtype: 'fp32',
      prefix: 'passage',
      textFormat: 'buildDedupText(title, excerpt)',
      count: records.length,
      section: opts.section,
      builtAt: (opts.now ? opts.now() : new Date()).toISOString(),
      perArticle,
    }, null, 1)}\n`);
  }
  const summary = {
    section: opts.section,
    total: records.length,
    reused,
    embedded: toEmbed.length,
    rebuilt: Boolean(discarded) || reused === 0,
  };
  log(`DEDUP_STORE_BUILD ${JSON.stringify({ schemaVersion: 1, model: EMBEDDING_MODEL, dim: EMBEDDING_DIM, written: !unchanged, ...summary })}`);
  return summary;
}

const ensured = new Map();

/**
 * Una volta per processo e per store: assicura che lo store esista ed e'
 * allineato alla sorgente, poi lo restituisce nella forma che il gate accetta.
 * Se la costruzione fallisce l'errore sale: il chiamante usa il gate fail-closed.
 *
 * @param {{section: string, embeddingsBinPath: string, embeddingsMetaPath: string, metaPrefix: string}} sectionConfig
 * @param {object} [overrides] seam per i test (`embedFn`, `log`, `metaItPaths`)
 */
export async function prepareSectionDedupStore(sectionConfig, overrides = {}) {
  const key = sectionConfig.embeddingsBinPath;
  if (!ensured.has(key) || overrides.force) {
    ensured.set(key, buildSectionEmbeddingStore({
      section: sectionConfig.section,
      binPath: sectionConfig.embeddingsBinPath,
      metaPath: sectionConfig.embeddingsMetaPath,
      metaItPaths: overrides.metaItPaths || [`services/locales/${sectionConfig.metaPrefix}-it.ts`],
      embedFn: overrides.embedFn,
      log: overrides.log,
    }));
    ensured.get(key).catch(() => ensured.delete(key));
  }
  try {
    await ensured.get(key);
  } catch (err) {
    // Modello non scaricabile o costruzione fallita (dopo i retry di
    // embeddingClient): il gate e' fail-closed, e il guasto e' un esito
    // dichiarato (DedupGateUnavailableError), non un errore generico.
    if (err instanceof DedupGateUnavailableError) throw err;
    throw new DedupGateUnavailableError('store_build_failed', `costruzione dello store fallita: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  return {
    store: loadEmbeddingStore({ binPath: sectionConfig.embeddingsBinPath, force: true }),
    meta: loadEmbeddingMeta({ metaPath: sectionConfig.embeddingsMetaPath, force: true }),
  };
}

/** Test seam. */
export function __resetPreparedStores() {
  ensured.clear();
}
