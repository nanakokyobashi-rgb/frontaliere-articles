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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ARTICLE_SECTION_CORE_ALL, ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import {
  cantonRssPublishPlan,
  main,
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
