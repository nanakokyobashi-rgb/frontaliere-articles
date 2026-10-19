import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  fingerprintHtml,
  readFingerprintFile,
  recordsFromSummary,
  verifyAfterPurge,
  waitForOrigin,
  writeFingerprintFile,
} from '../../scripts/ci/verify-served-fingerprint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');
const helper = readFileSync(resolve(here, '../../scripts/ci/verify-served-fingerprint.mjs'), 'utf8');

const NEW_HTML = '<main>\n  <h1>Nuovo articolo</h1>\n</main>\n';
const OLD_HTML = '<main>\n  <h1>Articolo vecchio</h1>\n</main>\n';
const RECORD = {
  url: 'https://frontaliereticino.ch/articoli-ticino/demo/',
  origin: 'https://origin-articolifrontaliere-it.frontaliereticino.ch/articoli-ticino/demo/',
  path: 'articoli-ticino/demo/index.html',
  locale: 'it',
  shard: 'articolifrontaliere',
  sha: fingerprintHtml(NEW_HTML),
};

function response(body, headers = {}) {
  return new Response(body, { status: 200, headers });
}

test('l’origine vecchia poi nuova aspetta e passa con una sonda anti-cache', async () => {
  let now = 0;
  let fetches = 0;
  const sleeps = [];
  const result = await waitForOrigin({
    records: [RECORD],
    fetchImpl: async (url, options) => {
      fetches += 1;
      assert.match(url, /_fpcb=/);
      assert.equal(options.headers['Cache-Control'], 'no-cache');
      return fetches === 1 ? response(OLD_HTML) : response(NEW_HTML);
    },
    timeoutMs: 120,
    pollIntervalMs: 15,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    runKey: 'test.1',
  });

  assert.equal(result.checked, 1);
  assert.equal(fetches, 2);
  assert.deepEqual(sleeps, [15]);
});

test('CDN vecchia dopo la purge: una sola ripetizione della purge poi passa', async () => {
  let fetches = 0;
  let purges = 0;
  const result = await verifyAfterPurge({
    records: [RECORD],
    fetchImpl: async (url) => {
      assert.equal(url, RECORD.url, 'la verifica CDN deve leggere l’URL apex senza query');
      fetches += 1;
      return fetches === 1
        ? response(OLD_HTML, { 'cf-cache-status': 'HIT', age: '776' })
        : response(NEW_HTML, { 'cf-cache-status': 'MISS', age: '0' });
    },
    purge: async () => {
      purges += 1;
    },
  });

  assert.equal(result.checked, 1);
  assert.equal(result.repurges, 1);
  assert.equal(purges, 1);
});

test('CDN vecchia per sempre: fallisce con fingerprint e diagnostica Cloudflare', async () => {
  let purges = 0;
  await assert.rejects(
    () => verifyAfterPurge({
      records: [RECORD],
      fetchImpl: async () => response(OLD_HTML, {
        'cf-cache-status': 'HIT',
        age: '776',
        'last-modified': 'Mon, 19 Oct 2026 05:00:00 GMT',
      }),
      purge: async () => {
        purges += 1;
      },
    }),
    (error) => {
      assert.match(error.message, /URL https:\/\/frontaliereticino\.ch\/articoli-ticino\/demo\//);
      assert.match(error.message, new RegExp(`expected=${RECORD.sha}`));
      assert.match(error.message, new RegExp(`served=${fingerprintHtml(OLD_HTML)}`));
      assert.match(error.message, /cf-cache-status=HIT/);
      assert.match(error.message, /age=776/);
      assert.match(error.message, /last-modified=Mon, 19 Oct 2026 05:00:00 GMT/);
      return true;
    },
  );
  assert.equal(purges, 1);
});

test('un replay no-op controlla subito l’origine e non consuma il budget di attesa', async () => {
  let fetches = 0;
  let sleeps = 0;
  const result = await waitForOrigin({
    records: [RECORD],
    replayNoop: true,
    fetchImpl: async () => {
      fetches += 1;
      return response(NEW_HTML);
    },
    timeoutMs: 720,
    pollIntervalMs: 15,
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(result.immediate, true);
  assert.equal(fetches, 1);
  assert.equal(sleeps, 0);
});

test('il TSV usa i byte finali di fast-dist e aggiunge le landing dell’hub', () => {
  const root = mkdtempSync(join(tmpdir(), 'served-fingerprint-'));
  try {
    const articlePath = 'articoli-ticino/demo/index.html';
    const hubPath = 'it/frontaliere/index.html';
    mkdirSync(join(root, 'articoli-ticino/demo'), { recursive: true });
    mkdirSync(join(root, 'it/frontaliere'), { recursive: true });
    writeFileSync(join(root, articlePath), NEW_HTML);
    writeFileSync(join(root, hubPath), '<main>Landing aggiornata</main>\n');

    const records = recordsFromSummary({
      distDir: root,
      shard: 'articolifrontaliere',
      summary: {
        shards: [{
          locale: 'it',
          paths: [articlePath],
          articlePaths: [articlePath],
          urls: [RECORD.url],
        }],
      },
      hubSummary: { pages: [{ locale: 'it', path: hubPath }] },
    });
    const output = join(root, 'published-fingerprints.tsv');
    writeFingerprintFile(output, records);
    const roundTrip = readFingerprintFile(output);

    assert.deepEqual(roundTrip.map(({ path, sha }) => ({ path, sha })), [
      { path: articlePath, sha: RECORD.sha },
      { path: hubPath, sha: fingerprintHtml('<main>Landing aggiornata</main>\n') },
    ]);
    assert.equal(roundTrip.find(({ path: recordPath }) => recordPath === articlePath).origin, RECORD.origin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il workflow registra prima l’impronta, attende Pages prima della purge e verifica l’apex', () => {
  const fingerprintAt = workflow.indexOf('--output "$RUNNER_TEMP/published-fingerprints.tsv"');
  const waitAt = workflow.indexOf('            wait-origin');
  const purgeAt = workflow.indexOf('      - name: Purge the edge cache for what was published');
  const verifyAt = workflow.indexOf('verify-served-fingerprint.mjs verify-apex');

  assert.ok(fingerprintAt >= 0);
  assert.ok(waitAt > fingerprintAt);
  assert.ok(purgeAt > waitAt);
  assert.ok(verifyAt > purgeAt);
  assert.match(workflow, /cf-cache-status/);
  assert.match(helper, /last-modified/);
  assert.doesNotMatch(workflow, /<main>[^\n]*2943/);
});
