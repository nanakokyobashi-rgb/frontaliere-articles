import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  createCurlFetch,
  classifyApexFailureLog,
  fingerprintHtml,
  readFingerprintFile,
  readPushStateFile,
  recordsFromSummary,
  verifyApex,
  verifyAfterPurge,
  waitForOrigin,
  writeFingerprintFile,
} from '../../scripts/ci/verify-served-fingerprint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '../../scripts/ci/verify-served-fingerprint.mjs');
const workflow = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');
const helper = readFileSync(resolve(here, '../../scripts/ci/verify-served-fingerprint.mjs'), 'utf8');

function workflowStep(name) {
  const start = workflow.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, `workflow step not found: ${name}`);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

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
const EN_RECORD = {
  url: 'https://frontaliereticino.ch/en/demo/',
  origin: 'https://origin-articolifrontaliere-en.frontaliereticino.ch/en/demo/',
  path: 'en/demo/index.html',
  locale: 'en',
  shard: 'articolifrontaliere',
  sha: fingerprintHtml(NEW_HTML),
};

function response(body, headers = {}) {
  return new Response(body, { status: 200, headers });
}

const CURL_STUB_SOURCE = [
  '#!/usr/bin/env node',
  "import { writeFileSync } from 'node:fs';",
  'const args = process.argv.slice(2);',
  "writeFileSync(process.env.CURL_ARGS_FILE, JSON.stringify(args));",
  "writeFileSync(args[args.indexOf('-D') + 1], process.env.CURL_HEADERS);",
  "writeFileSync(args[args.indexOf('-o') + 1], process.env.CURL_BODY);",
  "process.stdout.write(process.env.CURL_STATUS);",
].join('\n');

function runCurlCli(record, {
  status = '200',
  headers = 'HTTP/2 200 OK\r\nserver: cloudflare\r\ncf-cache-status: HIT\r\nage: 0\r\n\r\n',
  body = NEW_HTML,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'served-fingerprint-curl-'));
  try {
    const bin = join(root, 'bin');
    const curl = join(bin, 'curl');
    const argsFile = join(root, 'curl-args.json');
    const marker = join(root, 'shell-marker');
    mkdirSync(bin);
    writeFileSync(curl, CURL_STUB_SOURCE);
    chmodSync(curl, 0o755);

    const effectiveRecord = {
      ...record,
      url: record.url.replaceAll('__CURL_MARKER__', marker),
    };
    const fingerprintFile = join(root, 'fingerprints.tsv');
    writeFingerprintFile(fingerprintFile, [effectiveRecord]);
    const result = spawnSync(
      process.execPath,
      [
        script,
        'verify-apex',
        '--fingerprints',
        fingerprintFile,
        '--timeout-seconds',
        '5',
        '--probe-timeout-seconds',
        '0.5',
      ],
      {
        cwd: resolve(here, '../..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin + delimiter + (process.env.PATH || ''),
          CURL_ARGS_FILE: argsFile,
          CURL_STATUS: status,
          CURL_HEADERS: headers,
          CURL_BODY: body,
        },
      },
    );
    const curlArgs = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, 'utf8')) : [];
    return {
      ...result,
      curlArgs,
      effectiveUrl: effectiveRecord.url,
      markerExists: existsSync(marker),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      assert.equal(options.headers['User-Agent'], 'frontaliere-fast-publish/1.0 (+https://frontaliereticino.ch/)');
      return fetches === 1 ? response(OLD_HTML) : response(NEW_HTML);
    },
    // La suite fast-publish gira in parallelo: 120 ms rende il test sensibile
    // al carico del runner, pur avendo una fetch mockata e deterministica.
    timeoutMs: 1000,
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

test('429 e 503 dell’host origin vengono ritentati invece di bloccare la recovery', async () => {
  let now = 0;
  let fetches = 0;
  const result = await waitForOrigin({
    records: [RECORD],
    fetchImpl: async (url) => {
      assert.equal(new URL(url).hostname, new URL(RECORD.origin).hostname);
      fetches += 1;
      if (fetches === 1) return new Response('origin rate limited', { status: 429 });
      if (fetches === 2) return new Response('origin unavailable', { status: 503 });
      return response(NEW_HTML);
    },
    timeoutMs: 1000,
    pollIntervalMs: 1,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    runKey: 'origin-recovery-test',
  });

  assert.equal(result.attempts, 3);
  assert.equal(fetches, 3);
});

test('una risposta 403 senza cf-cache-status è una probe bloccata dall’edge', async () => {
  const blockedBody = 'pagina WAF: ' + 'x'.repeat(340);
  await assert.rejects(
    () => verifyApex({
      records: [RECORD],
      fetchImpl: async () => new Response(blockedBody, {
        status: 403,
        headers: {
          server: 'cloudflare',
          'cf-ray': 'ray-test',
          'cf-mitigated': 'challenge',
        },
      }),
    }),
    (error) => {
      assert.match(error.message, /probe bloccata dall'edge/);
      assert.doesNotMatch(error.message, /did not serve the expected fingerprint/);
      assert.match(error.message, /blocked=1/);
      assert.match(error.message, /server=cloudflare/);
      assert.match(error.message, /cf-ray=ray-test/);
      assert.match(error.message, /cf-mitigated=challenge/);
      assert.ok(error.message.includes(blockedBody.slice(0, 300)));
      assert.equal(error.message.includes(blockedBody.slice(0, 301)), false);
      return true;
    },
  );
});

test('status edge misti 403 e 429 restano un blocco edge e sono entrambi diagnostici', async () => {
  let fetches = 0;
  await assert.rejects(
    () => verifyApex({
      records: [RECORD, EN_RECORD],
      fetchImpl: async () => new Response('edge blocked', {
        status: fetches++ === 0 ? 403 : 429,
      }),
    }),
    (error) => {
      assert.equal(error.code, 'EDGE_PROBE_BLOCKED');
      assert.deepEqual(error.statuses, [403, 429]);
      assert.match(error.message, /status=403, 429/);
      return true;
    },
  );
});

test('la verifica CDN invia un User-Agent esplicito accettato dal bordo', async () => {
  let optionsSeen;
  await verifyApex({
    records: [RECORD],
    fetchImpl: async (url, options) => {
      assert.equal(url, RECORD.url);
      optionsSeen = options;
      return response(NEW_HTML, { 'cf-cache-status': 'HIT' });
    },
  });

  assert.deepEqual(optionsSeen.headers, {
    Accept: 'text/html',
    'User-Agent': 'frontaliere-fast-publish/1.0 (+https://frontaliereticino.ch/)',
  });
});

test('un mismatch HIT è cache lag solo se la probe anti-cache serve l’hash atteso', async () => {
  let fetches = 0;
  await assert.rejects(
    () => verifyApex({
      records: [RECORD],
      runKey: 'test-run.2.articolifrontaliere.1',
      fetchImpl: async (url, options) => {
        fetches += 1;
        if (fetches === 1) {
          assert.equal(url, RECORD.url);
          return response(OLD_HTML, { 'cf-cache-status': 'HIT', age: '776' });
        }
        assert.match(url, /_fpcb=/);
        assert.equal(new URL(url).searchParams.get('_fpcb'), 'test-run.2.articolifrontaliere.1.1');
        assert.equal(options.headers['Cache-Control'], 'no-cache');
        return response(NEW_HTML, { 'cf-cache-status': 'MISS', age: '0' });
      },
    }),
    (error) => {
      assert.match(error.message, /classification=cache-lag/);
      assert.match(error.message, /fresh-probe-status=200/);
      assert.match(error.message, new RegExp(`fresh-probe-served=${RECORD.sha}`));
      assert.equal(error.failures[0].freshProbe.cacheLagConfirmed, true);
      return true;
    },
  );
  assert.equal(fetches, 2);
});

test('un fallback HTTP 200 resta hard se la probe anti-cache non serve l’hash atteso', async () => {
  let fetches = 0;
  await assert.rejects(
    () => verifyApex({
      records: [RECORD],
      fetchImpl: async () => {
        fetches += 1;
        return fetches === 1
          ? response(OLD_HTML, { 'cf-cache-status': 'HIT', age: '776' })
          : response('<main>fallback sbagliato</main>\n', { 'cf-cache-status': 'MISS' });
      },
    }),
    (error) => {
      assert.doesNotMatch(error.message, /classification=cache-lag/);
      assert.match(error.message, /fresh-probe-served=/);
      return true;
    },
  );
  assert.equal(fetches, 2);
});

test('un giro interamente bloccato non ripete la purge', async () => {
  let purges = 0;
  await assert.rejects(
    () => verifyAfterPurge({
      records: [RECORD],
      fetchImpl: async () => new Response('edge blocked', { status: 403 }),
      purge: async () => {
        purges += 1;
      },
    }),
    /probe bloccata dall'edge/,
  );
  assert.equal(purges, 0);
});

test('il CLI usa curl senza User-Agent esplicito, legge header/body e non interpreta la URL', () => {
  const record = {
    ...RECORD,
    url: 'https://frontaliereticino.ch/$(touch __CURL_MARKER__)?q=semi;colon',
  };
  const result = runCurlCli(record);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fingerprints match/);
  assert.equal(result.curlArgs.includes('-A'), false);
  assert.equal(result.curlArgs.includes('--user-agent'), false);
  assert.ok(result.curlArgs.includes('-s'));
  assert.ok(result.curlArgs.includes('-L'));
  assert.equal(result.curlArgs[result.curlArgs.indexOf('-H') + 1], 'Cache-Control: no-cache');
  assert.equal(result.curlArgs[result.curlArgs.indexOf('--max-time') + 1], '0.5');
  assert.equal(result.curlArgs.at(-1), result.effectiveUrl);
  assert.equal(result.markerExists, false);
});

test('il CLI esce non zero per un apex bloccato e non lo tratta come CDN vecchia', () => {
  const result = runCurlCli(RECORD, {
    status: '403',
    headers: 'HTTP/2 403 Forbidden\r\nserver: cloudflare\r\ncf-ray: ray-cli\r\ncf-mitigated: challenge\r\n\r\n',
    body: 'pagina bloccata: ' + 'y'.repeat(340),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /probe bloccata dall'edge/);
  assert.doesNotMatch(result.stderr, /did not serve the expected fingerprint/);
  assert.match(result.stderr, /blocked=1/);
  assert.match(result.stderr, /cf-ray=ray-cli/);
});

test('curl assente ripiega sul fetch iniettato', async () => {
  let fallbackCalls = 0;
  const fetchImpl = createCurlFetch({
    fallbackFetch: async (url, options) => {
      fallbackCalls += 1;
      assert.equal(url, RECORD.url);
      assert.equal(options.headers['Cache-Control'], undefined);
      return response(NEW_HTML, { 'cf-cache-status': 'MISS' });
    },
    execFileImpl: async () => {
      const error = new Error('curl not found');
      error.code = 'ENOENT';
      throw error;
    },
  });
  const result = await verifyApex({
    records: [RECORD],
    fetchImpl,
    probeTimeoutMs: 100,
  });
  assert.equal(result.checked, 1);
  assert.equal(fallbackCalls, 1);
});

test('CDN vecchia dopo la purge: una sola ripetizione della purge poi passa', async () => {
  let fetches = 0;
  let purges = 0;
  const result = await verifyAfterPurge({
    records: [RECORD],
    fetchImpl: async (url, options) => {
      fetches += 1;
      if (fetches === 1) {
        assert.equal(url, RECORD.url, 'la verifica CDN deve leggere prima l’URL apex senza query');
        return response(OLD_HTML, { 'cf-cache-status': 'HIT', age: '776' });
      }
      if (fetches === 2) {
        assert.match(url, /_fpcb=/);
        assert.equal(options.headers['Cache-Control'], 'no-cache');
        return response(NEW_HTML, { 'cf-cache-status': 'MISS', age: '0' });
      }
      assert.equal(url, RECORD.url, 'dopo la purge deve ricontrollare l’URL apex canonico');
      return response(NEW_HTML, { 'cf-cache-status': 'MISS', age: '0' });
    },
    purge: async () => {
      purges += 1;
    },
  });

  assert.equal(result.checked, 1);
  assert.equal(result.repurges, 1);
  assert.equal(purges, 1);
  assert.equal(fetches, 3);
});

test('CDN vecchia per sempre: fallisce con fingerprint e diagnostica Cloudflare', async () => {
  let purges = 0;
  const freshProbeUrls = [];
  await assert.rejects(
    () => verifyAfterPurge({
      records: [RECORD],
      fetchImpl: async (url) => {
        if (url !== RECORD.url) freshProbeUrls.push(url);
        return response(OLD_HTML, {
          'cf-cache-status': 'HIT',
          age: '776',
          'last-modified': 'Mon, 19 Oct 2026 05:00:00 GMT',
        });
      },
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
      assert.doesNotMatch(error.message, /classification=cache-lag/);
      return true;
    },
  );
  assert.equal(purges, 1);
  assert.equal(freshProbeUrls.length, 2);
  assert.notEqual(freshProbeUrls[0], freshProbeUrls[1]);
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

test('lo stato pushed/no-op è isolato per lingua: una lingua aspetta e l’altra passa subito', async () => {
  const root = mkdtempSync(join(tmpdir(), 'served-fingerprint-state-'));
  try {
    const stateFile = join(root, 'published-push-state.tsv');
    writeFileSync(
      stateFile,
      'shard\tlocale\tstatus\narticolifrontaliere\tit\tpushed\narticolifrontaliere\ten\tclean-no-op\n',
    );
    let now = 0;
    let itFetches = 0;
    let enFetches = 0;
    const sleeps = [];
    const result = await waitForOrigin({
      records: [RECORD, EN_RECORD],
      pushState: readPushStateFile(stateFile),
      fetchImpl: async (url) => {
        if (url.includes('origin-articolifrontaliere-en.')) {
          enFetches += 1;
          return response(NEW_HTML);
        }
        itFetches += 1;
        return itFetches === 1 ? response(OLD_HTML) : response(NEW_HTML);
      },
      timeoutMs: 120,
      pollIntervalMs: 15,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      runKey: 'test.mixed',
    });

    assert.equal(result.checked, 2);
    assert.equal(result.attempts, 2);
    assert.equal(itFetches, 2);
    assert.equal(enFetches, 1);
    assert.deepEqual(sleeps, [15]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il fallback solo-articoli costruisce il TSV senza le landing non pushate', () => {
  assert.match(workflow, /pushed_hub_summary/);
  assert.match(workflow, /if \[ "\$combined_pushed" = true \]/);
  assert.match(workflow, /--hub-summary "\$pushed_hub_summary"/);
  assert.match(workflow, /published-push-state\.tsv/);
  assert.doesNotMatch(workflow, /FAST_PUBLISH_REPLAY_NOOP/);

  const root = mkdtempSync(join(tmpdir(), 'served-fingerprint-fallback-'));
  try {
    const articlePath = 'articoli-ticino/demo/index.html';
    const hubPath = 'it/frontaliere/index.html';
    mkdirSync(join(root, 'articoli-ticino/demo'), { recursive: true });
    mkdirSync(join(root, 'it/frontaliere'), { recursive: true });
    writeFileSync(join(root, articlePath), NEW_HTML);
    writeFileSync(join(root, hubPath), '<main>Landing stale</main>\n');

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
      // This is the exact shape emitted after the combined push fails.
      hubSummary: { pages: [] },
    });
    const output = join(root, 'published-fingerprints.tsv');
    writeFingerprintFile(output, records);

    assert.deepEqual(readFingerprintFile(output).map(({ path: recordPath }) => recordPath), [articlePath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('una probe che non risponde termina entro il budget e nomina la URL', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () => waitForOrigin({
      records: [RECORD],
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 40,
      probeTimeoutMs: 5,
      pollIntervalMs: 1,
    }),
    (error) => {
      assert.match(error.message, /URL https:\/\/frontaliereticino\.ch\/articoli-ticino\/demo\//);
      assert.match(error.message, /timed out|budget exhausted/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 500, 'la probe appesa non deve trattenere il job');

  await assert.rejects(
    () => verifyApex({
      records: [RECORD],
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 40,
      probeTimeoutMs: 5,
    }),
    (error) => {
      assert.match(error.message, /URL https:\/\/frontaliereticino\.ch\/articoli-ticino\/demo\//);
      assert.match(error.message, /timed out|budget exhausted/);
      return true;
    },
  );
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
  assert.match(helper, /AbortController/);
  assert.match(helper, /response\.text\(\)/);
  assert.match(workflow, /ARTICLE_PUSH_STATUS_FILE/);
  assert.match(workflow, /clean-no-op/);
  assert.match(workflow, /--push-state "\$RUNNER_TEMP\/published-push-state\.tsv"/);
  assert.match(workflow, /--run-key "\$\{GITHUB_RUN_ID:-local\}\.\$\{GITHUB_RUN_ATTEMPT:-1\}\.\$\{shard\}\.\$\{apex_verify_attempt\}"/);
  assert.match(workflow, /edge_probe_blocked=true[\s\S]*edge probe blocked/);
  assert.doesNotMatch(workflow, /<main>[^\n]*2943/);
});

test('una probe edge bloccata registra lo stato e salta il backstop di re-purge', () => {
  const verification = workflowStep('Verify the article is actually readable');
  const backstop = workflowStep('Re-purge the edge cache after the verification');
  const blockedBranch = verification.match(/handle_apex_failure[\s\S]*?edge-blocked\)[\s\S]*?return 2/);

  assert.ok(blockedBranch, 'missing the EDGE_PROBE_BLOCKED branch');
  assert.match(verification, /^        id: verify_served_fingerprint$/m);
  assert.match(blockedBranch[0], /edge_probe_blocked=true.*GITHUB_OUTPUT/s);
  assert.match(blockedBranch[0], /return 2/);
  assert.doesNotMatch(blockedBranch[0], /cf-purge-cache/);

  const condition = backstop.match(/^\s+if: (.+)$/m);
  assert.ok(condition, 'backstop condition is missing');
  assert.match(condition[1], /^always\(\)/);
  assert.match(condition[1], /steps\.verify_served_fingerprint\.outputs\.edge_probe_blocked != 'true'/);
  assert.match(backstop, /edge-purge-urls\.txt/);
  assert.doesNotMatch(backstop, /verify_rc/);
  assert.match(
    verification,
    /::error::edge probe blocked \(\$phase; verifier exit \$verify_rc\) — skipping the post-verification backstop purge/,
  );
});

test('il downgrade apex richiede cache-lag esplicito e distingue status/route, errore operativo e blocco edge', () => {
  const verification = workflowStep('Verify the article is actually readable');
  assert.match(verification, /verify-served-fingerprint\.mjs classify-apex-failure/);
  const mismatch = '::error::CDN served-content verification failed: 1 URL did not serve the expected fingerprint\n';
  assert.equal(
    classifyApexFailureLog(`${mismatch}URL ${RECORD.url}; expected=new-hash; served=old-hash; status=200; cf-cache-status=HIT; age=776; classification=cache-lag; fresh-probe-status=200; fresh-probe-served=new-hash\n`),
    'lag',
  );
  assert.equal(
    classifyApexFailureLog(`${mismatch}URL ${RECORD.url}; expected=new-hash; served=old-hash; status=200; cf-cache-status=HIT; age=776; fresh-probe-status=200; fresh-probe-served=route-hash\n`),
    'hard',
  );
  assert.equal(
    classifyApexFailureLog(`${mismatch}URL ${RECORD.url}; expected=new-hash; served=old-hash; status=200; classification=cache-lag\nURL https://frontaliereticino.ch/en/demo/; expected=other-new; served=other-old; status=200\n`),
    'hard',
  );
  assert.equal(
    classifyApexFailureLog(`${mismatch}URL ${RECORD.url}; expected=new-hash; served=old-hash; status=404; cf-cache-status=MISS; age=0\n`),
    'hard',
  );
  assert.equal(
    classifyApexFailureLog(`${mismatch}URL ${RECORD.url}; expected=new-hash; served=unavailable; status=network-error; cf-cache-status=unknown; age=unknown\n`),
    'operational',
  );
  assert.equal(classifyApexFailureLog('::error::fingerprint TSV has no header\n'), 'operational');
  assert.equal(
    classifyApexFailureLog(`${mismatch}URL ${RECORD.url}; expected=new-hash; served=old-hash; status=200; classification=probe bloccata dall'edge\n`),
    'edge-blocked',
  );
});

test('un mismatch apex persistente resta warning e lascia eseguire il gate origin', () => {
  const verification = workflowStep('Verify the article is actually readable');
  const retryAt = verification.indexOf(
    'bash scripts/ci/retry-cmd.sh node scripts/cf-purge-cache.mjs \\\n              "--files-from=$RUNNER_TEMP/edge-purge-urls.txt"',
  );

  assert.ok(retryAt >= 0, 'manca il retry della purge dopo il mismatch apex');
  const afterRetry = verification.slice(retryAt);
  const originGateAt = afterRetry.indexOf('echo "── origin (hard gate)"');
  assert.ok(originGateAt > 0, 'il gate origin hard è sparito o precede il retry apex');
  const retryHandling = afterRetry.slice(0, originGateAt);

  assert.match(retryHandling, /if verify_apex; then/);
  assert.match(
    retryHandling,
    /if handle_apex_failure "after retry" "\$verify_rc"; then[\s\S]*?apex_failure_rc=\$\?[\s\S]*?exit "\$apex_failure_rc"/,
  );
  assert.match(
    retryHandling,
    /the apex still served content different from the pushed fingerprints after the retry — continuing with the origin hard gate/,
  );
  assert.match(verification, /handle_apex_failure "before retry" "\$verify_rc"/);
  assert.match(verification, /refusing to downgrade it to a warning/);
});
