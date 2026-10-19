/**
 * Regression coverage for live section publishes that start before the API
 * release has reached Pages/R2. The workflow_run replay must be able to finish
 * a staged release; the first pass must not fail before uploading its missing
 * page keys.
 */
import './lib/stdout-off-runner-pipe.mjs';
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ARTICLE_SECTION_CORE_ALL, ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import { CORPUS_ROUTE_OWNER_META_TAG } from '../../engine/shared/corpusRouteOwner.mjs';
import {
  cantonRssPublishPlan,
  main,
  pageEntry,
  publish,
} from '../../scripts/publish-section-pages.mjs';
import { pageManifestFromPages } from '../../scripts/lib/section-page-manifest.mjs';
import { parseArgs } from '../../scripts/publish-section-pages.mjs';

const HISTORICAL_CORE = Object.fromEntries(
  ARTICLE_SECTION_CORE_LIST.filter((core) => core.kind !== 'canton').map((core) => [core.section, core]),
);
const ACTIVE_WITH_TI = { ...HISTORICAL_CORE, 'canton-ti': ARTICLE_SECTION_CORE_ALL['canton-ti'] };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('publisher: una release live con manifest precedente resta rossa finché il replay non verifica la release', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-live-release-'));
  const head = 'test-head';
  const publishedDoc = pageManifestFromPages({ section: 'canton-ti', commit: 'published', pages: [] });
  let publishOptions = null;
  let manifestCalls = 0;
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const code = await main(
      [
        '--section', 'canton-ti',
        '--ids', '[]',
        '--out', path.join(fixtureRoot, 'dist'),
        '--summary', path.join(fixtureRoot, 'summary.json'),
        '--publish',
      ],
      {
        parseArgsImpl: (argv) => parseArgs(argv, { active: ACTIVE_WITH_TI }),
        fetchPageManifestImpl: async () => ({ state: 'ok', doc: publishedDoc }),
        publishedStatusImpl: async () => 'live',
        publishedApiReleaseCommitImpl: async () => head,
        latestApiInputCommitImpl: async () => head,
        publishedReleaseReadyImpl: async () => ({ ok: false, reason: 'edge in transizione' }),
        publisherCommitImpl: () => head,
        currentMainHeadImpl: () => head,
        createRenderRootImpl: () => mkdtempSync(path.join(fixtureRoot, 'render-')),
        renderSectionArticlePipelineImpl: async () => ({
          entries: [],
          hubResult: { pathsByLocale: { it: [], en: [], de: [], fr: [] } },
          downloadedImageKeys: [],
          imageFetchFailures: [],
          imagePostcondition: {},
          aggregatePagesAllowed: false,
        }),
        articleReleaseSnapshotImpl: () => [],
        publishImpl: async (options) => {
          publishOptions = options;
          return { failures: 0, uploaded: 0, deleted: 0, status: 'live' };
        },
        publishPageManifestImpl: () => {
          manifestCalls++;
          return true;
        },
      },
    );
    assert.equal(code, 1, 'una deferral non verificata non deve chiudere verde il workflow_run');
    assert.deepEqual(cantonRssPublishPlan('canton-ti', {
      publishing: true,
      effectiveStatus: 'live',
      readiness: { ok: false, reason: 'edge in transizione' },
      deferUntilReplay: true,
    }), {
      cantonRssFeeds: [],
      removeStaleCantonRssFeeds: false,
      deferred: true,
    });
    assert.deepEqual(publishOptions?.cantonRssFeeds, []);
    assert.deepEqual(publishOptions?.obsoletePages, []);
    assert.equal(publishOptions?.snapshotPagesBeforeUpload, true);
    assert.equal(manifestCalls, 0, 'il manifest precedente resta la memoria fino al replay post-API');
    const summary = JSON.parse(readFileSync(path.join(fixtureRoot, 'summary.json'), 'utf8'));
    assert.equal(summary.deferredLiveRelease, true);
    assert.equal(summary.deferredLiveBootstrapRelease, false);
    assert.equal(summary.published.manifestDeferred, true);
    assert.equal(summary.published.failures, 1);
    assert.match(summary.published.deferredReason, /replay/);
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: la staging usa tutto il manifest live anche con un render --ids parziale', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-live-inventory-'));
  const head = 'test-head';
  const untouched = { ...pageEntry('canton-ti', 'articoli-ticino/untouched/index.html', 'article'), id: 'untouched' };
  const publishedDoc = pageManifestFromPages({ section: 'canton-ti', commit: 'published', pages: [untouched] });
  let publishOptions = null;
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const code = await main(
      [
        '--section', 'canton-ti',
        '--ids', '[]',
        '--out', path.join(fixtureRoot, 'dist'),
        '--summary', path.join(fixtureRoot, 'summary.json'),
        '--publish',
      ],
      {
        parseArgsImpl: (argv) => parseArgs(argv, { active: ACTIVE_WITH_TI }),
        fetchPageManifestImpl: async () => ({ state: 'ok', doc: publishedDoc }),
        publishedStatusImpl: async () => 'live',
        publishedApiReleaseCommitImpl: async () => head,
        latestApiInputCommitImpl: async () => head,
        publishedReleaseReadyImpl: async () => ({ ok: false, reason: 'edge in transizione' }),
        publisherCommitImpl: () => head,
        currentMainHeadImpl: () => head,
        createRenderRootImpl: () => mkdtempSync(path.join(fixtureRoot, 'render-')),
        renderSectionArticlePipelineImpl: async () => ({
          entries: [],
          hubResult: { pathsByLocale: { it: [], en: [], de: [], fr: [] } },
          downloadedImageKeys: [],
          imageFetchFailures: [],
          imagePostcondition: {},
          aggregatePagesAllowed: false,
        }),
        articleReleaseSnapshotImpl: () => [],
        publishImpl: async (options) => {
          publishOptions = options;
          return { failures: 0, uploaded: 0, deleted: 0, status: 'live' };
        },
        publishPageManifestImpl: () => true,
      },
    );
    assert.equal(code, 1, 'una deferral non verificata non deve chiudere verde il workflow_run');
    assert.deepEqual(
      publishOptions?.immutablePages?.map((page) => page.edgeKey),
      [untouched.edgeKey],
      'la staging deve trattenere anche la pagina live non inclusa nel render parziale',
    );
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: una pagina live omessa dal render parziale non blocca la staging', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-live-omitted-'));
  const immutable = pageEntry('canton-ti', 'articoli-ticino/untouched/index.html', 'article');
  const staged = pageEntry('canton-ti', 'articoli-ticino/new/index.html', 'article');
  const stagedHtml = '<!doctype html><html><body>nuova</body></html>';
  let stagedUploaded = false;
  const stagedLocal = path.join(fixtureRoot, staged.rel);
  mkdirSync(path.dirname(stagedLocal), { recursive: true });
  writeFileSync(stagedLocal, stagedHtml, 'utf8');
  try {
    const result = await publish({
      section: 'canton-ti',
      pages: [staged],
      immutablePages: [immutable],
      snapshotPagesBeforeUpload: true,
      cdnUploads: [],
      obsoletePages: [],
      distDir: fixtureRoot,
      publishedStatusImpl: async () => 'live',
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          stagedUploaded = true;
          return { code: 0, stdout: '✅ uploaded' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) return { code: 0, stdout: '' };
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async (url) => {
        if (url === immutable.cdnUrl) {
          return { ok: true, status: 200, body: '<!doctype html><html><body>precedente</body></html>' };
        }
        if (url === staged.cdnUrl || url === staged.apexUrl) {
          return stagedUploaded
            ? { ok: true, status: 200, body: `${stagedHtml}${CORPUS_ROUTE_OWNER_META_TAG}` }
            : { ok: false, status: 'HTTP 404' };
        }
        throw new Error(`URL inatteso: ${url}`);
      },
    });
    assert.equal(result.failures, 0);
    assert.equal(result.uploaded, 1);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: lo staging snapshotta prima degli asset e trattiene quelli delle pagine immutabili', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-live-assets-'));
  const immutable = pageEntry('canton-ti', 'articoli-ticino/existing/index.html', 'article');
  const staged = pageEntry('canton-ti', 'articoli-ticino/new/index.html', 'article');
  const previousHtml = `<!doctype html><html><head></head><body><img src="https://cdn.frontaliereticino.ch/images/shared.webp"></body></html>`;
  const stagedHtml = `<!doctype html><html><head></head><body>nuova</body></html>`;
  const events = [];
  let stagedUploaded = false;
  const immutableLocal = path.join(fixtureRoot, immutable.rel);
  mkdirSync(path.dirname(immutableLocal), { recursive: true });
  writeFileSync(immutableLocal, previousHtml, 'utf8');
  try {
    const result = await publish({
      section: 'canton-ti',
      pages: [staged],
      immutablePages: [immutable],
      snapshotPagesBeforeUpload: true,
      cdnUploads: [
        { local: 'public/images/shared.webp', key: 'images/shared.webp' },
        { local: 'public/images/new.webp', key: 'images/new.webp' },
      ],
      obsoletePages: [],
      distDir: fixtureRoot,
      publishedStatusImpl: async () => 'live',
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          if (args[2].startsWith('edge/')) {
            stagedUploaded = true;
            events.push('page-upload');
          } else {
            events.push(`asset-upload:${args[2]}`);
          }
          return { code: 0, stdout: '✅ uploaded' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) {
          events.push('purge');
          return { code: 0, stdout: '' };
        }
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async (url) => {
        if (url === immutable.cdnUrl) {
          events.push('snapshot:immutable');
          return { ok: true, status: 200, body: previousHtml };
        }
        if (url === staged.cdnUrl || url === staged.apexUrl) {
          if (!stagedUploaded) {
            events.push('snapshot:staged');
            return { ok: false, status: 'HTTP 404' };
          }
          events.push('probe:staged');
          return { ok: true, status: 200, body: `${stagedHtml}${CORPUS_ROUTE_OWNER_META_TAG}` };
        }
        throw new Error(`URL inatteso: ${url}`);
      },
      assetProbeImpl: async () => ({ ok: false, status: 'HTTP 404' }),
    });
    assert.equal(result.failures, 0);
    assert.deepEqual(events.slice(0, 4), [
      'snapshot:staged',
      'snapshot:immutable',
      'asset-upload:images/new.webp',
      'page-upload',
    ]);
    assert.ok(!events.includes('asset-upload:images/shared.webp'), 'l’asset ancora referenziato non viene sovrascritto');
    assert.ok(events.indexOf('snapshot:immutable') < events.indexOf('asset-upload:images/new.webp'));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function webpFixture(byte) {
  const bytes = Buffer.alloc(24, byte);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8 ', 12, 'ascii');
  bytes.writeUInt32LE(4, 16);
  return bytes;
}

async function publishFourLocaleSharedAsset({ localBytes, assetProbeImpl = null, assetKey = 'images/shared.webp' }) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-live-shared-asset-'));
  const sharedLocal = path.join(fixtureRoot, `shared${path.extname(assetKey)}`);
  const unrelatedLocal = path.join(fixtureRoot, 'unrelated.webp');
  writeFileSync(sharedLocal, localBytes);
  writeFileSync(unrelatedLocal, webpFixture(0x33));
  const locales = ['it', 'en', 'de', 'fr'];
  const pages = locales.map((locale) => pageEntry(
    'canton-ti',
    `${locale === 'it' ? '' : `${locale}/`}${ARTICLE_SECTION_CORE_ALL['canton-ti'].indexSlug[locale]}/nuova-rotta-${locale}/index.html`,
    'article',
  ));
  const immutablePages = locales.map((locale) => pageEntry(
    'canton-ti',
    `${locale === 'it' ? '' : `${locale}/`}${ARTICLE_SECTION_CORE_ALL['canton-ti'].indexSlug[locale]}/rotta-live-${locale}/index.html`,
    'article',
  ));
  const oldHtml = `<!doctype html><html><body><img src="https://cdn.frontaliereticino.ch/${assetKey}"></body></html>`;
  const stagedHtml = `${oldHtml}${CORPUS_ROUTE_OWNER_META_TAG}`;
  const uploadedPageKeys = new Set();
  const events = [];
  const assetProbeCalls = [];
  for (const page of pages) {
    const localPage = path.join(fixtureRoot, page.rel);
    mkdirSync(path.dirname(localPage), { recursive: true });
    writeFileSync(localPage, oldHtml, 'utf8');
  }
  const cleanup = () => rmSync(fixtureRoot, { recursive: true, force: true });
  try {
    const result = await publish({
      section: 'canton-ti',
      pages,
      immutablePages,
      snapshotPagesBeforeUpload: true,
      cdnUploads: [
        { local: sharedLocal, key: assetKey },
        { local: unrelatedLocal, key: 'images/unrelated.webp' },
      ],
      obsoletePages: [],
      distDir: fixtureRoot,
      publishedStatusImpl: async () => 'live',
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          const key = args[2];
          if (key.startsWith('edge/')) {
            uploadedPageKeys.add(key);
            events.push(`page-upload:${key}`);
          } else {
            events.push(`asset-upload:${key}`);
          }
          return { code: 0, stdout: '✅ uploaded' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) return { code: 0, stdout: '' };
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async (url) => {
        const immutable = immutablePages.find((page) => page.cdnUrl === url);
        if (immutable) return { ok: true, status: 200, body: oldHtml };
        const staged = pages.find((page) => page.cdnUrl === url || page.apexUrl === url);
        if (staged) {
          return uploadedPageKeys.has(staged.edgeKey)
            ? { ok: true, status: 200, body: stagedHtml }
            : { ok: false, status: 'HTTP 404' };
        }
        throw new Error(`URL inatteso: ${url}`);
      },
      assetProbeImpl: assetProbeImpl
        ? async (key) => {
          assetProbeCalls.push(key);
          return assetProbeImpl(key);
        }
        : undefined,
    });
    return { result, events, pages, immutablePages, assetProbeCalls, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

test('publisher: quattro route nuove riusano un asset identico senza PUT e conservano il publish', async () => {
  const localBytes = webpFixture(0x11);
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return new Response(localBytes, { status: 200, headers: { 'content-type': 'image/webp' } });
  };
  let fixture;
  try {
    fixture = await publishFourLocaleSharedAsset({ localBytes });
  } finally {
    globalThis.fetch = originalFetch;
  }
  try {
    assert.equal(fetchCalls.length, 1, 'il GET binario è memoizzato per chiave nella publish');
    assert.match(fetchCalls[0].url, /^https:\/\/cdn\.frontaliereticino\.ch\/images\/shared\.webp\?/u);
    assert.equal(fetchCalls[0].options.redirect, 'manual');
    assert.equal(fetchCalls[0].options.cache, 'no-store');
    assert.equal(fixture.result.failures, 0);
    assert.equal(fixture.result.uploaded, 4);
    assert.equal(fixture.result.deferredAssetPages, 0);
    assert.equal(fixture.events.filter((event) => event.startsWith('page-upload:')).length, 4);
    assert.ok(!fixture.events.includes('asset-upload:images/shared.webp'), 'i byte già identici non vengono sovrascritti');
    assert.ok(fixture.events.includes('asset-upload:images/unrelated.webp'), 'gli asset non trattenuti seguono il normale upload');
  } finally {
    fixture.cleanup();
  }
});

test('publisher: un asset cambiato resta trattenuto e conserva le quattro route per il replay', async () => {
  const remoteBytes = webpFixture(0x11);
  const fixture = await publishFourLocaleSharedAsset({
    localBytes: webpFixture(0x22),
    assetProbeImpl: async () => ({
      ok: true,
      status: 200,
      contentType: 'image/webp',
      byteLength: remoteBytes.length,
      sha256: sha256(remoteBytes),
    }),
  });
  try {
    assert.equal(fixture.result.failures, 0);
    assert.equal(fixture.result.uploaded, 0);
    assert.equal(fixture.result.deferredAssetPages, 4);
    assert.equal(fixture.events.filter((event) => event.startsWith('page-upload:')).length, 0);
    assert.ok(!fixture.events.includes('asset-upload:images/shared.webp'));
    assert.ok(fixture.events.includes('asset-upload:images/unrelated.webp'));
  } finally {
    fixture.cleanup();
  }
});

test('publisher: GET errore, 404 e body immagine sconosciuto tengono asset e route in deferred', async (t) => {
  const cases = [
    ['errore GET', async () => { throw new Error('timeout'); }],
    ['asset 404', async () => ({ ok: false, status: 'HTTP 404' })],
    ['body HTML con status 200', null],
  ];
  for (const [name, assetProbeImpl] of cases) {
    await t.test(name, async () => {
      const localBytes = webpFixture(0x44);
      const originalFetch = globalThis.fetch;
      if (!assetProbeImpl) {
        globalThis.fetch = async () => new Response(
          '<!doctype html><html>not an image</html>',
          { status: 200, headers: { 'content-type': 'image/webp' } },
        );
      }
      let fixture;
      try {
        fixture = await publishFourLocaleSharedAsset({ localBytes, assetProbeImpl });
      } finally {
        globalThis.fetch = originalFetch;
      }
      try {
        assert.equal(fixture.result.failures, 0);
        assert.equal(fixture.result.uploaded, 0);
        assert.equal(fixture.result.deferredAssetPages, 4);
        assert.equal(fixture.events.filter((event) => event.startsWith('page-upload:')).length, 0);
        assert.ok(!fixture.events.includes('asset-upload:images/shared.webp'));
        assert.ok(fixture.events.includes('asset-upload:images/unrelated.webp'));
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('publisher: stream image chunked oltre 5 MB viene cancellato e resta trattenuto', async () => {
  const localBytes = webpFixture(0x44);
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  let requests = 0;
  let sentChunks = 0;
  globalThis.fetch = async () => {
    requests++;
    let sent = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent >= 10) {
          controller.close();
          return;
        }
        const chunk = Buffer.alloc(1024 * 1024, 0x55);
        if (sent === 0) {
          chunk.write('RIFF', 0, 'ascii');
          chunk.writeUInt32LE(6 * 1024 * 1024 - 8, 4);
          chunk.write('WEBP', 8, 'ascii');
          chunk.write('VP8 ', 12, 'ascii');
        }
        sent++;
        sentChunks = sent;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'image/webp' } });
  };
  let fixture;
  try {
    fixture = await publishFourLocaleSharedAsset({ localBytes });
  } finally {
    globalThis.fetch = originalFetch;
  }
  try {
    assert.equal(requests, 1);
    assert.ok(sentChunks >= 6, 'la prova usa una risposta chunked senza Content-Length');
    assert.ok(sentChunks < 10, 'il reader cancella prima di consumare il body completo');
    assert.equal(cancelled, true, 'il reader cancella il body appena supera il limite');
    assert.equal(fixture.result.failures, 0);
    assert.equal(fixture.result.uploaded, 0);
    assert.equal(fixture.result.deferredAssetPages, 4);
    assert.ok(!fixture.events.includes('asset-upload:images/shared.webp'));
    assert.equal(fixture.events.filter((event) => event.startsWith('page-upload:')).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('publisher: SVG plain/XML identici consentono le route; il fallback HTML resta trattenuto', async (t) => {
  const cases = [
    ['SVG senza dichiarazione XML', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>', true],
    ['SVG con dichiarazione XML', '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"></svg>', true],
    ['fallback HTML servito come SVG', '<!doctype html><html><body>not an image</body></html>', false],
  ];
  for (const [name, content, shouldReuse] of cases) {
    await t.test(name, async () => {
      const localBytes = Buffer.from(content, 'utf8');
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return new Response(localBytes, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
      };
      let fixture;
      try {
        fixture = await publishFourLocaleSharedAsset({ localBytes, assetKey: 'images/shared.svg' });
      } finally {
        globalThis.fetch = originalFetch;
      }
      try {
        assert.equal(requests, shouldReuse ? 1 : 0, 'solo i candidati immagine validi arrivano al probe CDN');
        assert.equal(fixture.result.failures, 0);
        assert.ok(fixture.events.includes('asset-upload:images/unrelated.webp'));
        if (shouldReuse) {
          assert.equal(fixture.result.uploaded, 4);
          assert.equal(fixture.result.deferredAssetPages, 0);
          assert.equal(fixture.events.filter((event) => event.startsWith('page-upload:')).length, 4);
          assert.ok(!fixture.events.includes('asset-upload:images/shared.svg'));
        } else {
          assert.equal(fixture.result.uploaded, 0);
          assert.equal(fixture.result.deferredAssetPages, 4);
          assert.equal(fixture.events.filter((event) => event.startsWith('page-upload:')).length, 0);
          assert.ok(!fixture.events.includes('asset-upload:images/shared.svg'));
        }
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('publisher: un 404 richiesto viene caricato con l asset trattenuto senza mutare la pagina immutabile', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-live-held-page-'));
  const immutable = pageEntry('canton-ti', 'articoli-ticino/existing/index.html', 'article');
  const staged = pageEntry('canton-ti', 'articoli-ticino/new/index.html', 'article');
  const previousHtml = '<!doctype html><html><body><img src="https://cdn.frontaliereticino.ch/images/shared.webp"></body></html>';
  const stagedHtml = '<!doctype html><html><body><img src="https://cdn.frontaliereticino.ch/images/shared.webp"></body></html>';
  const events = [];
  let stagedProbeCalls = 0;
  const immutableLocal = path.join(fixtureRoot, immutable.rel);
  const stagedLocal = path.join(fixtureRoot, staged.rel);
  mkdirSync(path.dirname(immutableLocal), { recursive: true });
  mkdirSync(path.dirname(stagedLocal), { recursive: true });
  writeFileSync(immutableLocal, previousHtml, 'utf8');
  writeFileSync(stagedLocal, stagedHtml, 'utf8');
  try {
    const result = await publish({
      section: 'canton-ti',
      pages: [staged],
      immutablePages: [immutable],
      requiredPagePaths: [staged.canonicalPath],
      snapshotPagesBeforeUpload: true,
      cdnUploads: [
        { local: 'public/images/shared.webp', key: 'images/shared.webp' },
        { local: 'public/images/new.webp', key: 'images/new.webp' },
      ],
      obsoletePages: [],
      distDir: fixtureRoot,
      publishedStatusImpl: async () => 'live',
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          if (args[2].startsWith('edge/')) events.push('page-upload');
          else events.push(`asset-upload:${args[2]}`);
          return { code: 0, stdout: '✅ uploaded' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) {
          events.push('purge');
          return { code: 0, stdout: '' };
        }
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async (url) => {
        if (url === immutable.cdnUrl) {
          events.push('snapshot:immutable');
          return { ok: true, status: 200, body: previousHtml };
        }
        if (url === staged.cdnUrl) {
          stagedProbeCalls++;
          events.push('snapshot:staged');
          return stagedProbeCalls === 1
            ? { ok: false, status: 'HTTP 404' }
            : { ok: true, status: 200, body: `${stagedHtml}${CORPUS_ROUTE_OWNER_META_TAG}` };
        }
        if (url === staged.apexUrl) {
          events.push('verify:staged-apex');
          return { ok: true, status: 200, body: `${stagedHtml}${CORPUS_ROUTE_OWNER_META_TAG}` };
        }
        throw new Error(`URL inatteso: ${url}`);
      },
      assetProbeImpl: async () => ({ ok: false, status: 'HTTP 404' }),
    });
    assert.equal(result.failures, 0);
    assert.equal(result.uploaded, 1, 'il target 404 viene pubblicato prima del replay');
    assert.equal(result.deferredAssetPages, 0);
    assert.equal(stagedProbeCalls, 2, 'il target 404 viene fotografato e poi verificato dopo l upload');
    assert.ok(events.includes('asset-upload:images/new.webp'));
    assert.ok(!events.includes('asset-upload:images/shared.webp'));
    assert.ok(events.includes('page-upload'));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
