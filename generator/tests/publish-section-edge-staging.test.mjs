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
import { EDGE_SECTION_REGISTRY_FILE } from '../../scripts/lib/section-registry.mjs';
import { makeSectionBootstrapLock } from '../../scripts/lib/section-bootstrap-lock.mjs';

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

test('il publisher recupera un lease il cui attempt GitHub e\' gia\' terminato', async () => {
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
  const recovered = await waitForBootstrapLocks(['canton-ow'], {
    fetchBytes: async () => ({ status: 200, body: Buffer.from(JSON.stringify(lock)) }),
    readBootstrapLockOwnerRun: async () => ({ state: 'terminal', status: 'completed', conclusion: 'failure' }),
    acquireBootstrapLock: async (section, requestedCommit) => {
      takeovers.push([section, requestedCommit]);
      return 'acquired';
    },
  }, {
    commit,
    deadline: 0,
    retryMs: 0,
    log: (line) => logs.push(line),
  });

  assert.deepEqual(recovered, []);
  assert.deepEqual(takeovers, [['canton-ow', commit]]);
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
      freshnessChecks.push('before-flip');
      throw new Error('main avanzata durante il test');
    },
    log: () => {},
  });

  assert.deepEqual(result, { code: 1, phase: 'freshness', flipped: false });
  assert.deepEqual(freshnessChecks, ['before-flip']);
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
  assert.equal(
    await assertExpectedMainHead(
      source,
      async () => current,
      { isAncestor: () => true, apiInputChanged: () => false },
    ),
    current,
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
