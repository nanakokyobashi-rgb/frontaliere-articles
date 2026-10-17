/**
 * La pubblicazione R2 delle pagine delle sezioni cantonali (piano «sezioni
 * articoli per cantone», P7b parte B). Run with `node --test`.
 *
 * Il render vero passa dall'engine (TypeScript, sotto tsx) e non gira in
 * questo gate: qui si provano le parti che decidono COSA viene pubblicato e
 * DOVE — chiavi R2, difetti che fermano una pagina, hub senza dati, sezioni
 * toccate da un commit, riconciliazione — e il cablaggio dei workflow.
 */
import './lib/stdout-off-runner-pipe.mjs';
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE, ARTICLE_SECTION_CORE_ALL, ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import { cantonTopicHubPath } from '../../engine/shared/cantonSectionCopy.mjs';
import { CORPUS_ROUTE_OWNER_META_TAG } from '../../engine/shared/corpusRouteOwner.mjs';
import {
  API_BASE,
  APEX,
  apiInputChangedInRange,
  CANTON_RSS_PREFIX,
  PAGE_CACHE_CONTROL,
  UPLOAD_ORDER,
  addCantonRssFeedLink,
  aggregatePageDefects,
  articleManifestPages,
  archiveReleasePages,
  articleReleasePages,
  articleReleaseSnapshot,
  assertPublishableSection,
  cantonRssFeedEntries,
  cantonRssFeedsDeclaredInManifest,
  cantonRssFeedsForPublish,
  cantonRssFeedUrlForLocale,
  createRenderRoot,
  ensureRouteOwnerMeta,
  hubMissingIsFatal,
  inUploadOrder,
  latestApiInputCommit,
  main,
  migrationManifestPages,
  missingRenderedArticleIds,
  normalizeRoutePrefix,
  pageDefects,
  pageEntry,
  obsoleteArticlePages,
  obsoleteArchivePages,
  obsoleteReleasePages,
  parseArgs,
  publish,
  publishApiTriggerPaths,
  publishCantonRssFeeds,
  removeCantonRssFeedLinks,
  resolveStaleReplayApiReleaseCommit,
  resolvePublishedReleaseCommit,
  publishedReleaseReady,
  publishedStatus,
  rendererPageEntry,
} from '../../scripts/publish-section-pages.mjs';
import { assertHubLocaleSlug } from '../../scripts/lib/assert-hub-locale-slug.mjs';
import { assertHubTopicEntries } from '../../scripts/lib/assert-hub-locale-slug.mjs';
import { familySectionPages } from '../../scripts/lib/build-sitemap.mjs';
import {
  fetchPageManifest,
  mergePageManifests,
  pageManifestErrors,
  pageManifestFromPages,
  pageManifestKey,
  pageManifestUrl,
} from '../../scripts/lib/section-page-manifest.mjs';
import { cantonHubCoverage, cantonHubDataFile, cantonHubTopics, readCantonHubData } from '../../scripts/lib/canton-hub-data.mjs';
import { declaredRegistryErrors, SECTION_REGISTRY_FILE } from '../../scripts/lib/section-registry.mjs';
import { sourceRegistryIds } from '../../scripts/lib/corpus-floors.mjs';
import { bodyRegex, liveR2ReconciliationPlan, liveRegistryTransitionSections, r2ApiPushPlan, r2PublishPlan } from '../../scripts/ci/fast-publish-section.mjs';
import { cdnUrlFor, expectedSectionPages, headState, orphanedArticleCandidates, planSectionBackfill, reconcile } from '../../scripts/reconcile-section-pages.mjs';
import { heroCdnUploads } from '../../scripts/lib/article-render-pipeline.mjs';
import { cantonSectionPaths } from '../scripts/lib/canton-section-profile.mjs';
import { corpusPath } from '../scripts/lib/corpus-paths.mjs';
import { sectionSourceSurfaces } from '../../scripts/lib/corpus-sections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TI = ARTICLE_SECTION_CORE_ALL['canton-ti'];
const HISTORICAL_CORE_LIST = ARTICLE_SECTION_CORE_LIST.filter((core) => core.kind !== 'canton');
const HISTORICAL_CORE = Object.fromEntries(HISTORICAL_CORE_LIST.map((core) => [core.section, core]));
const WITH_TI = [...HISTORICAL_CORE_LIST, TI];
const ACTIVE_WITH_TI = { ...HISTORICAL_CORE, 'canton-ti': TI };
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── Publisher ────────────────────────────────────────────────────────────────

test('publisher: solo una sezione cantonale ATTIVA nel core', () => {
  assert.throws(() => assertPublishableSection('svizzera'), /shard Pages.*publish-article-fast/);
  assert.throws(() => assertPublishableSection('canton-zz'), /sconosciuta/);
  // Inattiva (oggi tutte): l'engine non la renderebbe.
  if (!Object.prototype.hasOwnProperty.call(ARTICLE_SECTION_CORE, 'canton-ti')) {
    assert.throws(() => assertPublishableSection('canton-ti'), /non e' attiva nel core/);
  }
  assert.equal(assertPublishableSection('canton-ti', { active: ACTIVE_WITH_TI }).canton, 'TI');
});

test('publisher R2 propaga immagini recuperate e verdetto aggregati dalla pipeline', () => {
  const publisher = read('scripts/publish-section-pages.mjs');
  assert.match(
    publisher,
    /\{\s*entries,\s*hubResult,\s*downloadedImageKeys,\s*imageFetchFailures,\s*imagePostcondition,\s*aggregatePagesAllowed,\s*\}/,
  );
  assert.match(publisher, /heroCdnUploads\(\{[\s\S]*?downloadedImageKeys,[\s\S]*?\}\);/);
  assert.match(publisher, /imageFetchFailures,[\s\S]*imagePostcondition,[\s\S]*aggregatePagesAllowed,/);
  const manifestDeclaration = publisher.indexOf('const currentManifest =');
  const publishCall = publisher.indexOf('summary.published = await publish(');
  assert.ok(manifestDeclaration > publishCall, 'il manifest corrente si calcola solo dopo il publish verificato');
  for (const match of publisher.matchAll(/\bcurrentManifest\b/g)) {
    assert.ok(match.index >= manifestDeclaration, 'currentManifest non deve essere letto prima della dichiarazione');
  }
});

test('publisher --publish costruisce il manifest solo dopo una publish riuscita', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-publish-'));
  const publishedDoc = pageManifestFromPages({ section: 'canton-ti', commit: 'published', pages: [] });
  const events = [];
  const manifests = [];
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const code = await main(
      ['--section', 'canton-ti', '--ids', '[]', '--out', path.join(fixtureRoot, 'dist'), '--summary', path.join(fixtureRoot, 'summary.json'), '--publish'],
      {
        parseArgsImpl: (argv) => parseArgs(argv, { active: ACTIVE_WITH_TI }),
        fetchPageManifestImpl: async () => ({ state: 'ok', doc: publishedDoc }),
        publishedStatusImpl: async () => 'draft',
        currentMainHeadImpl: () => execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
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
        publishImpl: async () => {
          events.push('publish');
          return { failures: 0, uploaded: 0, deleted: 0, status: 'draft' };
        },
        publishPageManifestImpl: ({ manifest }) => {
          events.push('manifest');
          manifests.push(manifest);
          return true;
        },
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(events, ['publish', 'manifest']);
    assert.equal(manifests.length, 1);
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: il bootstrap live differisce RSS, cancellazioni e manifest finche\' la release API non e\' servita', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-bootstrap-live-'));
  const publishedDoc = pageManifestFromPages({ section: 'canton-ti', commit: 'published', pages: [] });
  let publishOptions = null;
  let manifestCalls = 0;
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const code = await main(
      ['--section', 'canton-ti', '--bootstrap', '--out', path.join(fixtureRoot, 'dist'), '--summary', path.join(fixtureRoot, 'summary.json'), '--publish'],
      {
        parseArgsImpl: (argv) => parseArgs(argv, { active: ACTIVE_WITH_TI }),
        sourceRegistryIdsImpl: () => [],
        fetchPageManifestImpl: async () => ({ state: 'ok', doc: publishedDoc }),
        publishedStatusImpl: async () => 'live',
        publishedApiReleaseCommitImpl: async () => execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        publishedReleaseReadyImpl: async () => ({ ok: false, reason: 'registro edge non ancora sul commit' }),
        currentMainHeadImpl: () => execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
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
    assert.deepEqual(publishOptions?.cantonRssFeeds, []);
    assert.deepEqual(publishOptions?.obsoletePages, []);
    assert.equal(manifestCalls, 0, 'il manifest precedente resta la memoria per la fase post-flip');
    const summary = JSON.parse(readFileSync(path.join(fixtureRoot, 'summary.json'), 'utf8'));
    assert.equal(summary.deferredLiveBootstrapRelease, true);
    assert.equal(summary.published.manifestDeferred, true);
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: bootstrap live senza manifest non arma il percorso differito', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-bootstrap-no-manifest-'));
  let publishOptions = null;
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const code = await main(
      ['--section', 'canton-ti', '--bootstrap', '--out', path.join(fixtureRoot, 'dist'), '--summary', path.join(fixtureRoot, 'summary.json'), '--publish'],
      {
        parseArgsImpl: (argv) => parseArgs(argv, { active: ACTIVE_WITH_TI }),
        sourceRegistryIdsImpl: () => [],
        fetchPageManifestImpl: async () => ({ state: 'absent' }),
        publishedStatusImpl: async () => 'live',
        publishedApiReleaseCommitImpl: async () => execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        publishedReleaseReadyImpl: async () => ({ ok: false, reason: 'registro edge non ancora sul commit' }),
        currentMainHeadImpl: () => execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
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
    assert.equal(code, 0);
    assert.equal(publishOptions?.snapshotPagesBeforeUpload, false);
    const summary = JSON.parse(readFileSync(path.join(fixtureRoot, 'summary.json'), 'utf8'));
    assert.equal(summary.deferredLiveBootstrapRelease, false, 'senza inventario non si assume che il set live sia completo');
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: lo staging bootstrap live carica solo chiavi HTML nuove e snapshotta prima dell upload', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-pages-bootstrap-stage-'));
  const outDir = path.join(fixtureRoot, 'dist');
  const routePrefix = { it: 'articoli-ticino', en: 'en/ticino-articles', de: 'de/tessin-artikel', fr: 'fr/articles-tessin' };
  const oldPages = ['it', 'en', 'de', 'fr'].map((localeCode) => ({
    ...pageEntry('canton-ti', `${routePrefix[localeCode]}/old/index.html`, 'article'),
    id: 'old',
  }));
  const publishedDoc = pageManifestFromPages({ section: 'canton-ti', commit: 'published', pages: oldPages });
  const newPages = ['it', 'en', 'de', 'fr'].map((localeCode) => ({
    localeCode,
    rel: `${routePrefix[localeCode]}/new/index.html`,
  }));
  let publishOptions = null;
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const code = await main(
      ['--section', 'canton-ti', '--bootstrap', '--out', outDir, '--summary', path.join(fixtureRoot, 'summary.json'), '--publish'],
      {
        parseArgsImpl: (argv) => parseArgs(argv, { active: ACTIVE_WITH_TI }),
        sourceRegistryIdsImpl: () => ['new'],
        fetchPageManifestImpl: async () => ({ state: 'ok', doc: publishedDoc }),
        publishedStatusImpl: async () => 'live',
        publishedApiReleaseCommitImpl: async () => execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        publishedReleaseReadyImpl: async () => ({ ok: false, reason: 'registro edge non ancora sul commit' }),
        currentMainHeadImpl: () => execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        createRenderRootImpl: () => mkdtempSync(path.join(fixtureRoot, 'render-')),
        renderSectionArticlePipelineImpl: async () => {
          for (const { rel } of newPages) {
            const page = pageEntry('canton-ti', rel, 'article');
            const local = path.join(outDir, page.rel);
            mkdirSync(path.dirname(local), { recursive: true });
            writeFileSync(
              local,
              `<!doctype html><html><head><link rel="canonical" href="${page.apexUrl}">${CORPUS_ROUTE_OWNER_META_TAG}</head><body>${'nuova release '.repeat(30)}</body></html>`,
              'utf8',
            );
          }
          return {
            entries: [{
              articleId: 'new',
              paths: Object.fromEntries(newPages.map(({ localeCode, rel }) => [localeCode, rel])),
            }],
            hubResult: { pathsByLocale: { it: [], en: [], de: [], fr: [] } },
            downloadedImageKeys: [],
            imageFetchFailures: [],
            imagePostcondition: {},
            aggregatePagesAllowed: false,
          };
        },
        articleReleaseSnapshotImpl: () => [],
        publishImpl: async (options) => {
          publishOptions = options;
          return { failures: 0, uploaded: options.pages.length, deleted: 0, status: 'live' };
        },
        publishPageManifestImpl: () => true,
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(publishOptions.pages.map((page) => page.edgeKey), newPages.map(({ rel }) => pageEntry('canton-ti', rel, 'article').edgeKey));
    assert.equal(publishOptions.snapshotPagesBeforeUpload, true);
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: il fallback API copre l\'ultimo input raggiungibile dal publisher', async () => {
  const publisherCommit = 'a'.repeat(40);
  const apiCommit = 'b'.repeat(40);
  const latestInputCommit = 'c'.repeat(40);
  assert.equal(
    await resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => apiCommit,
      latestApiInputCommitImpl: async () => latestInputCommit,
      isAncestorImpl: async (ancestor, descendant) =>
        (ancestor === apiCommit && descendant === publisherCommit)
        || (ancestor === latestInputCommit && descendant === apiCommit),
    }),
    apiCommit,
  );
  assert.equal(
    await resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => apiCommit,
      latestApiInputCommitImpl: async () => latestInputCommit,
      isAncestorImpl: async (ancestor, descendant) => ancestor === apiCommit && descendant === publisherCommit,
    }),
    latestInputCommit,
    'una release API precedente all\'ultimo input non puo\' alimentare il fallback publisher-only',
  );
  const pushHead = 'd'.repeat(40);
  assert.equal(
    await resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => apiCommit,
      latestApiInputCommitImpl: async () => latestInputCommit,
      currentPushApiInputImpl: async () => true,
      pushBefore: 'e'.repeat(40),
      pushAfter: pushHead,
      isAncestorImpl: async (ancestor, descendant) => ancestor === apiCommit && descendant === publisherCommit,
    }),
    pushHead,
    'una push che contiene input API attende la HEAD effettiva della release, non il commit dell\'ultimo file API',
  );
  assert.equal(
    await resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => apiCommit,
      latestApiInputCommitImpl: async () => publisherCommit,
      isAncestorImpl: async (ancestor, descendant) => ancestor === apiCommit && descendant === publisherCommit,
    }),
    publisherCommit,
    'anche un input API nella push corrente resta in attesa della release corrispondente',
  );
  assert.equal(
    await resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => apiCommit,
      apiReleaseCommitOverride: apiCommit,
      latestApiInputCommitImpl: () => { throw new Error('il bookkeeping non deve essere riclassificato'); },
      isAncestorImpl: async () => true,
    }),
    apiCommit,
  );
  await assert.rejects(
    resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => 'c'.repeat(40),
      apiReleaseCommitOverride: apiCommit,
    }),
    /diverso da quello propagato/,
  );
  await assert.rejects(
    resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => null,
    }),
    /commit API pubblicato assente o non verificabile/,
    'un manifest API illeggibile non puo\' inventare la provenienza della HEAD del publisher',
  );
  await assert.rejects(
    resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => apiCommit,
      latestApiInputCommitImpl: async () => null,
      isAncestorImpl: async () => false,
    }),
    /non e' antenato/,
  );
  await assert.rejects(
    resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => apiCommit,
      latestApiInputCommitImpl: async () => null,
      isAncestorImpl: async () => { throw new Error('oggetto mancante'); },
    }),
    /non verificabile/,
  );
  await assert.rejects(
    resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => apiCommit,
      latestApiInputCommitImpl: async () => { throw new Error('provenienza assente'); },
      isAncestorImpl: async () => true,
    }),
    /storia degli input API non verificabile/,
  );
  await assert.rejects(
    resolvePublishedReleaseCommit(publisherCommit, {
      apiReleaseCommitImpl: async () => apiCommit,
      latestApiInputCommitImpl: async () => latestInputCommit,
      isAncestorImpl: async () => false,
    }),
    /non e' antenato/,
    'una release API non antenata resta bloccata prima del fallback',
  );
});

test('publisher: il replay stantio cambia release attesa se main contiene input API non coperti', () => {
  const currentMain = 'a'.repeat(40);
  const staleRelease = 'b'.repeat(40);
  const latestInput = 'c'.repeat(40);
  assert.equal(
    resolveStaleReplayApiReleaseCommit(currentMain, staleRelease, {
      latestApiInputCommitImpl: () => latestInput,
      isAncestorImpl: () => true,
    }),
    staleRelease,
  );
  assert.equal(
    resolveStaleReplayApiReleaseCommit(currentMain, staleRelease, {
      latestApiInputCommitImpl: () => latestInput,
      isAncestorImpl: () => false,
    }),
    currentMain,
    'il replay deve attendere la release della HEAD corrente quando la release stantia non copre gli input API',
  );
});

test('publisher: legge la struttura reale di on.push.paths e cerca l\'ultimo input storico', () => {
  const workflow = [
    'on:',
    '    push:',
    '      branches: [main]',
    '      paths:',
    "        - 'content/**'",
    "        - 'scripts/build-api.mjs'",
    '    schedule:',
    "      - cron: '17 3 * * 1'",
  ].join('\n');
  assert.deepEqual(
    publishApiTriggerPaths({ workflowText: workflow }),
    ['content/**', 'scripts/build-api.mjs'],
  );

  const calls = [];
  assert.equal(
    latestApiInputCommit('a'.repeat(40), {
      triggerPathsImpl: () => [
        'content/**',
        'scripts/build-api.mjs',
        'data/blog-cover-cdn-sync-queue.json',
      ],
      execFileSyncImpl: (...args) => {
        calls.push(args);
        return `${'b'.repeat(40)}\n`;
      },
    }),
    'b'.repeat(40),
  );
  assert.deepEqual(calls[0][1], [
    '-C',
    ROOT,
    'rev-list',
    '--max-count=1',
    'a'.repeat(40),
    '--',
    'content/**',
    'scripts/build-api.mjs',
  ]);
  assert.throws(
    () => latestApiInputCommit('a'.repeat(40), { triggerPathsImpl: () => { throw new Error('push.paths illeggibile'); } }),
    /push\.paths illeggibile/,
  );
  assert.throws(
    () => latestApiInputCommit('a'.repeat(40), {
      triggerPathsImpl: () => ['content/**'],
      execFileSyncImpl: () => { throw new Error('oggetto mancante'); },
    }),
    /storia Git non verificabile/,
  );
  const rangeCalls = [];
  assert.equal(
    apiInputChangedInRange(
      { before: 'a'.repeat(40), after: 'b'.repeat(40) },
      {
        triggerPathsImpl: () => ['content/**'],
        execFileSyncImpl: (...args) => {
          rangeCalls.push(args);
          return `${'c'.repeat(40)}\n`;
        },
      },
    ),
    true,
  );
  assert.deepEqual(rangeCalls[0][1], [
    '-C',
    ROOT,
    'rev-list',
    '--max-count=1',
    'b'.repeat(40),
    `^${'a'.repeat(40)}`,
    '--',
    'content/**',
  ]);
});

test('publisher migration manifest usa percorsi canonici per landing e hub', () => {
  const pages = migrationManifestPages('canton-ti', [], []);
  const rels = new Set(pages.map(({ rel }) => rel));

  assert.ok(rels.has('articoli-ticino/index.html'));
  assert.ok(rels.has('articoli-ticino/carburanti/index.html'));
  assert.ok(rels.has('en/ticino-articles/index.html'));
  assert.ok(rels.has('en/ticino-articles/fuel/index.html'));
  assert.ok([...rels].every((rel) => rel.endsWith('/index.html')));
  assert.ok(![...rels].some((rel) => rel.includes('ticinoindex.html') || rel.includes('ticinocarburanti')));
});

test('publisher normalizza i prefissi prima di concatenare i path canonici', () => {
  assert.equal(normalizeRoutePrefix('/articoli-ticino'), '/articoli-ticino');
  assert.equal(normalizeRoutePrefix('/articoli-ticino/'), '/articoli-ticino');
  assert.equal(normalizeRoutePrefix('/articoli-ticino///'), '/articoli-ticino');
});

test('publisher migration manifest rifiuta uno slug hub mancante per la locale corrente', () => {
  const [topic, topicSlugs] = Object.entries(TI.topicHubs)[0];
  const incompleteSlugs = { ...topicSlugs };
  delete incompleteSlugs.it;
  const all = {
    ...ARTICLE_SECTION_CORE_ALL,
    'canton-ti': {
      ...TI,
      topicHubs: { ...TI.topicHubs, [topic]: incompleteSlugs },
    },
  };

  assert.throws(
    () => migrationManifestPages('canton-ti', [], [], all),
    /slug hub mancante o vuoto.*\/it$/,
  );
});

test('sitemap e migration manifest rifiutano chiavi hub mancanti o extra', () => {
  for (const topicHubs of [
    Object.fromEntries(Object.entries(TI.topicHubs).filter(([topic]) => topic !== 'carburanti')),
    { ...TI.topicHubs, nonDichiarato: { it: 'non-dichiarato' } },
  ]) {
    const all = {
      ...ARTICLE_SECTION_CORE_ALL,
      'canton-ti': { ...TI, topicHubs },
    };
    assert.throws(() => assertHubTopicEntries('canton-ti', topicHubs), /chiavi hub non valide/u);
    assert.throws(() => familySectionPages('canton-ti', 0, 20, all), /chiavi hub non valide/u);
    assert.throws(() => migrationManifestPages('canton-ti', [], [], all), /chiavi hub non valide/u);
  }
});

test('guardia slug hub richiede una proprietà propria stringa non vuota', () => {
  assert.equal(assertHubLocaleSlug('canton-ti', 'carburanti', 'it', { it: 'carburanti' }), 'carburanti');

  const inherited = Object.create({ it: 'ereditato' });
  assert.throws(
    () => assertHubLocaleSlug('canton-ti', 'carburanti', 'it', inherited),
    /slug hub mancante o vuoto.*\/it$/u,
  );
  assert.throws(
    () => assertHubLocaleSlug('canton-ti', 'carburanti', 'it', { it: '' }),
    /slug hub mancante o vuoto.*\/it$/u,
  );
  assert.throws(
    () => assertHubLocaleSlug('canton-ti', 'carburanti', 'it', { it: '   ' }),
    /slug hub mancante o vuoto.*\/it$/u,
  );
});

test('cantonTopicHubPath rifiuta slug hub ereditati o vuoti', () => {
  const originalTopicHubs = TI.topicHubs;
  try {
    TI.topicHubs = Object.create({ carburanti: { it: 'ereditato' } });
    assert.throws(
      () => cantonTopicHubPath('canton-ti', 'carburanti', 'it'),
      /tema sconosciuto/u,
    );

    TI.topicHubs = {
      ...originalTopicHubs,
      carburanti: Object.create({ it: 'ereditato' }),
    };
    assert.throws(
      () => cantonTopicHubPath('canton-ti', 'carburanti', 'it'),
      /slug hub mancante o vuoto/u,
    );

    TI.topicHubs = {
      ...originalTopicHubs,
      carburanti: { ...originalTopicHubs.carburanti, it: '' },
    };
    assert.throws(
      () => cantonTopicHubPath('canton-ti', 'carburanti', 'it'),
      /slug hub mancante o vuoto/u,
    );
  } finally {
    TI.topicHubs = originalTopicHubs;
  }

  assert.equal(cantonTopicHubPath('canton-ti', 'carburanti', 'it').includes('//'), false);
});

test('publisher usa il prefisso normalizzato anche per il match della pagina', () => {
  const section = 'canton-route-prefix-fixture';
  const all = {
    [section]: {
      ...TI,
      section,
      indexSlug: { ...TI.indexSlug, it: `${TI.indexSlug.it}///` },
    },
  };

  assert.equal(
    pageEntry(section, 'articoli-ticino/index.html', 'landing', all).canonicalPath,
    '/articoli-ticino/',
  );
});

test('publisher: il seed del manifest di migrazione conserva i percorsi canonici', () => {
  const manifest = pageManifestFromPages({
    section: 'canton-ti',
    commit: 'migration',
    pages: migrationManifestPages('canton-ti', [], []),
  });

  assert.deepEqual(
    manifest.pages.landing.map((page) => page.rel).sort(),
    [
      'articoli-ticino/index.html',
      'de/tessin-artikel/index.html',
      'en/ticino-articles/index.html',
      'fr/articles-tessin/index.html',
    ].sort(),
  );
  assert.ok([...manifest.pages.landing, ...manifest.pages.hub].every((page) => page.rel.endsWith('/index.html')));
  assert.ok(manifest.pages.hub.every((page) => page.rel.includes('/')));
});

test('publisher R2 rifiuta gli article ID richiesti che la pipeline trattiene', () => {
  assert.deepEqual(
    missingRenderedArticleIds(
      ['ag-1', 'ag-2', 'ag-2'],
      [{ articleId: 'ag-1' }],
    ),
    ['ag-2'],
  );
  assert.deepEqual(missingRenderedArticleIds([], []), []);
});

test('publisher R2 pubblica article-only ma rifiuta aggregati trapelati', () => {
  const articles = [{ kind: 'article', locale: 'it', rel: 'articoli-ticino/sano/index.html' }];
  assert.deepEqual(aggregatePageDefects(articles, { aggregatePagesAllowed: false }), []);
  assert.deepEqual(
    aggregatePageDefects([...articles, { kind: 'archive', locale: 'it', rel: 'articoli-ticino/tutti/index.html' }], {
      aggregatePagesAllowed: false,
    }),
    ['pagine aggregate presenti nel percorso article-only: articoli-ticino/tutti/index.html'],
  );
  assert.deepEqual(
    aggregatePageDefects(articles, { aggregatePagesAllowed: true, locales: ['it'] }),
    ['nessuna pagina archive per it', 'nessuna pagina landing per it'],
  );
  assert.deepEqual(
    aggregatePageDefects(articles),
    ['verdetto aggregatePagesAllowed assente o non booleano'],
  );
});

test('publisher R2 article-only conserva tutta la release precedente', () => {
  const oldArticle = { canonicalPath: '/articoli-ticino/old/' };
  const oldArchive = { canonicalPath: '/articoli-ticino/tutti/page/2/' };
  const input = {
    previousArticlePages: [oldArticle],
    currentArticlePages: [],
    previousArchivePages: [oldArchive],
    currentArchivePages: [],
  };
  assert.deepEqual(obsoleteReleasePages({ ...input, aggregatePagesAllowed: false }), []);
  assert.deepEqual(obsoleteReleasePages({ ...input, aggregatePagesAllowed: true }), [oldArticle, oldArchive]);
  assert.throws(() => obsoleteReleasePages(input), /aggregatePagesAllowed deve essere booleano/);
});

test('manifest edge: una release completa è validabile e un giro article-only conserva ciò che è online', () => {
  const oldArticle = { ...pageEntry('canton-ti', 'articoli-ticino/gone/index.html', 'article'), id: 'gone' };
  const oldLanding = pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing');
  const currentArticle = { ...pageEntry('canton-ti', 'articoli-ticino/new/index.html', 'article'), id: 'new' };
  const previous = pageManifestFromPages({ section: 'canton-ti', commit: 'old-commit', pages: [oldArticle, oldLanding] });
  const current = pageManifestFromPages({ section: 'canton-ti', commit: 'new-commit', pages: [currentArticle] });
  const merged = mergePageManifests(previous, current);
  assert.deepEqual(merged.pages.article.map((page) => page.id), ['gone', 'new']);
  assert.equal(merged.pages.landing.length, 1);
  assert.deepEqual(merged.counts, { article: 2, archive: 0, hub: 0, landing: 1, total: 3 });
  assert.deepEqual(pageManifestErrors(merged, { section: 'canton-ti' }), []);
  assert.equal(pageManifestKey('canton-ti'), 'edge/sections/_page-manifests/canton-ti.json');
  assert.equal(pageManifestUrl('canton-ti', 'https://cdn.test/'), 'https://cdn.test/edge/sections/_page-manifests/canton-ti.json');
});

test('manifest edge: uno slug nuovo resta fuori finche\' la sua pagina non e\' verificata', () => {
  const previousArticle = { ...pageEntry('canton-ti', 'articoli-ticino/old/index.html', 'article'), id: 'kept' };
  const currentArticle = { ...pageEntry('canton-ti', 'articoli-ticino/new/index.html', 'article'), id: 'kept' };
  const previous = articleManifestPages({
    section: 'canton-ti',
    previousArticlePages: [previousArticle],
    currentArticlePages: [currentArticle],
    verifiedArticlePages: [],
  });
  assert.deepEqual(previous.map((page) => page.canonicalPath), ['/articoli-ticino/old/']);
  assert.deepEqual(
    articleManifestPages({
      section: 'canton-ti',
      previousArticlePages: [previousArticle],
      currentArticlePages: [currentArticle],
      verifiedArticlePages: [currentArticle],
    }).map((page) => page.canonicalPath),
    ['/articoli-ticino/new/'],
  );
  assert.deepEqual(obsoleteArticlePages([previousArticle], [currentArticle], []), []);
  assert.deepEqual(obsoleteArticlePages([previousArticle], [currentArticle], [currentArticle]), [previousArticle]);

  assert.deepEqual(
    articleManifestPages({
      section: 'canton-ti',
      previousArticlePages: [previousArticle, currentArticle],
      currentArticlePages: [currentArticle],
      verifiedArticlePages: [],
    }).map((page) => page.canonicalPath),
    ['/articoli-ticino/new/'],
    'una URL nuova già nell’inventario pubblicato autorizza il cleanup anche in un run parziale',
  );
  assert.deepEqual(
    obsoleteArticlePages([previousArticle, currentArticle], [currentArticle], []),
    [previousArticle],
  );

  const reusedByAnotherId = { ...pageEntry('canton-ti', 'articoli-ticino/old/index.html', 'article'), id: 'replacement' };
  assert.deepEqual(obsoleteArticlePages([previousArticle], [reusedByAnotherId], []), []);
  assert.deepEqual(
    articleManifestPages({
      section: 'canton-ti',
      previousArticlePages: [previousArticle],
      currentArticlePages: [reusedByAnotherId],
      verifiedArticlePages: [],
    }).map((page) => page.id),
    ['kept'],
  );
});

test('manifest edge: i counts dimostrano che il documento HTTP è completo', async () => {
  const complete = pageManifestFromPages({
    section: 'canton-ti',
    commit: 'old-commit',
    pages: [
      { ...pageEntry('canton-ti', 'articoli-ticino/kept/index.html', 'article'), id: 'kept' },
      pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing'),
    ],
  });
  assert.deepEqual(complete.counts, { article: 1, archive: 0, hub: 0, landing: 1, total: 2 });
  const truncated = { ...complete, pages: { ...complete.pages, article: [] } };
  const result = await fetchPageManifest('https://cdn.test/manifest.json', {
    section: 'canton-ti',
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => truncated }),
  });
  assert.equal(result.state, 'unknown');
  assert.match(result.reason, /counts\.article/);
});

test('manifest edge: un fallimento lascia la cancellazione in coda al push successivo', () => {
  const oldPage = { ...pageEntry('canton-ti', 'articoli-ticino/gone/index.html', 'article'), id: 'gone' };
  const currentPage = { ...pageEntry('canton-ti', 'articoli-ticino/kept/index.html', 'article'), id: 'kept' };
  const firstAttempt = obsoleteReleasePages({
    previousArticlePages: [oldPage],
    currentArticlePages: [currentPage],
    previousArchivePages: [],
    currentArchivePages: [],
    aggregatePagesAllowed: true,
  });
  assert.deepEqual(firstAttempt.map((page) => page.id), ['gone']);
  // La prima run può fallire dopo il calcolo: il manifest non viene scritto e
  // il giro successivo rilegge la stessa lista pubblicata, non il parent del
  // secondo push (che ormai non contiene più `gone`).
  const secondAttempt = obsoleteReleasePages({
    previousArticlePages: [oldPage],
    currentArticlePages: [currentPage],
    previousArchivePages: [],
    currentArchivePages: [],
    aggregatePagesAllowed: true,
  });
  assert.deepEqual(secondAttempt.map((page) => page.id), ['gone']);
});

test('manifest edge: lettura 404 e documento di un’altra sezione restano fail-closed', async () => {
  const manifest = pageManifestFromPages({
    section: 'canton-ti',
    commit: 'old-commit',
    pages: [pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing')],
  });
  const ok = await fetchPageManifest('https://cdn.test/manifest.json', {
    section: 'canton-ti',
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => manifest }),
  });
  assert.equal(ok.state, 'ok');
  const wrong = await fetchPageManifest('https://cdn.test/manifest.json', {
    section: 'canton-ti',
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ ...manifest, section: 'canton-gr' }) }),
  });
  assert.equal(wrong.state, 'unknown');
  const absent = await fetchPageManifest('https://cdn.test/manifest.json', {
    fetchImpl: async () => ({ status: 404, ok: false }),
  });
  assert.equal(absent.state, 'absent');
});

test('publisher: argomenti', () => {
  assert.throws(() => parseArgs(['--section', 'svizzera', '--out', 'o', '--summary', 's']), /shard Pages/);
  assert.throws(() => parseArgs(['--out', 'o', '--summary', 's']), /manca --section/);
  assert.throws(() => parseArgs(['--section']), /richiede un valore/);
  assert.throws(() => parseArgs(['--section', 'canton-ti', '--ids', 'x', '--out', 'o', '--summary', 's']), /array JSON/);
  assert.throws(() => parseArgs(['--section', 'canton-ti', '--boh']), /argomento sconosciuto/);
  assert.equal(parseArgs(['--section', 'canton-ti', '--previous-revision', 'abc1234', '--out', 'o', '--summary', 's'], { active: ACTIVE_WITH_TI }).previousRevision, 'abc1234');
  assert.equal(parseArgs(['--section', 'canton-ti', '--remove-stale-canton-rss-feeds', '--out', 'o', '--summary', 's'], { active: ACTIVE_WITH_TI }).removeStaleCantonRssFeeds, true);
  assert.throws(
    () => parseArgs(['--section', 'canton-ti', '--bootstrap', '--id', 'a', '--out', 'o', '--summary', 's']),
    /non si combina/,
  );
  assert.equal(parseArgs(['--section', 'canton-ti', '--dry-run', '--out', 'o', '--summary', 's'], { active: ACTIVE_WITH_TI }).dryRun, true);
  assert.throws(
    () => parseArgs(['--section', 'canton-ti', '--dry-run', '--publish', '--out', 'o', '--summary', 's'], { active: ACTIVE_WITH_TI }),
    /alternativi/,
  );
});

test('publisher: chiave R2 = quella che il Worker calcola dal path canonico', () => {
  assert.deepEqual(pageEntry('canton-ti', 'en/ticino-articles/fuel/index.html', 'hub'), {
    kind: 'hub',
    locale: 'en',
    rel: 'en/ticino-articles/fuel/index.html',
    canonicalPath: '/en/ticino-articles/fuel/',
    edgeKey: 'edge/sections/en/ticino-articles/fuel/index.html',
    apexUrl: 'https://frontaliereticino.ch/en/ticino-articles/fuel/',
    cdnUrl: 'https://cdn.frontaliereticino.ch/edge/sections/en/ticino-articles/fuel/index.html',
  });
  assert.equal(pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing').edgeKey, 'edge/sections/articoli-ticino/index.html');
  // Il flat bridge non e' una pagina (il Worker fa da se' il 301 da /x.html).
  assert.throws(() => pageEntry('canton-ti', 'articoli-ticino/x.html', 'article'), /non canonica/);
  // Mai una chiave fuori dai prefissi della sezione.
  assert.throws(() => pageEntry('canton-ti', 'articoli-grigioni/x/index.html', 'article'), /non sta sotto un prefisso/);
  assert.throws(() => pageEntry('canton-ti', 'articoli-svizzera/tutti/index.html', 'archive'), /non sta sotto un prefisso/);
  assert.throws(() => pageEntry('canton-ti', 'articoli-ticino/Maiuscola/index.html', 'article'), /non valido/);
  const rendered = { relPath: 'en/ticino-articles/fuel/index.html', edgeKey: 'edge/sections/en/ticino-articles/fuel/index.html' };
  assert.equal(rendererPageEntry('canton-ti', rendered, 'hub').edgeKey, rendered.edgeKey);
  assert.throws(() => rendererPageEntry('canton-ti', { ...rendered, edgeKey: 'edge/sections/wrong/index.html' }, 'hub'), /diverso da/);
});

test('publisher: ritiri e cambi di slug cancellano solo le vecchie URL articolo', () => {
  const slugs = (prefix) => Object.fromEntries(
    ['gone', 'kept', 'renamed'].map((id) => [id, { it: `${prefix}-${id}-it`, en: `${prefix}-${id}-en`, de: `${prefix}-${id}-de`, fr: `${prefix}-${id}-fr` }]),
  );
  const previous = articleReleasePages('canton-ti', { ids: ['gone', 'kept', 'renamed'], slugs: slugs('old') });
  const current = articleReleasePages('canton-ti', {
    ids: ['kept', 'renamed'],
    slugs: { ...slugs('old'), renamed: slugs('new').renamed },
  });
  const obsolete = obsoleteArchivePages(previous, current);
  assert.equal(obsolete.length, 8, '4 locali ritirate + 4 URL del vecchio slug');
  assert.ok(obsolete.every((page) => page.edgeKey.startsWith('edge/sections/')));
  assert.ok(obsolete.every((page) => !current.some((live) => live.canonicalPath === page.canonicalPath)));
  assert.ok(!obsolete.some((page) => page.canonicalPath.includes('kept')));
  assert.match(read('scripts/publish-section-pages.mjs'), /scripts\/lib\/delete-cdn-file\.sh/);
});

test('publisher: una riduzione del corpus cancella anche le pagine archivio ritirate', () => {
  const previousArticles = Array.from({ length: 101 }, (_, index) => ({ id: `old-${index}` }));
  const currentArticles = previousArticles.slice(0, 99);
  const previous = archiveReleasePages('canton-ti', previousArticles);
  const current = archiveReleasePages('canton-ti', currentArticles);
  const obsolete = obsoleteArchivePages(previous, current);
  assert.equal(previous.length, 8, 'due pagine per quattro locali nella release precedente');
  assert.equal(current.length, 4, 'una pagina per quattro locali nella release corrente');
  assert.equal(obsolete.length, 4, 'la seconda pagina di archivio viene ritirata per ogni locale');
  assert.ok(obsolete.every((page) => page.kind === 'archive' && page.canonicalPath.includes('/page-2/')));
});

test('publisher: una sezione cantonale nuova o vuota ha una release articolo vuota, ma una coppia parziale si ferma', () => {
  const source = sectionSourceSurfaces('canton-ti');
  const missing = mkdtempSync(path.join(tmpdir(), 'release-empty-'));
  assert.deepEqual(articleReleaseSnapshot(missing, 'canton-ti'), []);

  const root = mkdtempSync(path.join(tmpdir(), 'release-skeleton-'));
  const registryPath = path.join(root, source.registryFile);
  const slugPath = path.join(root, source.slugFile);
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, 'export const CANTON_ARTICLES: Article[] = [\n];\n');
  assert.throws(() => articleReleaseSnapshot(root, 'canton-ti'), /registry\/slugs incompleti/);

  writeFileSync(slugPath, 'export const CANTON_SLUGS: Record<string, Record<string, string>> = {\n};\n');
  assert.deepEqual(articleReleaseSnapshot(root, 'canton-ti'), []);
  assert.deepEqual(sourceRegistryIds(root, 'canton-ti'), []);

  writeFileSync(slugPath, `export const CANTON_SLUGS = {
  'orphan': { it: 'orphan-it', en: 'orphan-en', de: 'orphan-de', fr: 'orphan-fr' },
};
`);
  assert.throws(() => articleReleaseSnapshot(root, 'canton-ti'), /registry\/slugs incoerenti/);
});

test('publisher: snapshot release ignora id annidati nel registry corrente e in quello precedente', () => {
  const source = sectionSourceSurfaces('canton-ti');
  const root = mkdtempSync(path.join(tmpdir(), 'release-nested-id-'));
  const registryPath = path.join(root, source.registryFile);
  const slugPath = path.join(root, source.slugFile);
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `export const CANTON_ARTICLES: Article[] = [
  {
    id: 'real-article',
    audit: {
      id: 'nested-not-an-article',
    },
  },
];
`);
  writeFileSync(slugPath, `export const CANTON_SLUGS = {
  'real-article': { it: 'articolo-reale', en: 'real-article', de: 'echter-artikel', fr: 'article-reel' },
};
`);

  try {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
    execFileSync('git', ['add', source.registryFile, source.slugFile], { cwd: root });
    execFileSync('git', [
      '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'release fixture',
    ], { cwd: root });
    const previousRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    for (const revision of [null, previousRevision]) {
      const pages = articleReleaseSnapshot(root, 'canton-ti', revision);
      assert.deepEqual([...new Set(pages.map((page) => page.id))], ['real-article']);
      assert.equal(pages.length, 4, 'una sola pagina articolo canonica per locale');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publisher/floors: una coppia cantonale parziale resta un rifiuto fail-closed', () => {
  const source = sectionSourceSurfaces('canton-ti');
  const root = mkdtempSync(path.join(tmpdir(), 'floor-partial-'));
  const registryPath = path.join(root, source.registryFile);
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, 'export const CANTON_ARTICLES: Article[] = [\n];\n');
  assert.throws(() => sourceRegistryIds(root, 'canton-ti'), /registry\/slugs incompleti/);
});

test('publisher: il delta comprende anche le pagine archivio page-N ritirate', () => {
  const slug = (id) => `  '${id}': { it: '${id}-it', en: '${id}-en', de: '${id}-de', fr: '${id}-fr' },`;
  const previousMeta = Array.from({ length: 101 }, (_, i) => `'blog.article.a${i}.title': 'A${i}',`).join('\n');
  const previousSlugs = `export const CANTON_SLUGS = {\n${Array.from({ length: 101 }, (_, i) => slug(`a${i}`)).join('\n')}\n};`;
  const currentMeta = `'blog.article.a0.title': 'A0',`;
  const currentSlugs = `export const CANTON_SLUGS = {\n${slug('a0')}\n};`;
  const previous = archiveReleasePages('canton-ti', { metaSource: previousMeta, slugSource: previousSlugs, slugConst: 'CANTON_SLUGS' });
  const current = archiveReleasePages('canton-ti', { metaSource: currentMeta, slugSource: currentSlugs, slugConst: 'CANTON_SLUGS' });
  const obsolete = obsoleteArticlePages(previous, current);
  assert.equal(previous.filter((page) => page.canonicalPath.includes('/page-2/')).length, 4);
  assert.equal(obsolete.filter((page) => page.canonicalPath.includes('/page-2/')).length, 4);
  assert.ok(obsolete.every((page) => page.kind === 'archive'));
});

test('publisher: abortisce prima del primo upload se main avanza durante il render', async () => {
  const events = [];
  const realConsoleLog = console.log;
  try {
    console.log = () => {};
    await assert.rejects(publish({
      section: 'canton-ti',
      pages: [],
      cdnUploads: [{ local: '/tmp/hero.webp', key: 'images/hero.webp' }],
      obsoletePages: [],
      distDir: mkdtempSync(path.join(tmpdir(), 'publish-stale-main-')),
      publishedStatusImpl: async () => {
        events.push('read-status');
        return 'draft';
      },
      assertMainFreshImpl: async () => {
        events.push('check-main');
        throw new Error('main e’ avanzato durante il render');
      },
      runImpl: () => {
        events.push('upload');
        return { code: 0, stdout: '✅ uploaded' };
      },
    }), /main e’ avanzato durante il render/);
  } finally {
    console.log = realConsoleLog;
  }
  assert.deepEqual(events, ['read-status', 'check-main']);
  assert.ok(!events.includes('upload'), 'nessuna mutazione remota parte con un render obsoleto');
});

test('publisher: lo staging snapshotta le chiavi prima dell HTML e ripristina un upload parziale', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'publish-bootstrap-snapshot-'));
  const first = pageEntry('canton-ti', 'articoli-ticino/new-one/index.html', 'article');
  const second = pageEntry('canton-ti', 'articoli-ticino/new-two/index.html', 'article');
  const previousHtml = `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body>precedente</body></html>`;
  const events = [];
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const result = await publish({
      section: 'canton-ti',
      pages: [first, second],
      cdnUploads: [],
      obsoletePages: [],
      distDir: fixtureRoot,
      snapshotPagesBeforeUpload: true,
      publishedStatusImpl: async () => 'live',
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          if (args[1].includes('.canton-page-rollback-')) {
            events.push('restore');
            return { code: 0, stdout: '✅ uploaded' };
          }
          events.push(`upload:${args[2].includes('new-one') ? 'one' : 'two'}`);
          return args[2].includes('new-one')
            ? { code: 0, stdout: '✅ uploaded' }
            : { code: 1, stdout: '' };
        }
        if (args[0] === 'scripts/lib/delete-cdn-file.sh') {
          events.push('delete-new-two');
          return { code: 0, stdout: '✅ deleted' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) {
          events.push('purge');
          return { code: 0, stdout: '' };
        }
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async (url) => {
        const isFirst = url === first.cdnUrl || url === first.apexUrl;
        events.push(isFirst ? 'probe-one' : 'probe-two');
        return isFirst
          ? { ok: true, status: 200, body: previousHtml }
          : { ok: false, status: 'HTTP 404' };
      },
    });
    assert.equal(result.failures, 1, JSON.stringify({ result, events }));
    assert.equal(result.uploaded, 1);
    assert.equal(result.rollbackFailures, 0);
    assert.deepEqual(events, [
      'probe-one', 'probe-two',
      'upload:one', 'upload:two',
      'restore', 'delete-new-two', 'purge',
      'probe-one', 'probe-one', 'probe-two', 'probe-two',
    ]);
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: lo staging rifiuta sostituzioni stale e usa il gate cross-workflow invece del polling readiness', async () => {
  const immutableRoot = mkdtempSync(path.join(tmpdir(), 'publish-bootstrap-immutable-'));
  const immutable = pageEntry('canton-ti', 'articoli-ticino/existing/index.html', 'article');
  const immutableLocal = path.join(immutableRoot, immutable.rel);
  mkdirSync(path.dirname(immutableLocal), { recursive: true });
  writeFileSync(immutableLocal, '<html>render nuovo</html>', 'utf8');
  let immutableUploads = 0;
  const immutableResult = await publish({
    section: 'canton-ti',
    pages: [immutable],
    immutablePages: [immutable],
    snapshotPagesBeforeUpload: true,
    cdnUploads: [],
    obsoletePages: [],
    distDir: immutableRoot,
    releaseCommit: 'old-release',
    publishedStatusImpl: async () => 'live',
    releaseReadyImpl: async () => ({ ok: false }),
    runImpl: () => {
      immutableUploads++;
      return { code: 0, stdout: '✅ uploaded' };
    },
    probeImpl: async () => ({ ok: true, status: 200, body: '<html>render precedente</html>' }),
  });
  assert.equal(immutableResult.failures, 1);
  assert.equal(immutableResult.immutableMismatch, true);
  assert.equal(immutableUploads, 0, 'una sostituzione di una chiave già annunciata non parte prima del flip');
  rmSync(immutableRoot, { recursive: true, force: true });

  const recheckRoot = mkdtempSync(path.join(tmpdir(), 'publish-bootstrap-recheck-'));
  const staged = pageEntry('canton-ti', 'articoli-ticino/staged/index.html', 'article');
  let readinessCalls = 0;
  let stagedUploads = 0;
  let stagedOnCdn = false;
  try {
    const recheckResult = await publish({
      section: 'canton-ti',
      pages: [staged],
      snapshotPagesBeforeUpload: true,
      cdnUploads: [],
      obsoletePages: [],
      distDir: recheckRoot,
      releaseCommit: 'old-release',
      publishedStatusImpl: async () => 'draft',
      releaseReadyImpl: async () => ({ ok: ++readinessCalls > 1 }),
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          stagedUploads++;
          stagedOnCdn = true;
        }
        return { code: 0, stdout: '✅ uploaded' };
      },
      probeImpl: async () => stagedOnCdn
        ? { ok: true, status: 200, body: `<html>${CORPUS_ROUTE_OWNER_META_TAG}</html>` }
        : { ok: false, status: 'HTTP 404' },
    });
    assert.equal(recheckResult.failures, 0);
    assert.notEqual(recheckResult.releaseAdvanced, true);
    assert.equal(recheckResult.uploaded, 1);
    assert.equal(stagedUploads, 1);
    assert.equal(readinessCalls, 0, 'la readiness non viene usata come lock: la coordinazione e\' cross-workflow');
  } finally {
    rmSync(recheckRoot, { recursive: true, force: true });
  }
});

test('publisher: un avanzamento di main prima dell HTML ripristina RSS e abortisce', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'publish-stale-main-html-'));
  const page = pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing');
  const feed = cantonRssFeedEntries('canton-ti')[0];
  const previousHtml = `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body>precedente</body></html>`;
  const events = [];
  let freshnessChecks = 0;
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const result = await publish({
      section: 'canton-ti',
      pages: [page],
      cdnUploads: [],
      cantonRssFeeds: [feed],
      obsoletePages: [],
      distDir: fixtureRoot,
      releaseCommit: 'f'.repeat(40),
      publishedStatusImpl: async () => 'live',
      assertMainFreshImpl: async () => {
        freshnessChecks++;
        if (freshnessChecks === 3) throw new Error('main e’ avanzato durante la pubblicazione');
      },
      publishCantonRssFeedsImpl: async () => ({
        failures: 0,
        uploaded: 1,
        verified: 1,
        feeds: [feed],
        rollback: async () => {
          events.push('rss-rollback');
          return { failures: 0 };
        },
      }),
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          events.push(args[1].includes('.canton-page-rollback-') ? 'page-rollback' : 'page-upload');
          return { code: 0, stdout: '✅ uploaded' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) {
          events.push('page-rollback-purge');
          return { code: 0, stdout: '' };
        }
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async () => ({ ok: true, status: 200, body: previousHtml }),
    });

    assert.equal(freshnessChecks, 3, 'il guard viene rieseguito subito prima dell upload HTML');
    assert.equal(result.failures, 1);
    assert.equal(result.rollbackFailures, 0);
    assert.equal(result.uploaded, 0);
    assert.equal(events.filter((event) => event === 'page-upload').length, 0);
    assert.equal(events.filter((event) => event === 'page-rollback').length, 1, 'rollback della pagina prima della verifica CDN/apex');
    assert.ok(events.includes('page-rollback-purge'));
    assert.ok(events.includes('rss-rollback'));
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: una pagina obsoleta resta intatta se la release corrente non e\' servita', async () => {
  const current = pageEntry('canton-ti', 'articoli-ticino/current/index.html', 'article');
  const obsolete = pageEntry('canton-ti', 'articoli-ticino/obsolete/index.html', 'article');
  const calls = [];
  const probes = [];
  const okPage = `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body>${'contenuto '.repeat(40)}</body></html>`;
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  let result;
  try {
    console.log = () => {};
    console.error = () => {};
    result = await publish({
      section: 'canton-ti',
      pages: [current],
      cdnUploads: [],
      obsoletePages: [obsolete],
      distDir: mkdtempSync(path.join(tmpdir(), 'publish-obsolete-')),
      publishedStatusImpl: async () => 'draft',
      runImpl: (command, args) => {
        calls.push({ command, args });
        if (args.some((arg) => arg.endsWith('upload-cdn-file.sh'))) return { code: 0, stdout: '✅ uploaded' };
        if (args.some((arg) => arg.endsWith('retry-cmd.sh'))) return { code: 0, stdout: '' };
        throw new Error(`non deve cancellare prima della verifica: ${args.join(' ')}`);
      },
      probeImpl: async (url) => {
        probes.push(url);
        return url === current.cdnUrl
          ? { ok: false, status: 500, body: '' }
          : { ok: true, status: 200, body: okPage };
      },
    });
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
  }
  assert.equal(result.failures, 1);
  assert.equal(result.deleted, 0);
  assert.ok(!calls.some(({ args }) => args.some((arg) => arg.endsWith('delete-cdn-file.sh'))));
  assert.ok(probes.some((url) => url === current.cdnUrl));
});

test('publisher: una URL obsoleta resta intatta finche\' API e edge non servono il commit corrente', async () => {
  const current = pageEntry('canton-ti', 'articoli-ticino/current/index.html', 'article');
  const obsolete = pageEntry('canton-ti', 'articoli-ticino/obsolete/index.html', 'article');
  const calls = [];
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  let result;
  try {
    console.log = () => {};
    console.error = () => {};
    result = await publish({
      section: 'canton-ti',
      pages: [current],
      cdnUploads: [],
      obsoletePages: [obsolete],
      distDir: mkdtempSync(path.join(tmpdir(), 'publish-api-edge-')),
      releaseCommit: 'current-commit',
      publishedStatusImpl: async () => 'draft',
      releaseReadyImpl: async () => ({ ok: false, reason: 'manifest vecchio' }),
      releaseReadyMaxWaitMs: 0,
      runImpl: (_command, args) => {
        calls.push(args.join(' '));
        if (args.some((arg) => arg.endsWith('retry-cmd.sh'))) return { code: 0, stdout: '' };
        if (args.some((arg) => arg.endsWith('upload-cdn-file.sh'))) return { code: 0, stdout: '✅ uploaded' };
        throw new Error(`non deve cancellare: ${args.join(' ')}`);
      },
      probeImpl: async () => ({ ok: true, status: 200, body: `<!doctype html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body>${'contenuto '.repeat(40)}` }),
    });
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
  }
  assert.equal(result.failures, 1);
  assert.equal(result.deleted, 0);
  assert.ok(!calls.some((call) => call.includes('delete-cdn-file.sh')));
});

test('publisher: la readiness API viene ritentata prima della pulizia obsoleta', async () => {
  const current = pageEntry('canton-ti', 'articoli-ticino/current/index.html', 'article');
  const obsolete = pageEntry('canton-ti', 'articoli-ticino/obsolete/index.html', 'article');
  const html = `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body>${'contenuto '.repeat(40)}</body></html>`;
  const events = [];
  let readinessAttempts = 0;
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  let result;
  try {
    console.log = () => {};
    console.error = () => {};
    result = await publish({
      section: 'canton-ti',
      pages: [current],
      cdnUploads: [],
      obsoletePages: [obsolete],
      distDir: mkdtempSync(path.join(tmpdir(), 'publish-readiness-retry-')),
      releaseCommit: 'current-commit',
      publishedStatusImpl: async () => 'draft',
      releaseReadyImpl: async () => {
        readinessAttempts++;
        return readinessAttempts < 3 ? { ok: false, reason: 'manifest vecchio' } : { ok: true };
      },
      releaseReadyMaxWaitMs: 1000,
      releaseReadyRetryDelayMs: 0,
      sleepImpl: async () => {},
      runImpl: (_command, args) => {
        if (args.some((arg) => arg.endsWith('upload-cdn-file.sh'))) events.push('upload');
        else if (args.some((arg) => arg.endsWith('delete-cdn-file.sh'))) events.push('delete');
        else if (args.some((arg) => args.includes('scripts/cf-purge-cache.mjs'))) events.push('purge');
        return {
          code: 0,
          stdout: args.some((arg) => arg.endsWith('delete-cdn-file.sh')) ? '✅ deleted' : '✅ uploaded',
        };
      },
      probeImpl: async (url) => url === obsolete.cdnUrl
        ? { ok: false, status: 'HTTP 404' }
        : { ok: true, status: 200, body: html },
    });
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
  }
  assert.equal(readinessAttempts, 3);
  assert.equal(result.failures, 0);
  assert.equal(result.deleted, 1);
  assert.ok(events.includes('delete'));
});

test('publisher: la cancellazione obsoleta arriva dopo purge e verifica della release corrente', async () => {
  const current = pageEntry('canton-ti', 'articoli-ticino/current/index.html', 'article');
  const obsolete = pageEntry('canton-ti', 'articoli-ticino/obsolete/index.html', 'article');
  const events = [];
  const html = `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body>${'contenuto '.repeat(40)}</body></html>`;
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  let result;
  try {
    console.log = () => {};
    console.error = () => {};
    result = await publish({
      section: 'canton-ti',
      pages: [current],
      cdnUploads: [],
      obsoletePages: [obsolete],
      distDir: mkdtempSync(path.join(tmpdir(), 'publish-obsolete-order-')),
      publishedStatusImpl: async () => 'draft',
      releaseReadyImpl: async () => ({ ok: true }),
      runImpl: (_command, args) => {
        if (args.some((arg) => arg.endsWith('upload-cdn-file.sh'))) events.push('upload');
        else if (args.some((arg) => arg.endsWith('delete-cdn-file.sh'))) events.push('delete');
        else if (args.some((arg) => arg.endsWith('retry-cmd.sh'))) events.push('purge');
        return {
          code: 0,
          stdout: args.some((arg) => arg.endsWith('delete-cdn-file.sh')) ? '✅ deleted' : '✅ uploaded',
        };
      },
      probeImpl: async (url) => {
        if (url === obsolete.cdnUrl) {
          events.push('probe-obsolete');
          return { ok: false, status: 'HTTP 404', body: '' };
        }
        events.push('probe-current');
        return { ok: true, status: 200, body: html };
      },
    });
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
  }
  assert.equal(result.failures, 0);
  assert.equal(result.deleted, 1);
  assert.ok(events.indexOf('probe-current') < events.indexOf('delete'));
  assert.ok(events.indexOf('delete') < events.indexOf('probe-obsolete'));
});

test('publisher: un hero CDN non confermato blocca l\'HTML della stessa release', async () => {
  const calls = [];
  const page = pageEntry('canton-ti', 'articoli-ticino/orphan/index.html', 'article');
  const output = [];
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  let result;
  try {
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    result = await publish({
      section: 'canton-ti',
      pages: [page],
      cdnUploads: [{ local: 'hero.webp', key: 'edge/sections/articoli-ticino/orphan/hero.webp' }],
      obsoletePages: [],
      distDir: mkdtempSync(path.join(tmpdir(), 'publish-hero-')),
      publishedStatusImpl: async () => 'draft',
      runImpl: (command, args) => {
        calls.push({ command, args });
        return { code: 1, stdout: '' };
      },
      probeImpl: async () => {
        throw new Error('il verify non deve partire dopo un hero fallito');
      },
    });
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
  }
  assert.equal(result.failures, 1);
  assert.equal(result.uploaded, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.join(' '), /upload-cdn-file\.sh/);
  assert.ok(output.some((line) => line.includes('upload hero incompleto')));
});

test('publisher: il gate hero include le card della landing anche con refresh parziale', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'landing-heroes-'));
  mkdirSync(path.join(root, 'public/images/places/thumbnails'), { recursive: true });
  writeFileSync(path.join(root, 'public/images/places/landing.webp'), 'hero');
  writeFileSync(path.join(root, 'public/images/places/thumbnails/landing-480w.webp'), 'thumb');
  const uploads = heroCdnUploads({
    rootDir: root,
    entries: [],
    htmlPages: [{ relPath: 'articoli-ticino/index.html', html: '<img src="/images/places/landing.webp">' }],
  });
  assert.deepEqual(uploads.map(({ key }) => key).sort(), [
    'images/places/landing.webp',
    'images/places/thumbnails/landing-480w.webp',
  ]);
  const missing = [];
  const realConsoleError = console.error;
  try {
    console.error = () => {};
    assert.deepEqual(heroCdnUploads({
      rootDir: root,
      entries: [],
      htmlPages: [{ html: '<img src="/images/blog/not-on-disk.webp">' }],
      missing,
    }), []);
  } finally {
    console.error = realConsoleError;
  }
  assert.deepEqual(missing, [{ kind: 'hero', local: 'public/images/blog/not-on-disk.webp', key: 'images/blog/not-on-disk.webp' }]);
});

test('publisher: cancella le URL ritirate solo dopo il verify della release corrente', async () => {
  const current = pageEntry('canton-ti', 'articoli-ticino/kept/index.html', 'article');
  const obsolete = pageEntry('canton-ti', 'articoli-ticino/gone/index.html', 'article');
  const calls = [];
  let deleted = false;
  const output = [];
  const realConsoleLog = console.log;
  const realConsoleError = console.error;
  let result;
  try {
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    result = await publish({
      section: 'canton-ti',
      pages: [current],
      cdnUploads: [],
      obsoletePages: [obsolete],
      distDir: mkdtempSync(path.join(tmpdir(), 'publish-order-')),
      publishedStatusImpl: async () => 'draft',
      releaseReadyImpl: async () => ({ ok: true }),
      runImpl: (command, args) => {
        const script = args.join(' ');
        if (script.includes('upload-cdn-file.sh')) {
          calls.push('upload');
          return { code: 0, stdout: '✅ uploaded' };
        }
        if (script.includes('delete-cdn-file.sh')) {
          deleted = true;
          calls.push('delete');
          return { code: 0, stdout: '✅ deleted' };
        }
        if (script.includes('cf-purge-cache.mjs')) {
          calls.push('purge');
          return { code: 0, stdout: '' };
        }
        throw new Error(`comando inatteso: ${command} ${script}`);
      },
      probeImpl: async (url) => {
        if (url === obsolete.cdnUrl) {
          calls.push('probe-obsolete');
          assert.equal(deleted, true, 'la vecchia URL si verifica dopo la cancellazione');
          return { status: 'HTTP 404' };
        }
        calls.push('probe-current');
        return { ok: true, status: 'HTTP 200' };
      },
    });
  } finally {
    console.log = realConsoleLog;
    console.error = realConsoleError;
  }
  assert.equal(result.failures, 0);
  assert.equal(result.deleted, 1);
  assert.deepEqual(calls, ['upload', 'purge', 'probe-current', 'delete', 'purge', 'probe-obsolete']);
  assert.deepEqual(output, [
    '[publish-section-pages] preflight: sezione canton-ti nel registro pubblicato = draft',
    '[publish-section-pages] verify: sezione canton-ti nel registro pubblicato = draft',
  ]);
});

test('publisher: una cancellazione obsoleta parziale non ripristina RSS su pagine ancora rimosse', async () => {
  const current = pageEntry('canton-ti', 'articoli-ticino/kept/index.html', 'article');
  const deleted = pageEntry('canton-ti', 'articoli-ticino/deleted/index.html', 'article');
  const failed = pageEntry('canton-ti', 'articoli-ticino/failed/index.html', 'article');
  const feed = cantonRssFeedEntries('canton-ti')[0];
  const html = `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body>${'contenuto '.repeat(40)}</body></html>`;
  const events = [];
  let deleteAttempts = 0;
  const result = await publish({
    section: 'canton-ti',
    pages: [current],
    cdnUploads: [],
    cantonRssFeeds: [feed],
    obsoletePages: [deleted, failed],
    distDir: mkdtempSync(path.join(tmpdir(), 'publish-obsolete-partial-')),
    releaseCommit: 'current-commit',
    publishedStatusImpl: async () => 'live',
    releaseReadyImpl: async () => ({ ok: true }),
    publishCantonRssFeedsImpl: async () => ({
      failures: 0,
      uploaded: 1,
      verified: 1,
      feeds: [feed],
      rollback: async () => {
        events.push('rss-rollback');
        return { failures: 0 };
      },
    }),
    runImpl: (_command, args) => {
      if (args.some((arg) => arg.endsWith('upload-cdn-file.sh'))) {
        events.push('upload');
        return { code: 0, stdout: '✅ uploaded' };
      }
      if (args.some((arg) => arg.endsWith('delete-cdn-file.sh'))) {
        deleteAttempts++;
        events.push(`delete-${deleteAttempts}`);
        return deleteAttempts === 1 ? { code: 0, stdout: '✅ deleted' } : { code: 0, stdout: '' };
      }
      if (args.some((arg) => args.includes('scripts/cf-purge-cache.mjs'))) {
        events.push('purge');
        return { code: 0, stdout: '' };
      }
      throw new Error(`comando inatteso: ${args.join(' ')}`);
    },
    probeImpl: async (url) => {
      if (url === deleted.cdnUrl) return { ok: false, status: 'HTTP 404' };
      if (url === failed.cdnUrl) return { ok: true, status: 'HTTP 200', body: html };
      return { ok: true, status: 'HTTP 200', body: html };
    },
  });
  assert.equal(result.failures, 2);
  assert.equal(result.deleted, 1);
  assert.equal(result.rollbackFailures, 0);
  assert.ok(events.includes('delete-1'));
  assert.ok(!events.includes('rss-rollback'), 'il feed snapshot non deve annunciare URL ancora rimosse');
  assert.equal(events.filter((event) => event === 'upload').length, 1, 'la release HTML corrente resta servita dopo una cancellazione obsoleta');
  assert.equal(events.filter((event) => event === 'purge').length, 2, 'non si fa rollback della release corrente dopo una mutazione obsoleta');
});

test('publisher: una pagina con noindex, senza meta di proprieta\', con asset same-origin o canonical altrui non esce', () => {
  const page = pageEntry('canton-ti', 'articoli-ticino/carburanti/index.html', 'hub');
  const good =
    `<!doctype html><html lang="it"><head><meta charset="utf-8">${CORPUS_ROUTE_OWNER_META_TAG}` +
    '<meta name="robots" content="index, follow, max-snippet:-1">' +
    `<link rel="canonical" href="${page.apexUrl}"><script src="https://cdn.frontaliereticino.ch/assets/index-entry.js"></script>` +
    `</head><body><main>${'contenuto '.repeat(40)}</main></body></html>`;
  assert.deepEqual(pageDefects(page, good), []);
  assert.match(pageDefects(page, good.replace('index, follow', 'noindex, follow')).join('|'), /noindex/);
  assert.match(pageDefects(page, good.replace(CORPUS_ROUTE_OWNER_META_TAG, '')).join('|'), /ft-route-owner/);
  assert.match(pageDefects(page, good.replace('https://cdn.frontaliereticino.ch/assets/', '/assets/')).join('|'), /same-origin/);
  assert.match(pageDefects(page, good.replace(page.apexUrl, 'https://frontaliereticino.ch/articoli-svizzera/')).join('|'), /canonical/);
  assert.match(pageDefects(page, '').join('|'), /vuota/);
});

test('publisher: le landing live annunciano il feed edge della propria locale', () => {
  const page = pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing');
  const feedUrl = cantonRssFeedUrlForLocale('canton-ti', 'it');
  const html =
    `<!doctype html><html lang="it"><head><meta charset="utf-8">${CORPUS_ROUTE_OWNER_META_TAG}` +
    `<link rel="canonical" href="${page.apexUrl}"></head><body><main>${'contenuto '.repeat(30)}</main></body></html>`;
  const linked = addCantonRssFeedLink(html, feedUrl);

  assert.equal(new URL(feedUrl).pathname, `/${CANTON_RSS_PREFIX}/rss-canton-ti.xml`);
  assert.equal(addCantonRssFeedLink(linked, feedUrl), linked, 'aggiunta idempotente');
  assert.deepEqual(pageDefects(page, linked, { requiredRssUrl: feedUrl }), []);
  assert.match(pageDefects(page, html, { requiredRssUrl: feedUrl }).join('|'), /link RSS/);
  assert.match(cantonRssFeedUrlForLocale('canton-ti', 'en'), /rss-canton-ti-en\.xml$/);
  assert.throws(() => addCantonRssFeedLink(html, 'https://example.test/feed.xml'), /fuori dalla superficie edge/);
});

test('publisher: la verifica CDN/apex richiede anche i link RSS della landing', async () => {
  const page = pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing');
  const feed = cantonRssFeedEntries('canton-ti')[0];
  const probes = [];
  const result = await publish({
    section: 'canton-ti',
    pages: [page],
    cdnUploads: [],
    cantonRssFeeds: [feed],
    obsoletePages: [],
    distDir: tmpdir(),
    releaseCommit: 'a'.repeat(40),
    publishedStatusImpl: async () => 'live',
    publishCantonRssFeedsImpl: async () => ({ failures: 0, uploaded: 1, verified: 1 }),
    runImpl: (_command, args) => args.includes('scripts/cf-purge-cache.mjs')
      ? { code: 0, stdout: '' }
      : { code: 0, stdout: '✅ uploaded' },
    probeImpl: async (url, { want }) => {
      const body = `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body></body></html>`;
      const ok = want(body);
      probes.push({ url, ok });
      return { ok, status: 200, body };
    },
  });
  assert.equal(result.failures, 1);
  assert.equal(result.uploaded, 1);
  assert.deepEqual(probes, [{ url: page.cdnUrl, ok: false }]);
});

test('publisher: verifica le landing col set RSS effettivamente pubblicato', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-rss-verified-set-'));
  const page = pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing');
  const feeds = cantonRssFeedEntries('canton-ti');
  const localPage = path.join(fixtureRoot, page.rel);
  const sourceHtml = addCantonRssFeedLink(
    `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body><main>${'contenuto '.repeat(30)}</main></body></html>`,
    feeds[0].url,
  );
  mkdirSync(path.dirname(localPage), { recursive: true });
  writeFileSync(localPage, sourceHtml, 'utf8');
  let uploadedHtml = '';
  const probes = [];
  try {
    const result = await publish({
      section: 'canton-ti',
      pages: [page],
      cdnUploads: [],
      cantonRssFeeds: feeds,
      obsoletePages: [],
      distDir: fixtureRoot,
      releaseCommit: 'a'.repeat(40),
      publishedStatusImpl: async () => 'live',
      publishCantonRssFeedsImpl: async () => ({ failures: 0, uploaded: 0, verified: 5, feeds: [] }),
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          uploadedHtml = readFileSync(args[1], 'utf8');
          return { code: 0, stdout: '✅ uploaded' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) return { code: 0, stdout: '' };
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async (url, { want }) => {
        const ok = want(uploadedHtml);
        probes.push({ url, ok });
        return { ok, status: ok ? 200 : 'HTTP 503', body: uploadedHtml };
      },
    });

    assert.equal(result.failures, 0);
    assert.doesNotMatch(uploadedHtml, /data-canton-rss-feed/);
    assert.equal(probes.length, 2, 'CDN e apex verificano la landing senza link RSS');
    assert.ok(probes.every(({ ok }) => ok));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: una sezione live senza articoli non annuncia feed RSS', () => {
  const feeds = cantonRssFeedEntries('canton-ti');
  const emptyCounts = { bySection: { 'canton-ti': { articles: 0 } } };
  assert.deepEqual(cantonRssFeedsDeclaredInManifest('canton-ti', {}, emptyCounts), []);
  assert.throws(
    () => cantonRssFeedsDeclaredInManifest('canton-ti', {}),
    /counts\.bySection\.canton-ti\.articles non verificabile/,
  );
  assert.throws(
    () => cantonRssFeedsDeclaredInManifest('canton-ti', {}, { bySection: { 'canton-ti': { articles: 1 } } }),
    /set RSS vuoto con 1 articoli dichiarati/,
  );
  assert.deepEqual(cantonRssFeedsDeclaredInManifest('canton-ti', Object.fromEntries(feeds.map(({ name }) => [name, 1]))), feeds);
  assert.throws(
    () => cantonRssFeedsDeclaredInManifest('canton-ti', { [feeds[0].name]: 1 }),
    /set feed RSS cantonali incompleto/,
  );
  const linked = addCantonRssFeedLink('<head></head><body>landing</body>', feeds[0].url);
  assert.doesNotMatch(removeCantonRssFeedLinks(linked), /data-canton-rss-feed/);
});

test('publisher: i feed RSS seguono il verdetto degli aggregati', () => {
  assert.deepEqual(cantonRssFeedsForPublish('canton-ti', {
    publishing: true,
    effectiveStatus: 'live',
    aggregatePagesAllowed: false,
  }), []);
  assert.equal(cantonRssFeedsForPublish('canton-ti', {
    publishing: true,
    effectiveStatus: 'live',
    aggregatePagesAllowed: true,
  }).length, 5);
});

test('publisher: copia e verifica via HTTP tutti i feed della release prima di caricare pagine', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-rss-publish-'));
  const releaseCommit = 'a'.repeat(40);
  const feeds = cantonRssFeedEntries('canton-ti');
  let readinessAttempts = 0;
  const sourceXml = Object.fromEntries(feeds.map(({ name }) => {
    const selfName = name === 'rss-canton-ti-it.xml' ? 'rss-canton-ti.xml' : name;
    return [name,
      `<?xml version="1.0"?><rss version="2.0"><channel>` +
      `<atom:link href="${APEX}/${selfName}" rel="self" type="application/rss+xml"/>` +
      '<item><title>Fixture</title></item></channel></rss>\n'];
  }));
  const expectedXml = Object.fromEntries(feeds.map((feed) => {
    const selfName = feed.name === 'rss-canton-ti-it.xml' ? 'rss-canton-ti.xml' : feed.name;
    const targetUrl = feed.name === 'rss-canton-ti-it.xml' ? cantonRssFeedUrlForLocale('canton-ti', 'it') : feed.url;
    return [feed.name, sourceXml[feed.name].replace(`${APEX}/${selfName}`, targetUrl)];
  }));
  const events = [];
  let freshnessChecks = 0;
  try {
    const result = await publishCantonRssFeeds({
      section: 'canton-ti',
      releaseCommit,
      effectiveStatus: 'live',
      distDir: fixtureRoot,
      releaseReadyImpl: async (commit, { section }) => {
        readinessAttempts++;
        events.push(`release-ready-${readinessAttempts}`);
        assert.equal(commit, releaseCommit);
        assert.equal(section, 'canton-ti');
        if (readinessAttempts === 1) return { ok: false, reason: 'manifest ancora in propagazione' };
        return {
          ok: true,
          commit,
          files: Object.fromEntries(feeds.map(({ name }) => [name, Buffer.byteLength(sourceXml[name], 'utf8')])),
        };
      },
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        assert.ok(parsed.searchParams.has('_sppr'), 'il feed API deve bypassare la cache');
        const apiPath = new URL(API_BASE).pathname;
        const name = parsed.pathname.slice(`${apiPath}/`.length);
        events.push(`fetch:${name}`);
        return { ok: true, status: 200, body: null, text: async () => sourceXml[name] };
      },
      snapshotImpl: async (url) => {
        events.push(`snapshot:${new URL(url).pathname.split('/').at(-1)}`);
        return { ok: false, status: 'HTTP 404' };
      },
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          const feed = feeds.find(({ key }) => key === args[2]);
          events.push(`upload:${feed.name}`);
          assert.equal(args[3], PAGE_CACHE_CONTROL);
          assert.equal(readFileSync(args[1], 'utf8'), expectedXml[feed.name]);
          return { code: 0, stdout: '✅ uploaded' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) {
          events.push('purge');
          for (const feed of feeds) assert.ok(args.at(-1).includes(feed.url));
          return { code: 0, stdout: '' };
        }
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async (url, { want }) => {
        const feed = feeds.find((candidate) => candidate.url === url);
        events.push(`verify:${feed.name}`);
        return { ok: want(expectedXml[feed.name]), status: 'HTTP 200' };
      },
      sleepImpl: async () => {},
      releaseReadyMaxWaitMs: 100,
      releaseReadyRetryDelayMs: 0,
      assertMainFreshImpl: async () => {
        freshnessChecks++;
      },
    });
    assert.equal(readinessAttempts, 2);
    assert.equal(result.failures, 0);
    assert.equal(result.uploaded, 5);
    assert.equal(result.verified, 5);
    assert.equal(result.feeds.length, 5);
    assert.equal(freshnessChecks, feeds.length + 1, 'guard prima di ogni upload RSS e del purge');
    assert.ok(events.indexOf('release-ready-2') < events.findIndex((event) => event.startsWith('fetch:')));
    assert.ok(Math.max(...events.map((event, index) => event.startsWith('snapshot:') ? index : -1)) < events.findIndex((event) => event.startsWith('upload:')));
    assert.ok(Math.max(...events.map((event, index) => event.startsWith('fetch:') ? index : -1)) < events.findIndex((event) => event.startsWith('upload:')));
    assert.ok(Math.max(...events.map((event, index) => event.startsWith('upload:') ? index : -1)) < events.indexOf('purge'));
    assert.ok(events.indexOf('purge') < events.findIndex((event) => event.startsWith('verify:')));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: RSS rilegge lo stato edge dopo la readiness e prima degli upload', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-rss-status-after-ready-'));
  const releaseCommit = 'f'.repeat(40);
  const feeds = cantonRssFeedEntries('canton-ti');
  try {
    const result = await publishCantonRssFeeds({
      section: 'canton-ti',
      releaseCommit,
      effectiveStatus: 'live',
      distDir: fixtureRoot,
      releaseReadyImpl: async (commit) => ({
        ok: true,
        commit,
        files: Object.fromEntries(feeds.map(({ name }) => [name, 1])),
      }),
      publishedStatusImpl: async () => 'draft',
      fetchImpl: async () => { throw new Error('fetch RSS inatteso dopo il downgrade edge'); },
      releaseReadyMaxWaitMs: 0,
    });
    assert.equal(result.failures, 1);
    assert.equal(result.status, 'draft');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: un upload RSS parziale ripristina l\'intero set precedente', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-rss-rollback-'));
  const releaseCommit = 'd'.repeat(40);
  const feeds = cantonRssFeedEntries('canton-ti');
  const sourceXml = Object.fromEntries(feeds.map(({ name }) => {
    const selfName = name === 'rss-canton-ti-it.xml' ? 'rss-canton-ti.xml' : name;
    return [name,
      `<?xml version="1.0"?><rss version="2.0"><channel>` +
      `<atom:link href="${APEX}/${selfName}" rel="self" type="application/rss+xml"/>` +
      '<item><title>Nuova release</title></item></channel></rss>\n'];
  }));
  const previousXml = Object.fromEntries(feeds.map(({ name }) => [name, `<rss><channel><item>${name} precedente</item></channel></rss>\n`]));
  const events = [];
  let sourceUploads = 0;
  try {
    const result = await publishCantonRssFeeds({
      section: 'canton-ti',
      releaseCommit,
      effectiveStatus: 'live',
      distDir: fixtureRoot,
      releaseReadyImpl: async (commit) => ({
        ok: true,
        commit,
        files: Object.fromEntries(feeds.map(({ name }) => [name, Buffer.byteLength(sourceXml[name], 'utf8')])),
      }),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const name = parsed.pathname.split('/').at(-1);
        return { ok: true, status: 200, body: null, text: async () => sourceXml[name] };
      },
      snapshotImpl: async (url) => {
        const name = new URL(url).pathname.split('/').at(-1);
        return { ok: true, status: 200, body: previousXml[name] };
      },
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          const feed = feeds.find(({ key }) => key === args[2]);
          if (args[1].includes('.canton-rss-rollback-')) {
            events.push(`restore:${feed.name}`);
            return { code: 0, stdout: '✅ uploaded' };
          }
          sourceUploads++;
          events.push(`upload:${feed.name}`);
          return sourceUploads === 1 ? { code: 0, stdout: '' } : { code: 0, stdout: '✅ uploaded' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) {
          events.push('rollback-purge');
          return { code: 0, stdout: '' };
        }
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async (url, { want }) => {
        const name = new URL(url).pathname.split('/').at(-1);
        events.push(`rollback-verify:${name}`);
        return { ok: want(previousXml[name]), status: 'HTTP 200', body: previousXml[name] };
      },
      releaseReadyMaxWaitMs: 0,
    });
    assert.equal(result.failures, 1);
    assert.equal(result.uploaded, 0, 'un set parziale non viene considerato pubblicato');
    assert.equal(result.rollbackFailures, 0);
    assert.deepEqual(
      events.filter((event) => event.startsWith('restore:')).sort(),
      feeds.map(({ name }) => `restore:${name}`).sort(),
    );
    assert.ok(events.indexOf('rollback-purge') > Math.max(...events.map((event, index) => event.startsWith('restore:') ? index : -1)));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: il contratto RSS precede gli upload HTML e il rollback ripristina la pagina', async () => {
  const page = pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing');
  const feed = cantonRssFeedEntries('canton-ti')[0];
  const makeRun = (events) => (_command, args) => {
    if (args.some((arg) => arg.endsWith('upload-cdn-file.sh'))) events.push('page-upload');
    if (args.some((arg) => args.includes('scripts/cf-purge-cache.mjs'))) events.push('purge');
    return { code: 0, stdout: '✅ uploaded' };
  };
  const common = {
    section: 'canton-ti',
    pages: [page],
    cdnUploads: [],
    cantonRssFeeds: [feed],
    obsoletePages: [],
    distDir: tmpdir(),
    releaseCommit: 'c'.repeat(40),
    publishedStatusImpl: async () => 'live',
    probeImpl: async () => ({ ok: true, status: 200, body: '<html></html>' }),
    releaseReadyMaxWaitMs: 0,
  };

  const successEvents = [];
  const success = await publish({
    ...common,
    runImpl: makeRun(successEvents),
    publishCantonRssFeedsImpl: async (options) => {
      successEvents.push('rss-verified');
      assert.equal(options.releaseReadyMaxWaitMs, 0);
      return { failures: 0, uploaded: 5, verified: 5 };
    },
  });
  assert.equal(success.failures, 0);
  assert.ok(successEvents.indexOf('rss-verified') < successEvents.indexOf('page-upload'));

  const emptyEvents = [];
  const empty = await publish({
    ...common,
    cantonRssFeeds: [],
    removeStaleCantonRssFeeds: true,
    runImpl: makeRun(emptyEvents),
    publishCantonRssFeedsImpl: async (options) => {
      emptyEvents.push('rss-cleanup');
      assert.deepEqual(options.feedEntries, []);
      return { failures: 0, uploaded: 0, deleted: 5, verified: 5, feeds: [] };
    },
  });
  assert.equal(empty.failures, 0);
  assert.ok(emptyEvents.indexOf('rss-cleanup') < emptyEvents.indexOf('page-upload'));

  const blockedEvents = [];
  const blocked = await publish({
    ...common,
    runImpl: makeRun(blockedEvents),
    publishCantonRssFeedsImpl: async () => {
      blockedEvents.push('rss-failed');
      return { failures: 1, uploaded: 0, verified: 0 };
    },
  });
  assert.equal(blocked.failures, 1);
  assert.deepEqual(blockedEvents, ['rss-failed']);

  const rollbackEvents = [];
  const partial = await publish({
    ...common,
    runImpl: (_command, args) => {
      if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
        if (args[1].includes('.canton-page-rollback-')) {
          rollbackEvents.push('page-rollback');
          return { code: 0, stdout: '✅ uploaded' };
        }
        rollbackEvents.push('page-upload-failed');
        return { code: 1, stdout: '' };
      }
      if (args.includes('scripts/cf-purge-cache.mjs')) {
        rollbackEvents.push('page-rollback-purge');
        return { code: 0, stdout: '' };
      }
      throw new Error(`comando inatteso: ${args.join(' ')}`);
    },
    publishCantonRssFeedsImpl: async () => ({
      failures: 0,
      uploaded: 5,
      verified: 5,
      rollback: async () => {
        rollbackEvents.push('rss-rollback');
        return { failures: 0 };
      },
    }),
  });
  assert.equal(partial.failures, 1);
  assert.equal(partial.rollbackFailures, 0);
  assert.deepEqual(rollbackEvents, ['page-upload-failed', 'page-rollback', 'page-rollback-purge', 'rss-rollback']);

  const incompleteRollbackEvents = [];
  const incompleteRollback = await publish({
    ...common,
    runImpl: (_command, args) => {
      if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
        if (args[1].includes('.canton-page-rollback-')) {
          incompleteRollbackEvents.push('page-rollback-failed');
          return { code: 1, stdout: '' };
        }
        incompleteRollbackEvents.push('page-upload-failed');
        return { code: 1, stdout: '' };
      }
      if (args.includes('scripts/cf-purge-cache.mjs')) {
        incompleteRollbackEvents.push('page-rollback-purge');
        return { code: 0, stdout: '' };
      }
      throw new Error(`comando inatteso: ${args.join(' ')}`);
    },
    publishCantonRssFeedsImpl: async () => ({
      failures: 0,
      uploaded: 5,
      verified: 5,
      rollback: async ({ neutralize } = {}) => {
        incompleteRollbackEvents.push(neutralize ? 'rss-neutralize' : 'rss-rollback');
        return { failures: 0 };
      },
    }),
  });
  assert.equal(incompleteRollback.failures, 2);
  assert.equal(incompleteRollback.rollbackFailures, 1);
  assert.ok(incompleteRollbackEvents.includes('rss-neutralize'), 'RSS viene neutralizzato anche con rollback HTML incompleto');

  const verifyRollbackEvents = [];
  const previousHtml = '<html>pagina precedente</html>';
  let snapshotTaken = false;
  let restoring = false;
  const verifyFailure = await publish({
    ...common,
    publishedStatusImpl: async () => 'live',
    runImpl: (_command, args) => {
      if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
        if (args[1].includes('.canton-page-rollback-')) {
          restoring = true;
          verifyRollbackEvents.push('page-restored');
          return { code: 0, stdout: '✅ uploaded' };
        }
        verifyRollbackEvents.push('page-uploaded');
        return { code: 0, stdout: '✅ uploaded' };
      }
      if (args.includes('scripts/cf-purge-cache.mjs')) return { code: 0, stdout: '' };
      throw new Error(`comando inatteso: ${args.join(' ')}`);
    },
    probeImpl: async () => {
      if (!snapshotTaken) {
        snapshotTaken = true;
        return { ok: true, status: 200, body: previousHtml };
      }
      if (restoring) return { ok: true, status: 200, body: previousHtml };
      verifyRollbackEvents.push('page-verify-failed');
      return { ok: false, status: 'HTTP 503' };
    },
    publishCantonRssFeedsImpl: async () => ({
      failures: 0,
      uploaded: 5,
      verified: 5,
      rollback: async () => {
        verifyRollbackEvents.push('rss-rollback');
        return { failures: 0 };
      },
    }),
  });
  assert.equal(verifyFailure.failures, 1);
  assert.equal(verifyFailure.rollbackFailures, 0);
  assert.deepEqual(verifyRollbackEvents, ['page-uploaded', 'page-verify-failed', 'page-restored', 'rss-rollback']);
});

test('publisher: rilegge lo stato edge subito prima di pubblicare RSS', async () => {
  const page = pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing');
  const feed = cantonRssFeedEntries('canton-ti')[0];
  const statuses = ['live', 'draft'];
  let rssCalls = 0;
  const result = await publish({
    section: 'canton-ti',
    pages: [page],
    cdnUploads: [],
    cantonRssFeeds: [feed],
    obsoletePages: [],
    distDir: mkdtempSync(path.join(tmpdir(), 'publish-rss-status-reread-')),
    releaseCommit: 'e'.repeat(40),
    publishedStatusImpl: async () => statuses.shift() ?? 'draft',
    publishCantonRssFeedsImpl: async () => {
      rssCalls++;
      return { failures: 0, uploaded: 1, verified: 1 };
    },
  });
  assert.equal(result.failures, 1);
  assert.equal(result.status, 'draft');
  assert.equal(rssCalls, 0, 'una sezione retrocessa non deve entrare nel publisher RSS');
});

test('publisher: una demozione durante la verifica ripristina HTML e feed RSS', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'publish-rss-status-changed-'));
  const page = pageEntry('canton-ti', 'articoli-ticino/index.html', 'landing');
  const feed = cantonRssFeedEntries('canton-ti')[0];
  const previousHtml = `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body>release precedente</body></html>`;
  const publishedHtml = addCantonRssFeedLink(
    `<!doctype html><html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head><body>release nuova</body></html>`,
    feed.url,
  );
  const statuses = ['live', 'live', 'draft'];
  const events = [];
  let snapshotTaken = false;
  let restoring = false;
  try {
    const result = await publish({
      section: 'canton-ti',
      pages: [page],
      cdnUploads: [],
      cantonRssFeeds: [feed],
      obsoletePages: [],
      distDir: fixtureRoot,
      releaseCommit: 'e'.repeat(40),
      publishedStatusImpl: async () => statuses.shift() ?? 'draft',
      publishCantonRssFeedsImpl: async () => ({
        failures: 0,
        uploaded: 1,
        verified: 1,
        feeds: [feed],
        rollback: async () => {
          events.push('rss-rollback');
          return { failures: 0 };
        },
      }),
      runImpl: (_command, args) => {
        if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
          if (args[1].includes('.canton-page-rollback-')) {
            restoring = true;
            events.push('page-restored');
          } else {
            events.push('page-uploaded');
          }
          return { code: 0, stdout: '✅ uploaded' };
        }
        if (args.includes('scripts/cf-purge-cache.mjs')) {
          events.push(restoring ? 'rollback-purge' : 'page-purge');
          return { code: 0, stdout: '' };
        }
        throw new Error(`comando inatteso: ${args.join(' ')}`);
      },
      probeImpl: async (_url, { want }) => {
        if (!snapshotTaken) {
          snapshotTaken = true;
          return { ok: true, status: 200, body: previousHtml };
        }
        const body = restoring ? previousHtml : publishedHtml;
        return { ok: want(body), status: 200, body };
      },
    });

    assert.equal(result.failures, 1);
    assert.equal(result.rollbackFailures, 0);
    assert.equal(result.status, 'draft');
    assert.deepEqual(events, ['page-uploaded', 'page-purge', 'page-restored', 'rollback-purge', 'rss-rollback']);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: RSS non live fallisce, e un manifest senza feed elimina la superficie precedente', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'section-rss-empty-'));
  const feeds = cantonRssFeedEntries('canton-ti');
  const previousXml = Object.fromEntries(feeds.map(({ name }) => [name, `<rss>${name} precedente</rss>`]));
  let fetches = 0;
  let restoring = false;
  const deleted = [];
  const restored = [];
  const verifiedMissing = [];
  const common = {
    section: 'canton-ti',
    releaseCommit: 'b'.repeat(40),
    distDir: fixtureRoot,
    feedEntries: [],
    fetchImpl: async () => { fetches++; throw new Error('fetch API inatteso'); },
    releaseReadyMaxWaitMs: 0,
    releaseReadyImpl: async (commit) => ({
      ok: true,
      commit,
      files: {},
      counts: { bySection: { 'canton-ti': { articles: 0 } } },
    }),
    snapshotImpl: async (url) => {
      const name = new URL(url).pathname.split('/').at(-1);
      return { ok: true, status: 200, body: previousXml[name] };
    },
    runImpl: (_command, args) => {
      if (args[0] === 'scripts/lib/delete-cdn-file.sh') {
        deleted.push(args[1]);
        return { code: 0, stdout: '✅ deleted' };
      }
      if (args[0] === 'scripts/lib/upload-cdn-file.sh') {
        restored.push(args[2]);
        return { code: 0, stdout: '✅ uploaded' };
      }
      if (args.includes('scripts/cf-purge-cache.mjs')) return { code: 0, stdout: '' };
      throw new Error(`comando inatteso: ${args.join(' ')}`);
    },
    probeImpl: async (url) => {
      const name = new URL(url).pathname.split('/').at(-1);
      if (restoring) return { ok: true, status: 200, body: previousXml[name] };
      verifiedMissing.push(name);
      return { ok: false, status: 'HTTP 404' };
    },
  };
  try {
    const draft = await publishCantonRssFeeds({ ...common, effectiveStatus: 'draft' });
    assert.equal(draft.failures, 1);

    const missing = await publishCantonRssFeeds({ ...common, effectiveStatus: 'live' });
    assert.equal(missing.failures, 0);
    assert.equal(missing.deleted, feeds.length);
    assert.equal(missing.verified, feeds.length);
    assert.deepEqual(missing.feeds, []);
    assert.deepEqual(deleted.sort(), feeds.map(({ key }) => key).sort());
    assert.deepEqual(verifiedMissing.sort(), feeds.map(({ name }) => name).sort());
    assert.equal(fetches, 0);

    restoring = true;
    const rollback = await missing.rollback();
    assert.equal(rollback.failures, 0);
    assert.deepEqual(restored.sort(), feeds.map(({ key }) => key).sort());

    deleted.length = 0;
    verifiedMissing.length = 0;
    restoring = false;
    const retired = await publishCantonRssFeeds({
      ...common,
      effectiveStatus: 'retired',
      removeStaleCantonRssFeeds: true,
      releaseReadyImpl: async (commit) => ({
        ok: true,
        commit,
        files: {},
        counts: { bySection: {} },
      }),
      publishedStatusImpl: async () => 'retired',
    });
    assert.equal(retired.failures, 0);
    assert.equal(retired.deleted, feeds.length);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publisher: registry edge illeggibile o con stato sconosciuto non diventa draft', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      status: 200,
      text: async () => '{"schema":1,"commit":"abc1234","sections":{"canton-ti":{"status":"draft"}},"release":{}}',
    });
    assert.equal(await publishedStatus('canton-ti'), null);
    globalThis.fetch = async () => ({ status: 200, text: async () => '{"schema":1,"commit":"abc1234","sections":{"canton-ti":{"status":"draft"}}}' });
    assert.equal(await publishedStatus('canton-ti'), 'draft');
    globalThis.fetch = async () => ({ status: 200, text: async () => '{"schema":1,"commit":"abc1234","sections":{"canton-ti":{"status":"live"}}}' });
    assert.equal(await publishedStatus('canton-ti'), 'live');
    globalThis.fetch = async () => ({ status: 200, text: async () => '{"schema":1,"commit":"abc1234","sections":{"canton-ti":{"status":"retired"}}}' });
    assert.equal(await publishedStatus('canton-ti'), 'retired');
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.match(read('scripts/publish-section-pages.mjs'), /beforeStatus === null/);
  assert.match(read('scripts/publish-section-pages.mjs'), /if \(status === null\)/);
});

test('publisher: il readiness gate rifiuta una superficie API ancora vecchia', async () => {
  const result = await publishedReleaseReady('current-commit', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ commit: 'old-commit' }) }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /manifest API/);
});

test('publisher: hub mancanti sono fatali sulla sola verita\' effettiva live', () => {
  assert.equal(hubMissingIsFatal({ declaredStatus: 'live', effectiveStatus: 'draft', publishing: true }), false);
  assert.equal(hubMissingIsFatal({ declaredStatus: 'draft', effectiveStatus: 'live', publishing: true }), true);
  assert.equal(hubMissingIsFatal({ declaredStatus: 'live', effectiveStatus: null, publishing: true }), false);
  assert.equal(hubMissingIsFatal({ declaredStatus: 'live', effectiveStatus: null, publishing: false }), true);
  assert.match(read('scripts/publish-section-pages.mjs'), /const effectiveStatus = publishing \? await publishedStatusImpl\(section\) : null/);
});

test('publisher: il meta di proprieta\' si aggiunge solo dove manca', () => {
  const bare = '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body></body></html>';
  const owned = ensureRouteOwnerMeta(bare);
  assert.ok(owned.includes(`<meta charset="utf-8">\n${CORPUS_ROUTE_OWNER_META_TAG}`));
  assert.equal(ensureRouteOwnerMeta(owned), owned, 'idempotente');
  assert.ok(ensureRouteOwnerMeta('<html><head><title>x</title></head></html>').includes(`<head>\n${CORPUS_ROUTE_OWNER_META_TAG}`));
  assert.throws(() => ensureRouteOwnerMeta('<p>niente head</p>'), /senza <head>/);
});

test('publisher: la landing si carica per ultima', () => {
  assert.deepEqual(UPLOAD_ORDER, ['article', 'archive', 'hub', 'landing']);
  const kinds = inUploadOrder([{ kind: 'landing' }, { kind: 'hub', n: 1 }, { kind: 'article' }, { kind: 'hub', n: 2 }, { kind: 'archive' }]);
  assert.deepEqual(kinds.map((p) => p.kind), ['article', 'archive', 'hub', 'hub', 'landing']);
  assert.deepEqual(kinds.filter((p) => p.kind === 'hub').map((p) => p.n), [1, 2], 'stabile dentro il tipo');
});

test('publisher: la radice di render espone il corpus nel layout che l\'engine legge', () => {
  const view = createRenderRoot(ROOT, mkdtempSync(path.join(tmpdir(), 'rr-')));
  try {
    const target = (rel) => path.relative(ROOT, readlinkSync(path.join(view, rel)));
    assert.equal(target('services/locales'), 'content');
    assert.equal(target('packages/articles/content'), 'content');
    assert.ok(lstatSync(path.join(view, 'engine')).isSymbolicLink());
    assert.ok(lstatSync(path.join(view, 'services/seo')).isDirectory(), 'la directory SEO deve poter contenere il bridge cantonale');
    assert.equal(target('services/seo/seo-blog-ch.ts'), path.join('content', 'seo', 'seo-blog-ch.ts'));
    // I path dell'engine per una sezione cantonale cadono sui file veri del corpus.
    assert.ok(existsSync(path.join(view, 'services/locales/blog-meta-ch-it.ts')));
    assert.ok(existsSync(path.join(view, 'services/seo/seo-blog-ch.ts')));
    assert.ok(existsSync(path.join(view, 'services/routerSwissData.ts')));
    assert.ok(!existsSync(path.join(view, '.git')));
  } finally {
    rmSync(view, { recursive: true, force: true });
  }
});

test('il chunk SEO cantonale sta dove l\'engine lo legge (descrittore articolo e RSS)', () => {
  const seoFile = cantonSectionPaths('canton-ti').seoFile;
  assert.equal(seoFile, 'packages/articles/content/cantons/canton-ti/seo.ts');
  assert.equal(corpusPath(seoFile), 'content/cantons/canton-ti/seo.ts');
  // Il lato engine usa il nome storico, il bridge runtime collega la sorgente P10/P6b.
  assert.ok(read('engine/shared/articleSectionDescriptors.ts').includes('seoFiles: [`services/seo/seo-blog-${core.section}.ts`]'));
  assert.match(read('engine/rssFeeds.mjs'), /seo-blog-\$\{core\.section\}\.ts/);
  assert.match(read('scripts/lib/engine-corpus-view.mjs'), /cantonSeoSourceFile/);
  assert.match(read('scripts/lib/engine-corpus-view.mjs'), /engineSeoChunkName/);
});

// ── Dati degli hub ───────────────────────────────────────────────────────────

function hubRoot(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'hub-data-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
const HUB_TEST_INTRO = 'Questa guida evergreen raccoglie informazioni pratiche, contesto aggiornato, fonti ufficiali e indicazioni operative per chi vive o lavora nel cantone. Il testo spiega come leggere i dati, quali verifiche fare e dove trovare ulteriori dettagli affidabili prima di prendere decisioni personali, con esempi, definizioni, scadenze e riferimenti facilmente consultabili da ogni lettore.';
const locale = (localeCode, topic, intro = HUB_TEST_INTRO) => ({
  canton: 'TI',
  topic,
  locale: localeCode,
  intro,
  keyFacts: [],
  dataBlocks: [],
  curatedArticles: [],
  latestCantonArticles: [],
  links: [],
  updatedAt: '2026-10-05T00:00:00Z',
});
const fourLocales = (topic) => Object.fromEntries(['it', 'en', 'de', 'fr'].map((localeCode) => [localeCode, locale(localeCode, topic)]));
const hubDocument = (topic, locales = fourLocales(topic)) => ({
  schemaVersion: 1,
  id: `canton-ti:${topic}`,
  section: 'canton-ti',
  canton: 'TI',
  topic,
  updatedAt: '2026-10-05T00:00:00Z',
  contentHash: 'a'.repeat(64),
  blocks: [],
  locales,
});

test('hub: un solo posto sa dove sta il file dati; assente = hub non pubblicato', () => {
  assert.equal(cantonHubDataFile('canton-ti', 'fisco'), 'content/cantons/canton-ti/hubs/fisco.json');
  assert.deepEqual(cantonHubTopics('canton-ti'), ['carburanti', 'fisco', 'mobilita', 'eventi', 'pensioni', 'servizi']);
  const root = hubRoot({
    'content/cantons/canton-ti/hubs/fisco.json': hubDocument('fisco'),
    'content/cantons/canton-ti/hubs/eventi.json': hubDocument('eventi'),
  });
  assert.equal(readCantonHubData(root, 'canton-ti', 'carburanti'), null);
  assert.equal(readCantonHubData(root, 'canton-ti', 'fisco').de.intro, HUB_TEST_INTRO);
  assert.equal(readCantonHubData(root, 'canton-ti', 'eventi').fr.intro, HUB_TEST_INTRO);
  const legacy = hubDocument('servizi');
  for (const entry of Object.values(legacy.locales)) delete entry.latestCantonArticles;
  const legacyRoot = hubRoot({ 'content/cantons/canton-ti/hubs/servizi.json': legacy });
  assert.equal(readCantonHubData(legacyRoot, 'canton-ti', 'servizi').it.curatedArticles.length, 0, 'i documenti pre-fallback restano leggibili durante il refresh');
  assert.deepEqual(cantonHubCoverage(root, 'canton-ti'), { present: ['fisco', 'eventi'], missing: ['carburanti', 'mobilita', 'pensioni', 'servizi'] });
  assert.throws(() => readCantonHubData(root, 'canton-ti', 'boh'), /sconosciuto/);
  assert.throws(() => cantonHubTopics('svizzera'), /hub tematici/);
});

test('hub: un file presente ma incompleto e\' un errore, non un hub in tre lingue', () => {
  const partial = fourLocales('fisco');
  delete partial.fr;
  const empty = fourLocales('eventi');
  empty.de.intro = '   ';
  const root = hubRoot({
    'content/cantons/canton-ti/hubs/fisco.json': hubDocument('fisco', partial),
    'content/cantons/canton-ti/hubs/eventi.json': hubDocument('eventi', empty),
    'content/cantons/canton-ti/hubs/servizi.json': '{ rotto',
  });
  assert.throws(() => readCantonHubData(root, 'canton-ti', 'fisco'), /locali/);
  assert.throws(() => readCantonHubData(root, 'canton-ti', 'eventi'), /intro "de" vuota/);
  assert.throws(() => readCantonHubData(root, 'canton-ti', 'servizi'), /JSON illeggibile/);
});

test('registro: gli hub mancanti lasciano draft, quelli malformati bloccano', () => {
  const doc = JSON.parse(read(SECTION_REGISTRY_FILE));
  // Il caso prova una singola sezione live: non deve ereditare i cantoni
  // attivati dal rollout reale del registry committato.
  for (const entry of Object.values(doc.sections)) entry.status = 'draft';
  doc.sections['canton-ti'].status = 'live';
  const withHubs = (missing) => declaredRegistryErrors(doc, { active: ACTIVE_WITH_TI, missingHubsOf: () => missing });
  assert.deepEqual(withHubs([]), []);
  assert.deepEqual(withHubs(['eventi', 'servizi']), []);
  // Dati malformati: errore del registro, non un'eccezione che nasconde gli altri.
  const broken = declaredRegistryErrors(doc, { active: ACTIVE_WITH_TI, missingHubsOf: () => { throw new Error('intro "de" vuota'); } });
  assert.match(broken.join('\n'), /canton-ti: dati hub non validi \(intro "de" vuota\)/);
  // Draft: nessun vincolo sugli hub.
  doc.sections['canton-ti'].status = 'draft';
  assert.deepEqual(declaredRegistryErrors(doc, { missingHubsOf: () => ['eventi'] }), []);
  // Il publisher ripete il vincolo sul commit che sta pubblicando.
  assert.match(read('scripts/publish-section-pages.mjs'), /hubMissingIsFatal\(\{ declaredStatus: declared, effectiveStatus, publishing \}\)/);
  assert.match(read('scripts/build-api.mjs'), /loadDeclaredRegistry\(ROOT\)/);
});

// ── Cosa fa scattare un publish ──────────────────────────────────────────────

test('piano R2: sezioni cantonali toccate da un commit, con gli id dei corpi cambiati', () => {
  assert.deepEqual(r2PublishPlan(['content/blog-body-canton-ti/it/a.ts'], HISTORICAL_CORE_LIST), [], 'sezione non attiva: niente');
  const plan = r2PublishPlan([
    'content/blog-body-canton-ti/it/b.ts',
    'content/blog-body-canton-ti/de/a.ts',
    'content/blog-body-canton-ti/fr/a.ts',
    'content/blog-body-ch/it/svizzero.ts',
    'content/blog-body/it/frontaliere.ts',
    'scripts/build-api.mjs',
    '',
  ], WITH_TI);
  assert.deepEqual(plan, [{ section: 'canton-ti', ids: ['a', 'b'], bootstrap: false }]);
  // Senza corpi: un giro di rinfresco (landing, archivio, hub).
  for (const rel of [
    'content/cantons/canton-ti/hubs/fisco.json',
    'content/cantons/canton-ti/registry.ts',
    'content/cantons/canton-ti/seo.ts',
    'content/blog-meta-canton-ti-en.ts',
  ]) {
    const expectedBootstrap = !rel.includes('/hubs/');
    assert.deepEqual(r2PublishPlan([rel], WITH_TI), [{ section: 'canton-ti', ids: [], bootstrap: expectedBootstrap }], rel);
  }
  // A hub-only change does not need to render every article.
  assert.deepEqual(
    r2PublishPlan(['M\tcontent/cantons/canton-ti/hubs/fisco.json'], WITH_TI),
    [{ section: 'canton-ti', ids: [], bootstrap: false }],
  );
  const registryBefore = { schema: 1, sections: { 'canton-ti': { status: 'draft' } } };
  const registryAfter = { schema: 1, sections: { 'canton-ti': { status: 'live' } } };
  const promotedSections = liveRegistryTransitionSections(registryBefore, registryAfter, WITH_TI);
  assert.deepEqual(promotedSections, ['canton-ti']);
  const releaseCommit = 'a'.repeat(40);
  assert.deepEqual(
    liveR2ReconciliationPlan({
      schema: 1,
      commit: releaseCommit,
      sections: { 'canton-ti': { status: 'live' } },
    }, WITH_TI, releaseCommit),
    [{ section: 'canton-ti', ids: [], bootstrap: true }],
    'il replay schedule/manuale usa il registro edge della release attesa e fa bootstrap delle cantonali live',
  );
  assert.throws(
    () => liveR2ReconciliationPlan({
      schema: 1,
      commit: 'b'.repeat(40),
      sections: { 'canton-ti': { status: 'live' } },
    }, WITH_TI, releaseCommit),
    /commit.*atteso/,
    'un registro edge precedente non deve produrre una matrice verde',
  );
  assert.throws(
    () => liveR2ReconciliationPlan({ schema: 1, commit: 'not-a-commit', sections: {} }, WITH_TI, releaseCommit),
    /registro edge effettivo non valido/,
  );
  assert.deepEqual(
    r2PublishPlan(['M\tsections/registry.json'], WITH_TI, { registryRefreshSections: promotedSections }),
    [{ section: 'canton-ti', ids: [], bootstrap: true }],
    'una promozione draft -> live deve fare bootstrap degli articoli prima di annunciare landing, archivio, hub e RSS',
  );
  const demotedSections = liveRegistryTransitionSections(
    registryAfter,
    registryBefore,
    WITH_TI,
  );
  assert.deepEqual(demotedSections, ['canton-ti']);
  assert.deepEqual(
    r2PublishPlan(['M\tsections/registry.json'], WITH_TI, {
      registryRefreshSections: demotedSections,
      registryCleanupSections: demotedSections,
    }),
    [{ section: 'canton-ti', ids: [], bootstrap: true, removeStaleCantonRssFeeds: true }],
    'una demozione live -> draft deve portare il cleanup dei feed nel piano',
  );
  assert.deepEqual(
    liveR2ReconciliationPlan({
      schema: 1,
      commit: releaseCommit,
      sections: { 'canton-ti': { status: 'draft' } },
    }, WITH_TI, releaseCommit),
    [{ section: 'canton-ti', ids: [], bootstrap: false, removeStaleCantonRssFeeds: true }],
    'il reconcile schedule/manuale deve pulire i feed dopo un kill-switch o una demozione',
  );
  assert.deepEqual(liveRegistryTransitionSections(registryAfter, registryAfter, WITH_TI), []);
  assert.throws(
    () => liveRegistryTransitionSections(
      { schema: 1, sections: {} },
      { schema: 1, sections: { 'canton-xx': { status: 'live' } } },
      WITH_TI,
    ),
    /non attiva nel core/,
  );
  // `--name-status` preserves deletion state: a removed body triggers a full
  // refresh of the surviving registry, but the removed id is never sent to
  // renderArticlePages (which would otherwise abort before archive/landing).
  assert.deepEqual(
    r2PublishPlan(['D\tcontent/blog-body-canton-ti/it/removed.ts'], WITH_TI),
    [{ section: 'canton-ti', ids: [], bootstrap: true }],
  );
  // A rename is also structural, and the destination is still recognised.
  assert.deepEqual(
    r2PublishPlan(['R100\tcontent/blog-body-canton-ti/it/old.ts\tcontent/blog-body-canton-ti/it/new.ts'], WITH_TI),
    [{ section: 'canton-ti', ids: [], bootstrap: true }],
  );
  // Shared publisher/planner code is a fan-out input: with a canton active it
  // must not produce matrix=[] and leave every live section stale.
  for (const rel of [
    'generator/scripts/lib/canton-hubs/paths.mjs',
    'generator/scripts/lib/corpus-paths.mjs',
    'scripts/ci/fast-publish-section.mjs',
    'scripts/lib/article-render-pipeline.mjs',
    'scripts/lib/cf-analytics.mjs',
    'scripts/lib/canton-hub-data.mjs',
    'scripts/lib/cf-purge-variants.mjs',
    'scripts/lib/delete-cdn-file.sh',
    'scripts/lib/section-registry.mjs',
    'scripts/lib/section-page-manifest.mjs',
    'scripts/publish-section-pages.mjs',
    'scripts/lib/assert-hub-locale-slug.mjs',
    'scripts/publish-section-edge.mjs',
    'scripts/lib/engine-corpus-view.mjs',
    'scripts/lib/upload-cdn-file.sh',
    'scripts/lib/npm-ci-retry.sh',
    'scripts/lib/parse-positive-num.mjs',
    'scripts/ci/retry-cmd.sh',
    'generator/scripts/load-rc-env.mjs',
    'scripts/offload-generated-images-cdn.mjs',
    'scripts/cf-purge-cache.mjs',
    'engine/cantonSectionPages.ts',
    'host/siteShellBootstrap.ts',
  ]) {
    assert.deepEqual(r2PublishPlan([rel], WITH_TI), [{ section: 'canton-ti', ids: [], bootstrap: true }], rel);
  }
  assert.deepEqual(r2PublishPlan(['content/cantons/canton-gr/registry.ts', 'content/blog-meta-canton-tipo-it.ts'], WITH_TI), []);
});

test('piano API push: aggiorna tutte le superfici cantonali live senza ampliare gli articoli', () => {
  const otherCanton = { ...TI, section: 'canton-gr' };
  const core = [...HISTORICAL_CORE_LIST, TI, otherCanton];
  assert.deepEqual(
    r2ApiPushPlan([], [
      { section: 'canton-ti', ids: [], bootstrap: true },
      { section: 'canton-gr', ids: [], bootstrap: true },
    ], core),
    [
      { section: 'canton-ti', ids: [], bootstrap: false },
      { section: 'canton-gr', ids: [], bootstrap: false },
    ],
    'una push API solo del generatore rinfresca landing/archive/hub/RSS per ogni sezione live senza il bootstrap degli articoli',
  );
  assert.deepEqual(
    r2ApiPushPlan(
      [{ section: 'canton-ti', ids: ['a'], bootstrap: false }],
      [
        { section: 'canton-ti', ids: [], bootstrap: true },
        { section: 'canton-gr', ids: [], bootstrap: false, removeStaleCantonRssFeeds: true },
      ],
      core,
    ),
    [
      { section: 'canton-ti', ids: ['a'], bootstrap: false },
      { section: 'canton-gr', ids: [], bootstrap: false, removeStaleCantonRssFeeds: true },
    ],
    'conserva il diff degli articoli e aggiunge il cleanup edge delle sezioni non-live',
  );
});

test('fast-publish verso gli shard ignora i corpi cantonali, quello R2 ignora le storiche', () => {
  assert.equal(bodyRegex(WITH_TI, { served: 'shard' }), '^content/(blog-body|blog-body-ch)/[a-z]{2}/.+\\.ts$');
  assert.equal(bodyRegex(WITH_TI, { served: 'r2' }), '^content/(blog-body-canton-ti)/[a-z]{2}/.+\\.ts$');
  assert.equal(bodyRegex(HISTORICAL_CORE_LIST, { served: 'r2' }), '^$', 'nessuna sezione R2 attiva: non combacia con niente');
  assert.ok(!new RegExp(bodyRegex(HISTORICAL_CORE_LIST, { served: 'r2' })).test('content/blog-body/it/x.ts'));
  assert.throws(() => bodyRegex(WITH_TI, { served: 'pages' }), /sconosciuto/);
  assert.match(read('.github/workflows/fast-publish-article.yml'), /fast-publish-section\.mjs body-regex shard\)/);
});

test('fast-publish-section.yml: concurrency per sezione, piano dal core, credenziali obbligatorie', () => {
  const wf = read('.github/workflows/fast-publish-section.yml');
  assert.match(wf, /workflow_run:\n\s+workflows: \['Publish article data API'\]\n\s+types: \[completed\]\n\s+branches: \[main\]/);
  assert.match(wf, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(wf, /github\.event\.workflow_run\.event == 'push'[\s\S]*github\.event\.workflow_run\.event == 'schedule'[\s\S]*github\.event\.workflow_run\.event == 'workflow_dispatch'/);
  assert.match(wf, /COVER_DRAIN_COMMIT_MESSAGE: \$\{\{ github\.event\.head_commit\.message \}\}/);
  assert.match(wf, /WORKFLOW_RUN_COVER_DRAIN_COMMIT_MESSAGE: \$\{\{ github\.event\.workflow_run\.head_commit\.message \}\}/);
  assert.match(wf, /if \[ "\$EVENT_NAME" = 'push' \] \|\| \{ \[ "\$EVENT_NAME" = 'workflow_run' \] && \[ "\$WORKFLOW_RUN_EVENT" = 'push' \]; \}; then/);
  assert.equal(
    (wf.match(/ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| inputs\.source_commit \|\| github\.sha \}\}/g) ?? []).length,
    2,
    'resolve e publish devono checkoutare la source_commit del replay',
  );
  assert.match(wf, /id: replay_freshness[\s\S]*gh api "repos\/\$REPO\/git\/ref\/heads\/main"/);
  assert.match(wf, /if: steps\.replay_freshness\.outputs\.fresh == 'true'/);
  assert.match(wf, /Dispatch bounded replay with current corpus checkout/);
  const dispatchPlanStart = wf.indexOf('if [ "${{ github.event_name }}" = "workflow_dispatch" ]');
  const dispatchPlanEnd = wf.indexOf('any=false', dispatchPlanStart);
  const dispatchPlan = wf.slice(dispatchPlanStart, dispatchPlanEnd);
  assert.match(dispatchPlan, /FAST_PUBLISH_DISABLED/);
  assert.match(dispatchPlan, /FAST_PUBLISH_ARMED/);
  assert.equal((wf.match(/-f dry_run="\$DRY"/g) ?? []).length, 2, 'entrambi i redispatch propagano il dry-run calcolato');
  assert.doesNotMatch(wf, /-f dry_run=false/);
  assert.equal((wf.match(/gh workflow run fast-publish-section\.yml --repo "\$REPO" --ref main/g) ?? []).length, 2);
  assert.match(wf, /-f source_commit="\$CURRENT_MAIN"/);
  assert.match(wf, /-f source_commit="\$current_main"/);
  assert.match(wf, /source_commit richiede una SHA completa/);
  assert.match(wf, /source_main_commit e' obbligatorio e richiede una SHA completa quando source_commit e' valorizzato/);
  assert.match(wf, /if \[ "\$SOURCE_COMMIT_INPUT" != "\$SOURCE_MAIN_COMMIT_INPUT" \]/);
  assert.match(wf, /if \[ "\$SOURCE_COMMIT" != "\$SOURCE_MAIN_COMMIT" \]/);
  assert.equal(
    (wf.match(/source_commit deve coincidere con source_main_commit nel replay bounded/g) ?? []).length,
    2,
    'resolve e publish devono rifiutare un checkout diverso dalla HEAD certificata',
  );
  assert.match(wf, /checkout non coincide con source_commit/);
  assert.match(wf, /inputs\.source_commit/);
  assert.match(wf, /source_main_commit:/);
  assert.match(wf, /EXPECTED_MAIN_HEAD: \$\{\{ github\.event\.workflow_run\.head_sha \|\| inputs\.source_main_commit \|\| github\.event\.after \|\| github\.sha \}\}/);
  assert.match(wf, /-f source_main_commit="\$CURRENT_MAIN"/);
  assert.match(wf, /-f source_main_commit="\$current_main"/);
  assert.match(wf, /replay_before="\$\{ORIGINAL_PUSH_BEFORE:-\$STALE_HEAD\}"/);
  assert.match(wf, /replay_after="\$\{ORIGINAL_PUSH_AFTER:-\$STALE_HEAD\}"/);
  assert.match(wf, /-f push_before="\$replay_before"/);
  assert.match(wf, /-f push_after="\$replay_after"/);
  assert.equal((wf.match(/-f api_release_commit="\$api_release_commit"/g) ?? []).length, 2);
  assert.match(wf, /resolveStaleReplayApiReleaseCommit/);
  assert.match(wf, /git rev-parse --is-shallow-repository/);
  assert.match(wf, /remove_stale_canton_rss_feeds/);
  assert.match(wf, /API_RELEASE_COMMIT: \$\{\{ inputs\.api_release_commit \}\}/);
  assert.match(wf, /GITHUB_PAT_NANAKO assente/);
  assert.match(wf, /replay workflow_run redispatchato prima degli upload/);
  assert.match(wf, /id: push_range[\s\S]*gh api --paginate --slurp "repos\/\$REPO\/commits\/\$WORKFLOW_RUN_HEAD_SHA\/events"/);
  assert.match(wf, /payload\.ref == "refs\/heads\/main"[\s\S]*payload\.head == \$head[\s\S]*payload\.before/);
  assert.match(wf, /push_before: \$\{\{ steps\.push_range\.outputs\.before \}\}/);
  assert.doesNotMatch(wf, /diff_args=\(\)[\s\S]*sections\/registry\.json/);
  assert.match(wf, /PUSH_BEFORE="\$before" node scripts\/ci\/fast-publish-section\.mjs r2-plan/);
  assert.match(wf, /r2-reconcile-plan \\\n\s+"\$WORKFLOW_RUN_HEAD_SHA"/);
  assert.match(wf, /edge_matrix="\$\(node scripts\/ci\/fast-publish-section\.mjs r2-reconcile-plan/);
  assert.match(wf, /if \[ "\$WORKFLOW_RUN_EVENT" = 'push' \]/);
  assert.match(wf, /r2-api-push-plan/);
  assert.match(wf, /landing\/archive\/hub\/RSS/);
  assert.match(wf, /Il replay della push API deve riprodurre il piano dei\s+contenuti/);
  assert.match(read('scripts/publish-section-pages.mjs'), /await assertMainFreshImpl\(\);\n  for \(const \{ local, key \} of cdnUploads\)/);
  assert.match(read('scripts/publish-section-pages.mjs'), /EXPECTED_MAIN_HEAD non contiene una SHA completa/);
  const publishCheckout = wf.slice(wf.indexOf('      - name: Checkout\n', wf.indexOf('\n  publish:\n')));
  assert.match(publishCheckout, /fetch-depth: 0/);
  assert.match(wf, /PUSH_BEFORE: \$\{\{ needs\.resolve\.outputs\.push_before \}\}/);
  assert.match(wf, /PUSH_AFTER: \$\{\{ needs\.resolve\.outputs\.push_after \}\}/);
  assert.match(wf, /push_before:/);
  assert.match(wf, /push_after:/);
  assert.doesNotMatch(wf, /git rev-parse HEAD\^/);
  assert.match(wf, /group: fast-publish-\$\{\{ matrix\.target\.section \}\}\n\s+cancel-in-progress: false/);
  assert.match(wf, /fail-fast: false/);
  for (const p of ["'content/cantons/**'", "'content/blog-body-canton-*/**'", "'content/blog-meta-canton-*'", "'sections/registry.json'"]) {
    assert.ok(wf.includes(`      - ${p}\n`), p);
  }
  assert.match(wf, /node scripts\/ci\/fast-publish-section\.mjs r2-plan/);
  assert.match(wf, /PUSH_BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(wf, /git diff --name-status "\$before" HEAD/);
  assert.match(wf, /Fetch fallback corpus revision for manifest migration/);
  assert.match(wf, /--previous-revision/);
  assert.match(wf, /bootstrap: \(\.bootstrap \/\/ false\)/);
  for (const p of [
    'generator/scripts/lib/corpus-paths.mjs',
    'generator/scripts/lib/control-char-write-report.mjs',
    'scripts/publish-section-pages.mjs',
    'scripts/publish-section-edge.mjs',
    'scripts/lib/section-bootstrap-lock.mjs',
    'scripts/ci/section-bootstrap-lock.mjs',
    'scripts/ci/fast-publish-section.mjs',
    'scripts/ci/retry-cmd.sh',
    'scripts/cf-purge-cache.mjs',
    'scripts/offload-generated-images-cdn.mjs',
    'scripts/lib/article-render-pipeline.mjs',
    'scripts/lib/cf-analytics.mjs',
    'scripts/lib/canton-hub-data.mjs',
    'scripts/lib/cf-purge-variants.mjs',
    'scripts/lib/delete-cdn-file.sh',
    'scripts/lib/cdn-asset-existence.mjs',
    'scripts/lib/corpus-floors.mjs',
    'scripts/lib/corpus-sections.mjs',
    'scripts/lib/engine-corpus-view.mjs',
    'scripts/lib/npm-ci-retry.sh',
    'scripts/lib/parse-positive-num.mjs',
    'scripts/lib/sanitize-control-chars.mjs',
    'scripts/lib/section-registry.mjs',
    'scripts/lib/assert-hub-locale-slug.mjs',
    'scripts/lib/section-page-manifest.mjs',
    'scripts/lib/upload-cdn-file.sh',
    'generator/scripts/load-rc-env.mjs',
  ]) assert.ok(wf.includes(`      - '${p}'\n`), p);
  assert.ok(wf.includes("      - 'engine/**'\n"));
  assert.ok(wf.includes("      - 'host/**'\n"));
  assert.ok(read('.github/workflows/fast-publish-article.yml').includes("      - 'scripts/lib/article-render-pipeline.mjs'\n"));
  assert.ok(read('.github/workflows/fast-publish-article.yml').includes("      - 'scripts/offload-generated-images-cdn.mjs'\n"));
  for (const p of [
    'generator/scripts/lib/corpus-paths.mjs',
    'generator/scripts/load-rc-env.mjs',
    'scripts/lib/cf-analytics.mjs',
    'scripts/lib/cf-purge-variants.mjs',
    'scripts/lib/npm-ci-retry.sh',
    'scripts/lib/parse-positive-num.mjs',
  ]) assert.ok(read('.github/workflows/fast-publish-article.yml').includes(`      - '${p}'\n`), p);
  assert.ok(read('.github/workflows/fast-publish-article.yml').includes("      - 'engine/**'\n"));
  assert.ok(read('.github/workflows/fast-publish-article.yml').includes("      - 'host/**'\n"));
  assert.match(wf, /if: needs\.resolve\.outputs\.any == 'true'/);
  assert.match(wf, /bash scripts\/ci\/retry-cmd\.sh npx -y tsx@4\.23\.15 scripts\/publish-section-pages\.mjs "\$\{args\[@\]\}"/);
  assert.match(wf, /\[ "\$DRY" = "true" \]; then\n\s+args\+=\(--dry-run\)\n\s+else\n\s+args\+=\(--publish\)/);
  // upload-cdn-file.sh esce 0 senza credenziali: l'assenza deve fermare il job.
  assert.match(wf, /for v in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_S3_ENDPOINT R2_BUCKET CF_API_TOKEN; do/);
  assert.match(wf, /timeout-minutes: 45/);
  assert.match(wf, /Acquire bootstrap R2 gate/);
  assert.match(wf, /section-bootstrap-lock\.mjs acquire --section "\$SECTION"/);
  assert.match(wf, /Release bootstrap R2 gate/);
  assert.match(wf, /if: always\(\).*matrix\.target\.bootstrap == true/);
  assert.match(read('scripts/publish-section-edge.mjs'), /waitForBootstrapLocks\(release\.live, io/);
});

// ── Riconciliazione ──────────────────────────────────────────────────────────

const CATALOG_TI = {
  id: 'canton-ti',
  paths: { it: '/articoli-ticino/', en: '/en/ticino-articles/', de: '/de/tessin-artikel/', fr: '/fr/articles-tessin/' },
  sitemap: '/sitemap-articles-canton-ti.xml',
};
const SLUGS_TI = {
  a: { it: 'a-it', en: 'a-en', de: 'a-de', fr: 'a-fr' },
  b: { it: 'b-it', en: 'b-en', de: 'b-de' },
};

const sitemapUrl = (pathname) => `https://frontaliereticino.ch${pathname}`;
const archiveSlugs = { it: 'tutti', en: 'all', de: 'alle', fr: 'tous' };
const sectionSitemapPaths = [
  ...Object.values(CATALOG_TI.paths),
  ...Object.values(TI.topicHubs).flatMap((topic) => Object.entries(topic).map(([locale, slug]) => `${CATALOG_TI.paths[locale]}${slug}/`)),
  ...[1, 2].flatMap((page) => Object.entries(CATALOG_TI.paths).map(([locale, prefix]) => `${prefix}${archiveSlugs[locale]}/${page === 1 ? '' : `page-${page}/`}`)),
];
const articleSitemapEntries = [
  ['/articoli-ticino/a-it/', ['/en/ticino-articles/a-en/', '/de/tessin-artikel/a-de/', '/fr/articles-tessin/a-fr/']],
  ['/articoli-ticino/b-it/', ['/en/ticino-articles/b-en/', '/de/tessin-artikel/b-de/']],
];
const SITEMAP_TI = `<urlset>${sectionSitemapPaths.map((p) => `<url><loc>${sitemapUrl(p)}</loc></url>`).join('')}${articleSitemapEntries
  .map(([loc, alternates]) => `<url><loc>${sitemapUrl(loc)}</loc>${alternates.map((p) => `<xhtml:link href="${sitemapUrl(p)}"/>`).join('')}</url>`)
  .join('')}</urlset>`;

test('reconcile: pagine attese = tutti gli URL annunciati da loc e alternate della sitemap', () => {
  const pages = expectedSectionPages(CATALOG_TI, SLUGS_TI, SITEMAP_TI);
  // landing + 6 hub + due page-N dell'archivio per 4 locali, 4 + 3 pagine articolo.
  assert.equal(pages.filter((p) => p.kind === 'section').length, (1 + 6 + 2) * 4);
  assert.deepEqual(pages.filter((p) => p.kind === 'article').map((p) => p.path).sort(), [
    '/articoli-ticino/a-it/', '/en/ticino-articles/a-en/', '/de/tessin-artikel/a-de/', '/fr/articles-tessin/a-fr/',
    '/articoli-ticino/b-it/', '/en/ticino-articles/b-en/', '/de/tessin-artikel/b-de/',
  ].sort());
  assert.ok(pages.some((p) => p.path === '/de/tessin-artikel/treibstoff/'));
  assert.ok(pages.some((p) => p.path === '/fr/articles-tessin/tous/page-2/'), 'le page-N dell\'archivio vengono dalla sitemap');
  assert.equal(cdnUrlFor('/en/ticino-articles/a-en/'), 'https://cdn.frontaliereticino.ch/edge/sections/en/ticino-articles/a-en/index.html');
  assert.throws(() => expectedSectionPages({ id: 'canton-zz', paths: {} }, {}, SITEMAP_TI), /sconosciuta/);
  const incoherent = SITEMAP_TI.replace('/articoli-ticino/a-it/', '/articoli-ticino/retired-not-in-slugs/');
  assert.throws(() => expectedSectionPages(CATALOG_TI, SLUGS_TI, incoherent), /non compare in slugs\.json\.cantons/);
});

test('reconcile: non interpola slug hub vuoti o ereditati', () => {
  const originalTopicHubs = TI.topicHubs;
  try {
    const blankHubSitemap = SITEMAP_TI.replace('/articoli-ticino/carburanti/', '/articoli-ticino//');
    TI.topicHubs = {
      ...originalTopicHubs,
      carburanti: { ...originalTopicHubs.carburanti, it: '' },
    };
    assert.throws(
      () => expectedSectionPages(CATALOG_TI, SLUGS_TI, blankHubSitemap),
      /slug hub mancante o vuoto.*\/it$/u,
    );

    const inherited = Object.create({ it: 'ereditato' });
    Object.assign(inherited, originalTopicHubs.carburanti);
    delete inherited.it;
    TI.topicHubs = { ...originalTopicHubs, carburanti: inherited };
    const inheritedHubSitemap = SITEMAP_TI.replace('/articoli-ticino/carburanti/', '/articoli-ticino/ereditato/');
    assert.throws(
      () => expectedSectionPages(CATALOG_TI, SLUGS_TI, inheritedHubSitemap),
      /slug hub mancante o vuoto.*\/it$/u,
    );
  } finally {
    TI.topicHubs = originalTopicHubs;
  }
});

test('reconcile: HEAD 405/501 ricade su GET, mantenendo 404 = missing', async () => {
  const presentMethods = [];
  assert.equal(
    await headState('https://cdn.test/page', async (_url, init) => {
      presentMethods.push(init.method);
      return { status: init.method === 'HEAD' ? 405 : 200 };
    }),
    'present',
  );
  assert.deepEqual(presentMethods, ['HEAD', 'GET']);

  const missingMethods = [];
  assert.equal(
    await headState('https://cdn.test/page', async (_url, init) => {
      missingMethods.push(init.method);
      return { status: init.method === 'HEAD' ? 501 : 404 };
    }),
    'missing',
  );
  assert.deepEqual(missingMethods, ['HEAD', 'GET']);
});

test('reconcile: cap per sezione, i piu\' recenti prima; il dubbio non si ripubblica', () => {
  const pages = [
    { kind: 'article', id: 'vecchio', path: '/p1/', state: 'missing' },
    { kind: 'article', id: 'nuovo', path: '/p2/', state: 'missing' },
    { kind: 'article', id: 'nuovo', path: '/p3/', state: 'missing' },
    { kind: 'article', id: 'medio', path: '/p4/', state: 'missing' },
    { kind: 'article', id: 'incerto', path: '/p5/', state: 'unknown' },
    { kind: 'article', id: 'ok', path: '/p6/', state: 'present' },
    { kind: 'section', path: '/articoli-ticino/', state: 'present' },
  ];
  const dates = new Map([['vecchio', '2026-01-01'], ['medio', '2026-05-01'], ['nuovo', '2026-10-01']]);
  const plan = planSectionBackfill('canton-ti', pages, dates, 2);
  assert.deepEqual(plan.missingIds, ['nuovo', 'medio', 'vecchio']);
  assert.deepEqual(plan.selected, ['nuovo', 'medio']);
  assert.deepEqual(plan.leftover, ['vecchio']);
  assert.deepEqual(plan.unknown, ['/p5/']);
  assert.equal(plan.dispatch, true);
  assert.throws(() => planSectionBackfill('canton-ti', pages, dates, 0), /cap non valido/);
  // Manca solo una pagina di sezione: un giro di rinfresco senza id.
  const refresh = planSectionBackfill('canton-ti', [{ kind: 'section', path: '/articoli-ticino/fisco/', state: 'missing' }], dates, 3);
  assert.deepEqual([refresh.dispatch, refresh.selected, refresh.sectionMissing], [true, [], ['/articoli-ticino/fisco/']]);
  assert.equal(planSectionBackfill('canton-ti', [{ kind: 'section', path: '/x/', state: 'unknown' }], dates, 3).dispatch, false);
  const orphan = planSectionBackfill('canton-ti', [], dates, 3, [{ id: 'gone', path: '/articoli-ticino/gone/', state: 'present' }]);
  assert.deepEqual([orphan.dispatch, orphan.orphaned, orphan.orphanedIds], [true, ['/articoli-ticino/gone/'], ['gone']]);
  assert.equal(orphan.selected.length, 0, 'una pagina ritirata non va rimessa in coda come articolo corrente');
});

test('reconcile: il manifest individua una pagina articolo ritirata o con slug vecchio', () => {
  const manifest = pageManifestFromPages({
    section: 'canton-ti',
    commit: 'old-commit',
    pages: [
      { ...pageEntry('canton-ti', 'articoli-ticino/gone-it/index.html', 'article'), id: 'gone' },
      { ...pageEntry('canton-ti', 'articoli-ticino/old-it/index.html', 'article'), id: 'kept' },
      { ...pageEntry('canton-ti', 'en/ticino-articles/kept-en/index.html', 'article'), id: 'kept' },
    ],
  });
  assert.deepEqual(
    orphanedArticleCandidates(CATALOG_TI, manifest, { kept: { it: 'new-it', en: 'kept-en' } }).map((page) => [page.id, page.path]),
    [['gone', '/articoli-ticino/gone-it/'], ['kept', '/articoli-ticino/old-it/']],
  );
  assert.deepEqual(
    orphanedArticleCandidates(CATALOG_TI, manifest, { gone: { it: 'gone-it' }, kept: { it: 'old-it', en: 'kept-en' } }, ['kept'])
      .map((page) => page.id),
    ['gone'],
    'la decisione di ritiro usa il registro attivo, non una mappa slug eventualmente residua',
  );
});

function fakeFetch({ commit = 'abc1234', sectionsCommit = commit, edgeCommit = commit, live = true, missing = new Set(), broken = new Set(), pageManifest = null }) {
  const docs = {
    'manifest.json': { commit },
    'sections.json': { commit: sectionsCommit, sections: [CATALOG_TI, { id: 'canton-gr', paths: {} }] },
    'slugs.json': { commit, cantons: { 'canton-ti': SLUGS_TI } },
    'canton-articles.json': [{ id: 'a', date: '2026-10-01', section: 'canton-ti' }, { id: 'b', date: '2026-10-02', section: 'canton-ti' }],
  };
  const edgeRegistry = { schema: 1, commit: edgeCommit, sections: { 'canton-ti': { status: live ? 'live' : 'draft' } } };
  const calls = [];
  const impl = async (url, init = {}) => {
    const clean = url.replace(/\?.*$/, '');
    calls.push(`${init.method ?? 'GET'} ${clean}`);
    if (init.method === 'HEAD') {
      const p = clean.replace('https://cdn.frontaliereticino.ch/edge/sections', '').replace(/index\.html$/, '');
      if (broken.has(p)) return { status: 503, ok: false };
      return { status: missing.has(p) ? 404 : 200, ok: !missing.has(p) };
    }
    if (clean.endsWith('/edge/sections/registry.json')) return { ok: true, status: 200, json: async () => edgeRegistry };
    if (clean.endsWith('/edge/sections/_page-manifests/canton-ti.json')) {
      return pageManifest
        ? { ok: true, status: 200, json: async () => pageManifest }
        : { ok: false, status: 404 };
    }
    if (clean.endsWith('/sitemap-articles-canton-ti.xml')) return { ok: true, status: 200, text: async () => SITEMAP_TI };
    const name = clean.split('/').pop();
    return { ok: true, status: 200, json: async () => docs[name], text: async () => '' };
  };
  return { impl, calls };
}

test('reconcile: solo le sezioni live, solo i 404, e mai su una superficie a meta\' deploy', async () => {
  const draft = fakeFetch({ live: false });
  const none = await reconcile({ apiBase: 'https://api.test', fetchImpl: draft.impl });
  assert.deepEqual([none.skipped, none.sections], [null, []]);
  assert.ok(!draft.calls.some((c) => c.startsWith('HEAD')), 'nessuna sezione live: nessuna sonda');

  const torn = await reconcile({ apiBase: 'https://api.test', fetchImpl: fakeFetch({ sectionsCommit: 'def5678' }).impl });
  assert.match(torn.skipped, /meta' deploy/);
  assert.deepEqual(torn.sections, []);

  const gap = fakeFetch({ missing: new Set(['/en/ticino-articles/a-en/', '/articoli-ticino/b-it/']), broken: new Set(['/de/tessin-artikel/a-de/']) });
  const report = await reconcile({ apiBase: 'https://api.test', cap: 1, fetchImpl: gap.impl });
  assert.equal(report.sections.length, 1);
  const [ti] = report.sections;
  assert.deepEqual(ti.missingIds, ['b', 'a'], 'b e\' piu\' recente');
  assert.deepEqual([ti.selected, ti.leftover], [['b'], ['a']]);
  assert.deepEqual(ti.unknown, ['/de/tessin-artikel/a-de/']);
  assert.deepEqual(ti.sectionMissing, []);
});

test('reconcile: una pagina articolo presente nel manifest ma ritirata entra nel cleanup', async () => {
  const pageManifest = pageManifestFromPages({
    section: 'canton-ti',
    commit: 'old-commit',
    pages: [{ ...pageEntry('canton-ti', 'articoli-ticino/ritirato/index.html', 'article'), id: 'ritirato' }],
  });
  const report = await reconcile({ apiBase: 'https://api.test', fetchImpl: fakeFetch({ pageManifest }).impl });
  const [ti] = report.sections;
  assert.equal(ti.pageManifest, 'ok');
  assert.deepEqual(ti.orphaned, ['/articoli-ticino/ritirato/']);
  assert.deepEqual(ti.orphanedIds, ['ritirato']);
  assert.equal(ti.dispatch, true);
});

test('reconcile-section-pages.yml: dispatch per sezione, niente catena stretta', () => {
  const wf = read('.github/workflows/reconcile-section-pages.yml');
  const articleWf = read('.github/workflows/reconcile-article-shards.yml');
  assert.match(wf, /workflows: \[fast-publish-section\]/);
  assert.match(wf, /node scripts\/reconcile-section-pages\.mjs/);
  assert.match(wf, /gh workflow run fast-publish-section\.yml[^\n]*\\\n\s+-f section="\$section" -f article_ids="\$ids" -f bootstrap=false -f dry_run=false/);
  assert.match(wf, /github\.event\.workflow_run\.event \}\}" = "workflow_dispatch"/);
  assert.match(wf, /actions: write/);
  for (const reconcileWorkflow of [wf, articleWf]) {
    assert.match(reconcileWorkflow, /id: arm/);
    assert.match(reconcileWorkflow, /FAST_PUBLISH_DISABLED/);
    assert.match(reconcileWorkflow, /FAST_PUBLISH_ARMED/);
    assert.match(reconcileWorkflow, /steps\.arm\.outputs\.allow == 'true'/);
  }
  // Il nome del workflow osservato e' quello vero.
  assert.match(read('.github/workflows/fast-publish-section.yml'), /^name: fast-publish-section$/m);
});
