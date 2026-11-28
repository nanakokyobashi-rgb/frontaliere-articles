/**
 * dedup-store-delivery.test.mjs — M6, round 2: il dedup semantico non sporca il
 * repo, non genera rossi non dichiarati e gira anche nei produttori secondari.
 *
 *  · modello (~470 MB), store e temporanei sono ignorati da git e `git add -A`
 *    (lo step di commit dei workflow) non puo' raccoglierli; `.cache/` NON e'
 *    ignorata per intero (`.cache/jobs-ai-cache.json` serve ai crawler);
 *  · il download/inizializzazione del modello ha retry limitati con backoff;
 *  · un guasto resta DedupGateUnavailableError (esito dichiarato, exit 4 con la
 *    riga GENERATION_OUTCOME dedicata), non un errore generico;
 *  · i produttori secondari hanno le stesse cache di generate-article.yml;
 *  · una finestra con sole osservazioni fail-closed ha uno stato esplicito.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { initWithRetry } from '../scripts/lib/evidence/embeddingClient.mjs';
import { __resetCache } from '../scripts/lib/scoring/embeddingMatcher.mjs';
import { __resetPreparedStores, prepareSectionDedupStore } from '../scripts/lib/scoring/sectionEmbeddingStore.mjs';
import { DedupGateUnavailableError, isDedupGateUnavailableError } from '../scripts/lib/scoring/semanticDedup.mjs';
import { summarizeDedupRuntimeEvidence } from '../../scripts/ci/measure-section-cadence.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

const STORE_FILES = [
  'data/article-embeddings.bin',
  'data/article-embeddings-meta.json',
  'data/swiss-article-embeddings.bin',
  'data/swiss-article-embeddings-meta.json',
  'data/sections/canton-ti/article-embeddings.bin',
  'data/sections/canton-ti/article-embeddings-meta.json',
];
const TMP_FILES = STORE_FILES.map((path) => `${path.replace(/\.(bin|json)$/, '.$1')}.tmp`);
const MODEL_FILES = [
  '.cache/transformers/Xenova/multilingual-e5-small/onnx/model.onnx',
  '.cache/transformers/Xenova/multilingual-e5-small/tokenizer.json',
];

describe('M6 round 2 — modello e store fuori dai commit', () => {
  let repo;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'm6-ignore-'));
    execFileSync('git', ['init', '-q', repo]);
    copyFileSync(join(REPO, '.gitignore'), join(repo, '.gitignore'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const ignored = (path) => {
    try {
      execFileSync('git', ['-C', repo, 'check-ignore', '-q', path]);
      return true;
    } catch {
      return false;
    }
  };
  const touch = (path) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), 'x');
  };

  it('git check-ignore: modello, store e temporanei sono ignorati', () => {
    for (const path of [...MODEL_FILES, ...STORE_FILES, ...TMP_FILES]) {
      assert.ok(ignored(path), `${path} deve essere ignorato`);
    }
  });

  it('.cache/ non e ignorata per intero: la cache dei crawler resta visibile', () => {
    assert.equal(ignored('.cache/jobs-ai-cache.json'), false);
  });

  it('git add -A (step di commit dei workflow) non puo includere modello, store ne temporanei', () => {
    const wanted = 'content/blog-body/it/nuovo-articolo.ts';
    for (const path of [...MODEL_FILES, ...STORE_FILES, ...TMP_FILES, wanted, '.cache/jobs-ai-cache.json']) touch(path);
    execFileSync('git', ['-C', repo, 'add', '-A']);
    const staged = execFileSync('git', ['-C', repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).sort();
    assert.deepEqual(staged, ['.cache/jobs-ai-cache.json', wanted, '.gitignore'].sort());
  });

  it('i temporanei dell atomicWrite hanno lo stesso suffisso ignorato', () => {
    const source = read('generator/scripts/lib/scoring/sectionEmbeddingStore.mjs');
    assert.match(source, /const tmp = `\$\{path\}\.tmp`/);
  });
});

describe('M6 round 2 — retry del modello e esito dichiarato', () => {
  it('initWithRetry riprova con backoff e ha successo al terzo tentativo', async () => {
    let calls = 0;
    const delays = [];
    const logs = [];
    const result = await initWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('ETIMEDOUT huggingface.co');
      return 'ok';
    }, { baseBackoffMs: 5, sleep: async (ms) => { delays.push(ms); }, log: (m) => logs.push(m) });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [5, 20]);
    assert.equal(logs.filter((m) => m.startsWith('EMBEDDING_MODEL_INIT_RETRY ')).length, 2);
  });

  it('initWithRetry e limitato: dopo 3 tentativi rilancia l ultimo errore', async () => {
    let calls = 0;
    const logs = [];
    await assert.rejects(
      initWithRetry(async () => { calls += 1; throw new Error(`down ${calls}`); }, { baseBackoffMs: 0, sleep: async () => {}, log: (m) => logs.push(m) }),
      /down 3/,
    );
    assert.equal(calls, 3);
    assert.ok(logs.some((m) => m.startsWith('EMBEDDING_MODEL_INIT_FAILED attempts=3')));
  });

  describe('prepareSectionDedupStore', () => {
    let dir;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'm6-prepare-'));
      __resetCache();
      __resetPreparedStores();
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      __resetPreparedStores();
    });

    it('un embedder non disponibile diventa DedupGateUnavailableError (dichiarato), non un errore generico', async () => {
      const metaIt = join(dir, 'meta-it.ts');
      writeFileSync(metaIt, "const m = {\n 'blog.article.uno.title': 'Titolo uno',\n 'blog.article.uno.excerpt': 'Estratto uno.',\n};\nexport default m;\n");
      await assert.rejects(
        prepareSectionDedupStore(
          { section: 'frontaliere', embeddingsBinPath: join(dir, 'a.bin'), embeddingsMetaPath: join(dir, 'a.json'), metaPrefix: 'x' },
          { metaItPaths: [metaIt], log: () => {}, embedFn: async () => { throw new Error('local embedding model unavailable'); } },
        ),
        (err) => {
          assert.ok(err instanceof DedupGateUnavailableError);
          assert.equal(err.status, 'store_build_failed');
          assert.equal(isDedupGateUnavailableError(err), true);
          return true;
        },
      );
    });

    it('isDedupGateUnavailableError non scambia un errore qualsiasi ne un DUPLICATO', () => {
      assert.equal(isDedupGateUnavailableError(new Error('boom')), false);
      assert.equal(isDedupGateUnavailableError(new Error('❌ DUPLICATO: titolo')), false);
      assert.equal(isDedupGateUnavailableError(null), false);
    });
  });

  it('create-article esce 4 con la riga GENERATION_OUTCOME dedicata e il workflow la classifica', () => {
    const create = read('generator/scripts/create-article.mjs');
    const branch = create.slice(create.indexOf('if (isDedupGateUnavailableError(e)) {'));
    const end = branch.indexOf('\n  }\n');
    const body = branch.slice(0, end);
    assert.match(body, /GENERATION_OUTCOME kind=no-article reason=dedup-unavailable section=\$\{SECTION_NAME\}/);
    assert.match(body, /exitAfterFlush\(EXIT_NO_ARTICLE_DECLARED\)/);
    for (const file of ['.github/workflows/generate-article.yml', '.github/workflows/generate-article-core.yml']) {
      const wf = read(file);
      assert.match(wf, /grep -q 'reason=dedup-unavailable' "\$stall_log" && declared_reason=dedup-unavailable/, file);
      assert.match(wf, /outcome_reason="\$\{declared_reason:-declared\}"/, file);
    }
  });
});

describe('M6 round 2 — produttori secondari', () => {
  const cachePaths = (text) => /name: Cache section dedup embedding store[\s\S]*?path: \|\n((?: {12}\S.*\n)+)/.exec(text)?.[1];
  const reference = cachePaths(read('.github/workflows/generate-article.yml'));

  for (const name of ['generate-daily-brief', 'publish-journalist-articles', 'refresh-events-digest', 'generate-border-wait-ranking-weekly']) {
    it(`${name}.yml ha le cache di modello e store, prima della generazione`, () => {
      const wf = read(`.github/workflows/${name}.yml`);
      assert.ok(reference, 'path della cache di riferimento letti');
      assert.equal(cachePaths(wf), reference, 'stesso elenco di path => stesso archivio di generate-article.yml');
      assert.match(wf, /path: \.cache\/transformers\n {10}key: transformers-multilingual-e5-small-fp32-v1/);
      const firstCache = wf.indexOf('Cache local embedding model (dedup)');
      const firstGenerate = wf.search(/node generator\/scripts\/(generate-|publish-journalist)|tsx@[\d.]+ generator\/scripts\/generate-/);
      assert.ok(firstCache > 0 && firstCache < firstGenerate, 'la cache precede il produttore');
    });
  }

  it('i timeout dei produttori che scaricano il modello a freddo non sono piu stretti', () => {
    const timeout = (name) => Number(/timeout-minutes: (\d+)/.exec(read(`.github/workflows/${name}.yml`))?.[1]);
    assert.ok(timeout('generate-daily-brief') >= 40);
    assert.ok(timeout('refresh-events-digest') >= 35);
    assert.ok(timeout('generate-border-wait-ranking-weekly') >= 35);
  });
});

describe('M6 round 2 — misura: finestra con sole osservazioni fail-closed', () => {
  const failClosed = (status) => ({
    section: 'frontaliere', status, gateApplied: false, failClosed: true, observedAt: '2026-11-28T10:00:00Z',
  });

  it('e fail_closed_only_in_window, non fail-open ne verificata', () => {
    const summary = summarizeDedupRuntimeEvidence([failClosed('store_missing'), failClosed('embedding_failed')], ['frontaliere']).frontaliere;
    assert.equal(summary.windowGateStatus, 'fail_closed_only_in_window');
    assert.equal(summary.failOpenObservations, 0);
    assert.equal(summary.failClosedObservations, 2);
  });

  it('un fail-open nella stessa finestra resta fail_open_observed_in_window', () => {
    const summary = summarizeDedupRuntimeEvidence([
      failClosed('store_missing'),
      { section: 'frontaliere', status: 'store_missing', gateApplied: false, failClosed: false, observedAt: '2026-11-28T11:00:00Z' },
    ], ['frontaliere']).frontaliere;
    assert.equal(summary.windowGateStatus, 'fail_open_observed_in_window');
  });
});
