import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CDN,
  assertExpectedMainHead,
  classifyBootstrapLockAcquireResult,
  hasExpectedStagingBody,
  hasResponseBody,
  missingBootstrapPages,
  publishRelease,
  readPreviousRelease,
  releaseBase,
  waitForBootstrapLocks,
} from '../../scripts/publish-section-edge.mjs';
import { apiInputChangedInRange } from '../../scripts/lib/publish-api-input-range.mjs';
import { EDGE_SECTION_REGISTRY_FILE } from '../../scripts/lib/section-registry.mjs';
import { makeSectionBootstrapLock } from '../../scripts/lib/section-bootstrap-lock.mjs';
import { CORPUS_ROUTE_OWNER_META_TAG } from '../../engine/shared/corpusRouteOwner.mjs';

const bytes = Buffer.from('staging-fixture');
const file = {
  name: 'sitemap-cantons.xml',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

test('un lock recuperato dal publisher resta posseduto quando il comando e\' idempotente', () => {
  assert.equal(
    classifyBootstrapLockAcquireResult({ code: 0, stdout: "bootstrap lock gia' acquisito: canton-ti" }),
    'acquired',
  );
  assert.equal(
    classifyBootstrapLockAcquireResult({ code: 0, stdout: 'bootstrap lock acquisito atomicamente: canton-ti' }),
    'acquired',
  );
  assert.equal(classifyBootstrapLockAcquireResult({ code: 2, stdout: 'lock perso in gara' }), 'busy');
  assert.equal(classifyBootstrapLockAcquireResult({ code: 0, stdout: 'output inatteso' }), 'error');
});

test('la verifica staging rifiuta un 200 senza body senza lanciare', () => {
  assert.equal(hasResponseBody({ status: 200 }), false);
  assert.equal(hasResponseBody({ status: 200, body: bytes }), true);
  assert.equal(hasExpectedStagingBody({ status: 200 }, file), false);
  assert.equal(hasExpectedStagingBody({ status: 200, body: bytes }, file), true);
});

test('i consumer bootstrap e registry trattano un 200 senza body come non verificabile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'section-edge-empty-body-'));
  const sitemap = join(root, 'sitemap-articles-canton-ti.xml');
  writeFileSync(sitemap, '<urlset />');
  const emptyBodyIo = { fetchBytes: async () => ({ status: 200 }) };
  try {
    const locked = await waitForBootstrapLocks(['canton-ti'], emptyBodyIo, {
      deadline: 0,
      retryMs: 0,
    });
    assert.deepEqual(locked, ['canton-ti (lock non verificabile: body assente)']);

    const missing = await missingBootstrapPages(
      { live: ['canton-ti'], files: [{ name: 'sitemap-articles-canton-ti.xml', local: sitemap }] },
      { state: 'absent' },
      emptyBodyIo,
      { deadline: 0, retryMs: 0 },
    );
    assert.ok(missing.length > 0);
    assert.equal(await readPreviousRelease(emptyBodyIo).then((result) => result.state), 'unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('la readiness distingue producer terminali, attivi e non verificabili', async () => {
  const commit = 'a'.repeat(40);
  const owner = 'nanakokyobashi-rgb/frontaliere-articles:40594085901:1';
  const lock = makeSectionBootstrapLock({
    section: 'canton-ow',
    commit,
    owner,
    now: Date.now() - 1_000,
    ttlMs: 60 * 60 * 1000,
  });
  const takeovers = [];
  const logs = [];
  for (const state of ['terminal', 'active', 'unknown', 'unavailable']) {
    const pending = await waitForBootstrapLocks(['canton-ow'], {
      fetchBytes: async () => ({ status: 200, body: Buffer.from(JSON.stringify(lock)) }),
      readBootstrapLockOwnerRun: async () => {
        if (state === 'unavailable') throw new Error('GitHub non disponibile');
        return { state };
      },
      acquireBootstrapLock: async () => { takeovers.push(state); },
    }, {
      deadline: 0,
      retryMs: 0,
      log: (line) => logs.push(line),
    });
    assert.deepEqual(pending, state === 'terminal' ? [] : [`canton-ow (${owner})`]);
  }
  assert.deepEqual(takeovers, []);
  assert.match(logs.join('\n'), /owner .* terminato/);
});

test('publishRelease resta fail-closed quando un adapter CDN restituisce 200 senza body', async () => {
  const commit = 'a'.repeat(40);
  const base = releaseBase(commit);
  const key = `${base}${file.name}`;
  const release = {
    commit,
    base,
    registry: { schema: 1, commit, sections: {} },
    live: [],
    files: [{ ...file, local: '/tmp/staging-fixture', key }],
    pointer: {
      schema: 1,
      commit,
      sections: {},
      release: {
        commit,
        base,
        files: { [file.name]: { sha256: file.sha256, bytes: file.bytes } },
        previous: null,
      },
    },
  };
  const removed = [];
  const requests = [];
  const result = await publishRelease(release, {
    env: {
      R2_ACCESS_KEY_ID: 'test',
      R2_SECRET_ACCESS_KEY: 'test',
      R2_S3_ENDPOINT: 'test',
      R2_BUCKET: 'test',
      CF_API_TOKEN: 'test',
    },
    io: {
      fetchBytes: async (url) => {
        requests.push(url);
        if (url === `${CDN}/${EDGE_SECTION_REGISTRY_FILE}`) return { status: 404 };
        return { status: 200 };
      },
      upload: () => true,
      remove: (stagedKey) => {
        removed.push(stagedKey);
        return true;
      },
      acquireBootstrapLock: async () => 'acquired',
      releaseBootstrapLock: async () => true,
      purge: () => true,
      putRegistry: () => true,
    },
    stagingVerifyAttempts: 1,
    log: () => {},
  });

  assert.deepEqual(result, { code: 1, phase: 'staging', flipped: false });
  assert.deepEqual(removed, [key]);
  assert.equal(requests.length, 2);
});

async function runBootstrapScenario(t, { staleDuring, initialCheckMs = 0, releaseFails = false } = {}) {
  const commit = 'e'.repeat(40);
  const base = releaseBase(commit);
  const sitemapName = 'sitemap-articles-canton-ti.xml';
  const sitemapBytes = Buffer.from('<urlset />');
  const tempDir = mkdtempSync(join(tmpdir(), 'section-edge-bootstrap-budget-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const sitemapFile = {
    name: sitemapName,
    bytes: sitemapBytes.length,
    sha256: createHash('sha256').update(sitemapBytes).digest('hex'),
    local: join(tempDir, sitemapName),
  };
  writeFileSync(sitemapFile.local, sitemapBytes);
  sitemapFile.key = `${base}${sitemapName}`;

  const start = Date.now();
  let now = start;
  const lock = makeSectionBootstrapLock({
    section: 'canton-ti',
    commit,
    owner: 'nanakokyobashi-rgb/frontaliere-articles:12345:1',
    now: start,
    ttlMs: 60 * 60 * 1000,
  });
  let lockReads = 0;
  let acquireAttempts = 0;
  let flips = 0;
  const checks = [];
  const sleeps = [];
  const removed = [];
  const logs = [];
  const held = new Set();
  const live = staleDuring === 'acquire' ? ['canton-ti', 'canton-ow'] : ['canton-ti'];
  const files = live.map((section) => {
    const name = `sitemap-articles-${section}.xml`;
    return { ...sitemapFile, name, key: `${base}${name}` };
  });
  const result = await publishRelease({
    commit,
    base,
    registry: { schema: 1, commit, sections: { 'canton-ti': { status: 'live' } } },
    live,
    files,
    pointer: {
      schema: 1,
      commit,
      sections: { 'canton-ti': { status: 'live' } },
      release: {
        commit,
        base,
        files: Object.fromEntries(files.map(({ name, sha256, bytes }) => [name, { sha256, bytes }])),
        previous: null,
      },
    },
  }, {
    env: {
      R2_ACCESS_KEY_ID: 'test',
      R2_SECRET_ACCESS_KEY: 'test',
      R2_S3_ENDPOINT: 'test',
      R2_BUCKET: 'test',
      CF_API_TOKEN: 'test',
    },
    io: {
      fetchBytes: async (url) => {
        if (url === `${CDN}/${EDGE_SECTION_REGISTRY_FILE}`) return { status: 404 };
        if (files.some(({ key }) => url === `${CDN}/${key}`)) return { status: 200, body: sitemapBytes };
        if (url === `${CDN}/edge/sections/_bootstrap-locks/canton-ti.json`) {
          lockReads += 1;
          return (staleDuring === 'readiness' || (!staleDuring && now < start + 100)) ? { status: 200, body: Buffer.from(JSON.stringify(lock)) } : { status: 404 };
        }
        if (url.startsWith(`${CDN}/edge/sections/_bootstrap-locks/`)) return { status: 404 };
        if (url.startsWith(`${CDN}/edge/sections/`) && staleDuring !== 'pages') {
          return { status: 200, body: Buffer.from(CORPUS_ROUTE_OWNER_META_TAG) };
        }
        return { status: 404 };
      },
      upload: (_local, key) => {
        if (key === EDGE_SECTION_REGISTRY_FILE) {
          flips += 1;
          checks.push('flip');
        }
        return true;
      },
      remove: (key) => { removed.push(key); return true; },
      readBootstrapLockOwnerRun: async () => ({ state: 'active', status: 'in_progress' }),
      acquireBootstrapLock: async (section) => {
        acquireAttempts += 1;
        if (staleDuring === 'acquire') {
          if (section === 'canton-ti') return 'busy';
          held.add(section);
          return 'acquired';
        }
        return acquireAttempts <= 2 ? 'busy' : 'acquired';
      },
      releaseBootstrapLock: async (section) => {
        if (releaseFails) return false;
        held.delete(section);
        return true;
      },
      purge: () => true,
    },
    bootstrapWaitMs: staleDuring ? 300_000 : 100,
    bootstrapLockAcquireWaitMs: staleDuring ? 300_000 : 100,
    bootstrapRetryMs: staleDuring ? 20_000 : 20,
    stagingVerifyAttempts: 1,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    verifySourceCurrent: async () => {
      checks.push(now - start);
      assert.equal(held.size, 0);
      if (staleDuring && now - start >= 60_000) throw new Error('input API nuovo');
      if (checks.length === 1) now += initialCheckMs;
    },
    log: (line) => logs.push(line),
  });

  return { result, lockReads, acquireAttempts, flips, checks, sleeps, removed, stagedKeys: files.map(({ key }) => key), logs };
}

test('il primo controllo di freschezza consuma il budget di readiness con un producer attivo', async (t) => {
  const { result, lockReads, acquireAttempts, checks, sleeps } = await runBootstrapScenario(t, {
    staleDuring: 'readiness',
    initialCheckMs: 300_001,
  });
  assert.equal(lockReads, 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(checks, [0]);
  assert.equal(acquireAttempts, 0);
  assert.deepEqual(result, { code: 1, phase: 'bootstrap-lock', flipped: false });
});

test('il publisher concede un budget bounded separato all handshake finale dopo la readiness', async (t) => {
  const { result, lockReads, acquireAttempts, flips, checks } = await runBootstrapScenario(t);
  assert.deepEqual(checks, [0, 140, 'flip']);
  assert.deepEqual(result, { code: 0, phase: 'done', flipped: true });
  assert.equal(lockReads, 6, 'la readiness usa tutto il proprio budget prima dell handshake');
  assert.equal(acquireAttempts, 3, 'il lock viene ritentato nel budget indipendente');
  assert.equal(flips, 1, 'il puntatore viene flippato solo dopo il lease');
});

for (const staleDuring of ['readiness', 'pages', 'acquire']) {
  test(`il publisher abbandona lo staging superato durante ${staleDuring}`, async (t) => {
    const { result, flips, checks, removed, stagedKeys, logs, acquireAttempts } = await runBootstrapScenario(t, { staleDuring });
    assert.deepEqual(result, { code: 1, phase: 'freshness', flipped: false });
    assert.deepEqual(checks, [0, 120_000]);
    assert.equal(acquireAttempts, staleDuring === 'acquire' ? 12 : 0);
    assert.deepEqual(removed, stagedKeys);
    assert.equal(flips, 0);
    assert.match(logs.join('\n'), /input API nuovo/);
  });
}

test('un rilascio parziale fallito conserva l’errore di lock', async (t) => {
  const { result, flips, checks, logs } = await runBootstrapScenario(t, { staleDuring: 'acquire', releaseFails: true });
  assert.deepEqual(result, { code: 1, phase: 'bootstrap-lock', flipped: false });
  assert.deepEqual(checks, [0]);
  assert.equal(flips, 0);
  assert.match(logs.join('\n'), /release lock non confermato/);
});

test('publishRelease verifica la HEAD subito prima del flip edge', async () => {
  const commit = 'c'.repeat(40);
  const release = {
    commit,
    base: releaseBase(commit),
    registry: { schema: 1, commit, sections: { 'canton-ti': { status: 'retired' } } },
    live: [],
    files: [],
    pointer: {
      schema: 1,
      commit,
      sections: { 'canton-ti': { status: 'retired' } },
      release: { commit, base: releaseBase(commit), files: {}, previous: null },
    },
  };
  const uploads = [];
  const freshnessChecks = [];
  const result = await publishRelease(release, {
    env: {
      R2_ACCESS_KEY_ID: 'test',
      R2_SECRET_ACCESS_KEY: 'test',
      R2_S3_ENDPOINT: 'test',
      R2_BUCKET: 'test',
      CF_API_TOKEN: 'test',
    },
    io: {
      fetchBytes: async () => ({ status: 404 }),
      upload: (_local, key) => {
        uploads.push(key);
        return true;
      },
      remove: () => true,
      acquireBootstrapLock: async () => 'acquired',
      releaseBootstrapLock: async () => true,
      purge: () => true,
    },
    verifySourceCurrent: async () => {
      freshnessChecks.push('check');
      if (freshnessChecks.length === 2) throw new Error('main avanzata durante il test');
    },
    log: () => {},
  });

  assert.deepEqual(result, { code: 1, phase: 'freshness', flipped: false });
  assert.deepEqual(freshnessChecks, ['check', 'check']);
  assert.deepEqual(uploads, [], 'il puntatore non viene scritto dopo una freshness failure');
  await assert.rejects(
    () => assertExpectedMainHead(
      commit,
      async () => 'd'.repeat(40),
      { isAncestor: () => true, apiInputChanged: () => true },
    ),
    /main e' avanzato durante lo staging edge/,
  );
});

test('il guard edge consente un avanzamento di main solo bookkeeping e conserva il commit dell artifact', async () => {
  const source = 'a'.repeat(40);
  const current = 'b'.repeat(40);
  const gitCalls = [];
  assert.equal(
    await assertExpectedMainHead(
      source,
      async () => current,
      {
        isAncestor: () => true,
        apiInputChanged: (range) => apiInputChangedInRange(range, {
          triggerPathsImpl: () => ['content/**'],
          execFileSyncImpl: (command, args) => {
            gitCalls.push([command, ...args.slice(2)]);
            return '';
          },
        }),
      },
    ),
    current,
  );
  assert.deepEqual(gitCalls, [['git', 'rev-list', '--max-count=1', current, '^' + source, '--', 'content/**']]);
});

test('il guard edge classifica la HEAD appena acquisita dopo il controllo iniziale', async () => {
  const source = 'a'.repeat(40);
  const initiallyRead = 'b'.repeat(40);
  const fetched = 'c'.repeat(40);
  let classifiedRange;
  const gitCalls = [];
  await assert.rejects(
    () => assertExpectedMainHead(
      source,
      async () => initiallyRead,
      {
        isAncestor: () => ({ ancestor: true, current: fetched }),
        apiInputChanged: (range) => {
          classifiedRange = range;
          return apiInputChangedInRange(range, {
            triggerPathsImpl: () => ['content/**'],
            execFileSyncImpl: (command, args) => {
              gitCalls.push([command, ...args.slice(2)]);
              return fetched + '\n';
            },
          });
        },
      },
    ),
    new RegExp('→ ' + fetched + '.*input API nuovi'),
  );
  assert.deepEqual(classifiedRange, { before: source, after: fetched });
  assert.deepEqual(gitCalls, [['git', 'rev-list', '--max-count=1', fetched, '^' + source, '--', 'content/**']]);
});

test('il guard edge rifiuta una snapshot fetchata piu vecchia di quella autorevole', async () => {
  const source = 'a'.repeat(40);
  const authoritative = 'b'.repeat(40);
  const fetched = 'c'.repeat(40);
  await assert.rejects(
    () => assertExpectedMainHead(
      source,
      async () => authoritative,
      {
        isAncestor: () => ({ ancestor: false, current: fetched }),
        apiInputChanged: () => false,
      },
    ),
    /storia non riconciliabile/u,
  );
});

test('le letture di release e bootstrap restano fail-closed con un 200 senza body', async () => {
  assert.deepEqual(
    await readPreviousRelease({ fetchBytes: async () => ({ status: 200 }) }),
    { state: 'unknown' },
  );

  const commit = 'b'.repeat(40);
  const fileName = 'sitemap-cantons.xml';
  const registry = {
    schema: 1,
    commit,
    sections: { 'canton-ti': { status: 'draft' } },
    release: {
      commit,
      base: releaseBase(commit),
      files: { [fileName]: { sha256: '0'.repeat(64), bytes: 0 } },
    },
  };
  let registryRead = true;
  assert.deepEqual(
    await readPreviousRelease({
      fetchBytes: async () => {
        if (registryRead) {
          registryRead = false;
          return { status: 200, body: Buffer.from(JSON.stringify(registry)) };
        }
        return { status: 200 };
      },
    }),
    { state: 'unknown', doc: registry },
  );

  const dir = mkdtempSync(join(tmpdir(), 'frontaliere-3351-'));
  try {
    const sitemapName = 'sitemap-articles-canton-ti.xml';
    const sitemap = join(dir, sitemapName);
    writeFileSync(sitemap, '<urlset><url><loc>https://frontaliereticino.ch/articoli-ticino/</loc></url></urlset>');
    const calls = [];
    const pending = await missingBootstrapPages(
      {
        live: ['canton-ti'],
        files: [{ name: sitemapName, local: sitemap }],
      },
      {
        state: 'ok',
        doc: {
          sections: { 'canton-ti': { status: 'live' } },
          release: { base: releaseBase('c'.repeat(40)), files: { [sitemapName]: { sha256: '0'.repeat(64), bytes: 0 } } },
        },
      },
      { fetchBytes: async (url) => { calls.push(url); return { status: 200 }; } },
      { waitMs: 0, retryMs: 0 },
    );
    assert.ok(pending.length > 0);
    assert.ok(calls.length > 1, 'il controllo deve leggere sia la sitemap precedente sia le pagine');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
