import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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
  releaseOlderThanLive,
  adoptWaitMaxAgeMs,
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

async function runBootstrapScenario(t, { staleDuring, initialCheckMs = 0, releaseFails = false, adoptAfterMinutes = null, waitMs = null } = {}) {
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
  const advanceState = { firstSeenAt: null };
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
    bootstrapWaitMs: waitMs ?? (staleDuring ? 300_000 : 100),
    bootstrapLockAcquireWaitMs: waitMs ?? (staleDuring ? 300_000 : 100),
    bootstrapRetryMs: staleDuring ? 20_000 : 20,
    stagingVerifyAttempts: 1,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    verifySourceCurrent: adoptAfterMinutes !== null
      // main e' avanzato con input API gia' al primo controllo: la policy adopt
      // lascia pubblicare, ma le ATTESE si interrompono oltre N minuti.
      ? async (context) => {
        checks.push(`${context?.phase}:${now - start}`);
        return assertExpectedMainHead(commit, async () => 'f'.repeat(40), {
          isAncestor: () => true,
          apiInputChanged: () => true,
          adoptApiAdvance: true,
          adoptMaxAgeMs: context?.phase === 'wait' ? adoptAfterMinutes * 60_000 : null,
          advanceState,
          now: () => now,
          log: () => {},
        });
      }
      : async () => {
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

test('con adoptApiAdvance il guard edge adotta un main avanzato con input API nuovi e lascia il delta alla run successiva', async () => {
  const source = 'a'.repeat(40);
  const current = 'd'.repeat(40);
  const logs = [];
  assert.equal(
    await assertExpectedMainHead(source, async () => current, {
      isAncestor: () => true,
      apiInputChanged: () => true,
      adoptApiAdvance: true,
      log: (line) => logs.push(line),
    }),
    current,
  );
  assert.match(logs.join('\n'), /input API nuovi: si pubblica lo snapshot gia' in staging/);
  // Una storia non riconciliabile resta un rifiuto anche in modalita adopt.
  await assert.rejects(
    () => assertExpectedMainHead(source, async () => current, {
      isAncestor: () => false,
      apiInputChanged: () => true,
      adoptApiAdvance: true,
    }),
    /storia non riconciliabile/,
  );
  // Input non classificabili: nessuna adozione.
  await assert.rejects(
    () => assertExpectedMainHead(source, async () => current, {
      isAncestor: () => true,
      apiInputChanged: () => { throw new Error('git rotto'); },
      adoptApiAdvance: true,
    }),
    /input API non classificabili/,
  );
});

function regressionRelease(commit) {
  return {
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
}

const CREDS = {
  R2_ACCESS_KEY_ID: 'test',
  R2_SECRET_ACCESS_KEY: 'test',
  R2_S3_ENDPOINT: 'test',
  R2_BUCKET: 'test',
  CF_API_TOKEN: 'test',
};

async function publishAgainstLive({ releaseCommit, liveCommit, olderThanLive, freshnessThrows = false }) {
  const live = {
    schema: 1,
    commit: liveCommit,
    sections: { 'canton-ti': { status: 'live' } },
    release: { commit: liveCommit, base: releaseBase(liveCommit), files: {}, previous: null },
  };
  const uploads = [];
  const result = await publishRelease(regressionRelease(releaseCommit), {
    env: CREDS,
    io: {
      fetchBytes: async (url) => (url.endsWith(EDGE_SECTION_REGISTRY_FILE)
        ? { status: 200, body: Buffer.from(JSON.stringify(live)) }
        : { status: 404 }),
      upload: (_local, key) => { uploads.push(key); return true; },
      remove: () => true,
      acquireBootstrapLock: async () => 'acquired',
      releaseBootstrapLock: async () => true,
      purge: () => true,
    },
    isOlderThanLive: (candidate, liveSha) => {
      assert.equal(candidate, releaseCommit);
      assert.equal(liveSha, liveCommit);
      return olderThanLive;
    },
    verifySourceCurrent: freshnessThrows ? async () => { throw new Error('fresh'); } : async () => {},
    log: () => {},
  });
  return { result, uploads };
}

test('uno snapshot piu vecchio del puntatore servito viene rifiutato senza caricare nulla', async () => {
  const { result, uploads } = await publishAgainstLive({
    releaseCommit: 'a'.repeat(40),
    liveCommit: 'b'.repeat(40),
    olderThanLive: true,
  });
  assert.deepEqual(result, { code: 1, phase: 'regression', flipped: false });
  assert.deepEqual(uploads, []);
});

test('uno snapshot piu nuovo del puntatore servito viene pubblicato anche se main e avanzato', async () => {
  const { result, uploads } = await publishAgainstLive({
    releaseCommit: 'b'.repeat(40),
    liveCommit: 'a'.repeat(40),
    olderThanLive: false,
  });
  assert.deepEqual(result, { code: 0, phase: 'done', flipped: true });
  assert.ok(uploads.includes(EDGE_SECTION_REGISTRY_FILE), 'il puntatore viene flippato');
});

test('releaseOlderThanLive classifica antenato, discendente, storie divise e commit ignoti', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const mk = ({ known = true, releaseIsAncestor }) => (command, args) => {
    assert.equal(command, 'git');
    const verb = args[2];
    const fail = (status) => Object.assign(new Error('git'), { status });
    if (verb === 'rev-parse') { if (!known) throw fail(1); return ''; }
    if (verb === 'merge-base') { if (!releaseIsAncestor) throw fail(1); return ''; }
    throw fail(128);
  };
  assert.equal(releaseOlderThanLive(a, b, { exec: mk({ releaseIsAncestor: true }) }), true);
  assert.equal(releaseOlderThanLive(a, b, { exec: mk({ releaseIsAncestor: false }) }), false);
  assert.equal(releaseOlderThanLive(a, b, { exec: mk({ known: false, releaseIsAncestor: true }) }), false);
  assert.equal(releaseOlderThanLive(a, a, { exec: mk({ releaseIsAncestor: true }) }), false);
  assert.equal(releaseOlderThanLive(a, 'not-a-sha'), false);
});

test('con adopt le attese si interrompono dopo N minuti di main avanzato con input API e liberano la coda', async (t) => {
  const { result, flips, checks, removed, stagedKeys, logs } = await runBootstrapScenario(t, {
    staleDuring: 'pages',
    adoptAfterMinutes: 15,
    waitMs: 60 * 60_000,
  });
  assert.deepEqual(result, { code: 1, phase: 'freshness', flipped: false });
  assert.equal(flips, 0);
  assert.deepEqual(removed, stagedKeys, 'lo staging viene ripulito');
  assert.match(logs.join('\n'), /da oltre 15 minuti mentre la run e' ancora in attesa/);
  // primo controllo (t=0) adotta e fissa l'inizio; l'abort arriva al primo
  // controllo periodico oltre i 15 minuti, non al primo avanzamento visto.
  assert.equal(checks[0], 'wait:0');
  const last = Number(String(checks.at(-1)).split(':')[1]);
  assert.ok(last > 15 * 60_000 && last <= 15 * 60_000 + 120_000 + 20_000, `abort a ${last} ms`);
  assert.ok(checks.every((c) => String(c).startsWith('wait:')), 'nessun controllo flip prima dell abort');
});

test('con adopt senza attese il flip pubblica lo snapshot anche con main avanzato da oltre N minuti', async (t) => {
  const { result, flips, checks } = await runBootstrapScenario(t, { adoptAfterMinutes: 15 });
  assert.deepEqual(result, { code: 0, phase: 'done', flipped: true });
  assert.equal(flips, 1);
  assert.ok(checks.some((c) => String(c).startsWith('flip:')), 'il controllo finale non ha limite di eta');
});

test('adoptWaitMaxAgeMs: 15 minuti di default, configurabile, valori invalidi ignorati', () => {
  assert.equal(adoptWaitMaxAgeMs({}), 15 * 60_000);
  assert.equal(adoptWaitMaxAgeMs({ PUBLISH_API_EDGE_ADVANCE_WAIT_MINUTES: '5' }), 5 * 60_000);
  assert.equal(adoptWaitMaxAgeMs({ PUBLISH_API_EDGE_ADVANCE_WAIT_MINUTES: '0' }), 15 * 60_000);
  assert.equal(adoptWaitMaxAgeMs({ PUBLISH_API_EDGE_ADVANCE_WAIT_MINUTES: 'abc' }), 15 * 60_000);
});

test('releaseOlderThanLive avvisa con ::warning:: quando il controllo non e eseguibile', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const fail = (status) => Object.assign(new Error('git'), { status });
  const logs = [];
  const log = (line) => logs.push(line);
  // commit servito ignoto
  assert.equal(releaseOlderThanLive(a, b, { log, exec: (_c, args) => { if (args[2] === 'rev-parse') throw fail(1); return ''; } }), false);
  // 128 (come il vecchio `cat-file -e` su oggetto mancante) e' un errore di git, non «commit ignoto»
  assert.equal(releaseOlderThanLive(a, b, { log, exec: (_c, args) => { if (args[2] === 'rev-parse') throw fail(128); return ''; } }), false);
  // timeout/segnale di git
  assert.equal(releaseOlderThanLive(a, b, { log, exec: () => { throw fail(null); } }), false);
  // errore di git su merge-base
  assert.equal(releaseOlderThanLive(a, b, { log, exec: (_c, args) => { if (args[2] === 'merge-base') throw fail(128); return ''; } }), false);
  assert.equal(logs.length, 4);
  assert.ok(logs.every((l) => l.startsWith('::warning::[section-edge]')));
  assert.match(logs[0], /ignoto/);
  assert.match(logs[1], /errore git \(rev-parse\)/);
  assert.doesNotMatch(logs[1], /ignoto/);
  assert.match(logs[2], /errore git \(rev-parse\)/);
  assert.match(logs[3], /errore git \(merge-base\)/);
  // una storia divisa e un antenato dimostrato non emettono warning
  logs.length = 0;
  assert.equal(releaseOlderThanLive(a, b, { log, exec: (_c, args) => { if (args[2] === 'merge-base') throw fail(1); return ''; } }), false);
  assert.equal(releaseOlderThanLive(a, b, { log, exec: () => '' }), true);
  assert.deepEqual(logs, []);
});

// Stato R2 condiviso fra piu' run: il puntatore live si legge e si scrive come
// farebbe la pipeline vera, e `isOlderThanLive` e' la funzione reale su git.
function sharedEdge(initialCommit) {
  const state = { live: null, uploads: 0 };
  const setLive = (commit, status) => {
    state.live = {
      schema: 1,
      commit,
      sections: { 'canton-ti': { status } },
      release: { commit, base: releaseBase(commit), files: {}, previous: null },
    };
  };
  setLive(initialCommit, 'live');
  const io = {
    fetchBytes: async (url) => (url.endsWith(EDGE_SECTION_REGISTRY_FILE)
      ? { status: 200, body: Buffer.from(JSON.stringify(state.live)) }
      : { status: 404 }),
    upload: (local, key) => {
      if (key === EDGE_SECTION_REGISTRY_FILE) {
        state.live = JSON.parse(readFileSync(local, 'utf8'));
        state.uploads += 1;
      }
      return true;
    },
    remove: () => true,
    acquireBootstrapLock: async () => 'acquired',
    releaseBootstrapLock: async () => true,
    purge: () => true,
  };
  return { state, io };
}

// Storia reale ma autonoma (repo temporaneo): i test non dipendono dalla
// profondita' del checkout. live0 < A < B.
function tempHistory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'section-edge-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const shas = [];
  for (const n of [0, 1, 2]) {
    writeFileSync(join(dir, 'f.txt'), String(n));
    git('add', '-A');
    git('commit', '-q', '-m', 'c' + n);
    shas.push(git('rev-parse', 'HEAD'));
  }
  const exec = (command, args, options) => execFileSync(command, ['-C', dir, ...args.slice(2)], options);
  return {
    live0: shas[0],
    A: shas[1],
    B: shas[2],
    isOlderThanLive: (release, live) => releaseOlderThanLive(release, live, { exec, log: () => {} }),
  };
}

function releaseWithStatus(commit, status) {
  return {
    commit,
    base: releaseBase(commit),
    registry: { schema: 1, commit, sections: { 'canton-ti': { status } } },
    live: [],
    files: [],
    pointer: {
      schema: 1,
      commit,
      sections: { 'canton-ti': { status } },
      release: { commit, base: releaseBase(commit), files: {}, previous: null },
    },
  };
}

test('commit continuo di soli dati: la run pubblica A mentre main e gia B, la successiva pubblica B', async (t) => {
  // A e B sono commit reali, uno discendente dell altro, nel checkout dei test.
  const { A, B, live0, isOlderThanLive } = tempHistory(t);
  const { state, io } = sharedEdge(live0);
  const logs = [];
  const runAgainst = (commit, mainHead, status) => publishRelease(releaseWithStatus(commit, status), {
    env: CREDS,
    io,
    isOlderThanLive,
    sleep: async () => {},
    bootstrapWaitMs: 0,
    bootstrapLockAcquireWaitMs: 0,
    log: (line) => logs.push(line),
    verifySourceCurrent: (context) => assertExpectedMainHead(commit, async () => mainHead, {
      isAncestor: () => true,
      apiInputChanged: () => true,
      adoptApiAdvance: true,
      adoptMaxAgeMs: context?.phase === 'wait' ? 15 * 60_000 : null,
      advanceState: { firstSeenAt: null },
      log: (line) => logs.push(line),
    }),
  });
  // Run 1: snapshot A, main gia a B con soli dati nuovi nel delta.
  const first = await runAgainst(A, B, 'draft');
  assert.deepEqual(first, { code: 0, phase: 'done', flipped: true });
  assert.equal(state.live.commit, A);
  assert.match(logs.join('\n'), /input API nuovi: si pubblica lo snapshot gia' in staging/);
  // Run 2 (la run della nuova push): parte da B, main ancora B.
  const second = await runAgainst(B, B, 'retired');
  assert.deepEqual(second, { code: 0, phase: 'done', flipped: true });
  assert.equal(state.live.commit, B, 'il live avanza A -> B, mai indietro');
  assert.equal(state.uploads, 2);
});

test('un cambio di codice resta un rifiuto: senza adopt il guard interrompe e non carica il puntatore', async (t) => {
  const { A, live0, isOlderThanLive } = tempHistory(t);
  const { state, io } = sharedEdge(live0);
  const result = await publishRelease(releaseWithStatus(A, 'draft'), {
    env: CREDS,
    io,
    isOlderThanLive,
    sleep: async () => {},
    bootstrapWaitMs: 0,
    bootstrapLockAcquireWaitMs: 0,
    log: () => {},
    // Replay bounded / policy skip: nessuna adozione.
    verifySourceCurrent: () => assertExpectedMainHead(A, async () => 'd'.repeat(40), {
      isAncestor: () => true,
      apiInputChanged: () => true,
      adoptApiAdvance: false,
    }),
  });
  assert.deepEqual(result, { code: 1, phase: 'freshness', flipped: false });
  assert.equal(state.uploads, 0);
});

test('un altro publisher avanza il live durante l handshake: la rilettura prima del PUT blocca la regressione', async (t) => {
  const { A, B, live0, isOlderThanLive } = tempHistory(t);
  const { state, io } = sharedEdge(live0);
  const result = await publishRelease(releaseWithStatus(A, 'draft'), {
    env: CREDS,
    io,
    isOlderThanLive,
    sleep: async () => {},
    bootstrapWaitMs: 0,
    bootstrapLockAcquireWaitMs: 0,
    log: () => {},
    // Fra il check di freschezza finale e il PUT, un altro publisher porta il live a B.
    verifySourceCurrent: async (context) => {
      if (context?.phase === 'flip') {
        state.live = {
          schema: 1,
          commit: B,
          sections: { 'canton-ti': { status: 'retired' } },
          release: { commit: B, base: releaseBase(B), files: {}, previous: null },
        };
      }
    },
  });
  assert.deepEqual(result, { code: 1, phase: 'regression', flipped: false });
  assert.equal(state.uploads, 0);
  assert.equal(state.live.commit, B);
});

test('uno snapshot piu vecchio del live reale (git) e una regressione, uno piu nuovo no', (t) => {
  const { A, B, live0, isOlderThanLive } = tempHistory(t);
  assert.equal(isOlderThanLive(A, B), true);
  assert.equal(isOlderThanLive(B, A), false);
});
