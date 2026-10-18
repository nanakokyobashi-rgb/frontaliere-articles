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

test('publisher: una release live con manifest precedente deferisce RSS al replay anche senza bootstrap', async () => {
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
    assert.equal(code, 0);
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
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
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
