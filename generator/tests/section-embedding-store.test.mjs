/**
 * section-embedding-store.test.mjs — M6: il dedup semantico gira davvero.
 *
 * Difetto chiuso: nel corpus nessuno scriveva lo store `*-embeddings.bin`, quindi
 * `checkSemanticNearDuplicate` vedeva `store_missing` in ogni run e pubblicava
 * senza dedup (19/19 osservazioni del 27/11). Qui si prova:
 *  · lo store si costruisce dalla sorgente IT della sezione, in modo incrementale;
 *  · un modello/schema diverso scarta lo store (niente cosine fra spazi diversi);
 *  · il gate in produzione e' fail-closed (store assente, embed fallito, modello
 *    non verificabile) e il marker lo dichiara;
 *  · un duplicato vero viene rifiutato con lo store costruito qui;
 *  · il marker di un confronto reale rende la sezione `active_verified` per
 *    `measure-section-cadence.mjs`.
 * L'embedder e' finto e deterministico: nessun download del modello.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { EMBEDDING_DIM, EMBEDDING_MODEL } from '../scripts/lib/evidence/constants.mjs';
import { __resetCache, loadEmbeddingMeta, loadEmbeddingStore } from '../scripts/lib/scoring/embeddingMatcher.mjs';
import {
  buildSectionEmbeddingStore,
  collectSectionDedupArticles,
  prepareSectionDedupStore,
  __resetPreparedStores,
} from '../scripts/lib/scoring/sectionEmbeddingStore.mjs';
import { DedupGateUnavailableError, buildDedupText, checkSemanticNearDuplicate } from '../scripts/lib/scoring/semanticDedup.mjs';
import { parseDedupStoreMarkers, summarizeDedupRuntimeEvidence } from '../../scripts/ci/measure-section-cadence.mjs';

function metaSource(entries) {
  const lines = entries.flatMap(([id, title, excerpt]) => [
    ` 'blog.article.${id}.title': '${title.replace(/'/g, "\\'")}',`,
    ` 'blog.article.${id}.excerpt': '${excerpt.replace(/'/g, "\\'")}',`,
  ]);
  return `const blogMetaIt: Record<string, string> = {\n${lines.join('\n')}\n};\n\nexport default blogMetaIt;\n`;
}

// Vettore deterministico per parola: testi con le stesse parole => stesso vettore
// (cosine 1), testi disgiunti => ~ortogonali.
function fakeVector(text) {
  const vec = new Float32Array(EMBEDDING_DIM);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    vec[Math.abs(h) % EMBEDDING_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}

describe('M6 store di embedding per sezione e dedup fail-closed', () => {
  let dir;
  let calls;
  let paths;
  const embedFn = async ({ inputs }) => {
    calls.push(...inputs);
    return inputs.map(fakeVector);
  };
  const logs = [];
  const log = (msg) => logs.push(msg);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'm6-store-'));
    calls = [];
    logs.length = 0;
    paths = {
      section: 'svizzera',
      binPath: join(dir, 'swiss-article-embeddings.bin'),
      metaPath: join(dir, 'swiss-article-embeddings-meta.json'),
      metaItPaths: [join(dir, 'blog-meta-ch-it.ts')],
      embedFn,
      log,
    };
    __resetCache();
    __resetPreparedStores();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    __resetCache();
    __resetPreparedStores();
  });

  const write = (entries) => writeFileSync(paths.metaItPaths[0], metaSource(entries));
  const A = ['assicurazione-malattia-2027', "Premi cassa malati 2027: l'aumento medio", 'Aumento dei premi LAMal in Svizzera per il 2027.'];
  const B = ['affitti-zurigo-2027', 'Affitti a Zurigo nel 2027', 'Canoni di locazione in crescita nella citta.'];

  it('usa lo stesso testo del gate (buildDedupText) e salta gli id non validi', () => {
    const map = collectSectionDedupArticles([{ source: metaSource([A, ['Bad_Id', 'x', 'y']]), sourcePath: 'm.ts' }]);
    assert.deepEqual([...map.keys()], ['assicurazione-malattia-2027']);
    assert.equal(map.get(A[0]).text, buildDedupText(A[1], A[2]));
  });

  it('costruisce store e meta coerenti (count, dim, modello, mappa completa)', async () => {
    write([A, B]);
    const summary = await buildSectionEmbeddingStore(paths);
    assert.deepEqual({ total: summary.total, embedded: summary.embedded, reused: summary.reused }, { total: 2, embedded: 2, reused: 0 });
    const store = loadEmbeddingStore({ binPath: paths.binPath, force: true });
    const meta = loadEmbeddingMeta({ metaPath: paths.metaPath, force: true });
    assert.equal(store.count, 2);
    assert.equal(store.dim, EMBEDDING_DIM);
    assert.equal(meta.model, EMBEDDING_MODEL);
    assert.equal(meta.count, 2);
    assert.equal(Object.keys(meta.perArticle).length, 2);
    assert.ok(logs.some((l) => l.startsWith('DEDUP_STORE_BUILD ')));
  });

  it('e incrementale: riusa i vettori, ri-embedda solo il nuovo o il testo cambiato', async () => {
    write([A, B]);
    await buildSectionEmbeddingStore(paths);
    calls.length = 0;
    const again = await buildSectionEmbeddingStore(paths);
    assert.equal(again.embedded, 0);
    assert.equal(calls.length, 0, 'nessun embedding se nulla e cambiato');

    const C = ['stipendi-ginevra-2027', 'Stipendi a Ginevra', 'Salari medi nel cantone.'];
    const B2 = [B[0], B[1], 'Testo riscritto completamente.'];
    write([A, B2, C]);
    const third = await buildSectionEmbeddingStore(paths);
    assert.deepEqual({ embedded: third.embedded, reused: third.reused, total: third.total }, { embedded: 2, reused: 1, total: 3 });
    assert.equal(calls.length, 2);
  });

  it('scarta uno store di un altro modello e ricostruisce tutto', async () => {
    write([A, B]);
    await buildSectionEmbeddingStore(paths);
    const meta = JSON.parse(readFileSync(paths.metaPath, 'utf8'));
    writeFileSync(paths.metaPath, JSON.stringify({ ...meta, model: 'altro/modello' }));
    calls.length = 0;
    const summary = await buildSectionEmbeddingStore(paths);
    assert.equal(summary.rebuilt, true);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(readFileSync(paths.metaPath, 'utf8')).model, EMBEDDING_MODEL);
  });

  it('una sezione ancora vuota produce uno store valido da zero vettori', async () => {
    write([]);
    const summary = await buildSectionEmbeddingStore(paths);
    assert.equal(summary.total, 0);
    assert.equal(loadEmbeddingStore({ binPath: paths.binPath, force: true }).count, 0);
  });

  const candidate = (title, excerpt, id = 'nuovo-articolo') => ({ id, content: { it: { title, excerpt } } });
  const gateEmbed = async (text) => fakeVector(text);
  const gateOpts = (extra = {}) => ({ section: 'svizzera', embedFn: gateEmbed, queryModel: EMBEDDING_MODEL, log, ...extra });

  it('rifiuta un duplicato vero con lo store costruito qui e passa un articolo distinto', async () => {
    write([A, B]);
    const section = { section: 'svizzera', embeddingsBinPath: paths.binPath, embeddingsMetaPath: paths.metaPath, metaPrefix: 'x' };
    const { store, meta } = await prepareSectionDedupStore(section, { ...paths });
    await assert.rejects(
      checkSemanticNearDuplicate(candidate(A[1], A[2]), gateOpts({ store, meta, failClosed: true })),
      /DUPLICATO SEMANTICO/,
    );
    await checkSemanticNearDuplicate(
      candidate('Pensione anticipata AVS', 'Requisiti per il prepensionamento in Svizzera.'),
      gateOpts({ store, meta, failClosed: true }),
    );
  });

  it('fail-closed: store assente, embed fallito, modello non verificabile e dimensione errata', async () => {
    write([A]);
    await buildSectionEmbeddingStore(paths);
    const store = loadEmbeddingStore({ binPath: paths.binPath, force: true });
    const meta = loadEmbeddingMeta({ metaPath: paths.metaPath, force: true });
    const data = candidate('Titolo qualunque', 'Testo qualunque.');
    const closed = (extra) => checkSemanticNearDuplicate(data, gateOpts({ failClosed: true, store, meta, ...extra }));

    await assert.rejects(closed({ store: null }), (e) => e instanceof DedupGateUnavailableError && e.status === 'store_missing');
    await assert.rejects(closed({ embedFn: async () => { throw new Error('boom'); } }), (e) => e.status === 'embedding_failed');
    await assert.rejects(closed({ embedFn: async () => new Float32Array(0) }), (e) => e.status === 'embedding_empty');
    await assert.rejects(closed({ embedFn: async () => new Float32Array(8).fill(0.1) }), (e) => e.status === 'dimension_mismatch');
    await assert.rejects(closed({ queryModel: 'altro/modello' }), (e) => e.status === 'model_mismatch');
    await assert.rejects(closed({ meta: { ...meta, model: undefined } }), (e) => e.status === 'compared_model_unverified');
    // L'errore non deve essere letto come «duplicato, prova un altro tema».
    await assert.rejects(closed({ store: null }), (e) => !/DUPLICATO/i.test(e.message));
  });

  it('senza failClosed il comportamento storico (fail-open) resta invariato', async () => {
    const out = await checkSemanticNearDuplicate(candidate('T', 'E'), gateOpts({ store: null }));
    assert.equal(out.id, 'nuovo-articolo');
  });

  it('i marker di un confronto reale rendono la sezione active_verified per M6', async () => {
    write([A, B]);
    const section = { section: 'svizzera', embeddingsBinPath: paths.binPath, embeddingsMetaPath: paths.metaPath, metaPrefix: 'x' };
    const { store, meta } = await prepareSectionDedupStore(section, { ...paths });
    const out = [];
    await checkSemanticNearDuplicate(
      candidate('Pensione anticipata AVS', 'Requisiti per il prepensionamento in Svizzera.'),
      gateOpts({ store, meta, failClosed: true, log: (m) => out.push(m), generationAttempt: 1 }),
    );
    const observations = parseDedupStoreMarkers(out.join('\n'));
    assert.equal(observations.length, 1);
    const [observation] = observations;
    assert.equal(observation.status, 'compared');
    assert.equal(observation.storeCount, 2);
    assert.equal(observation.metaModel, EMBEDDING_MODEL);
    assert.equal(observation.gateApplied, true);
    assert.ok(Number.isFinite(observation.effectiveThreshold));
    const summary = summarizeDedupRuntimeEvidence(observations, ['svizzera']).svizzera;
    assert.equal(summary.latestGateStatus, 'active_verified');
    assert.equal(summary.failOpenObservations, 0);
  });

  it('un fail-closed non e contato come fail-open dalla misura', async () => {
    const out = [];
    await assert.rejects(checkSemanticNearDuplicate(
      candidate('T', 'E'),
      gateOpts({ store: null, failClosed: true, log: (m) => out.push(m) }),
    ));
    const observations = parseDedupStoreMarkers(out.join('\n'));
    assert.equal(observations[0].failClosed, true);
    const summary = summarizeDedupRuntimeEvidence(observations, ['svizzera']).svizzera;
    assert.equal(summary.failOpenObservations, 0);
    assert.equal(summary.failClosedObservations, 1);
    assert.equal(summary.latestGateStatus, 'fail_closed:store_missing');
  });
});
