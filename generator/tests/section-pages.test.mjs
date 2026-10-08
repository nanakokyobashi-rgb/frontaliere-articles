/**
 * La pubblicazione R2 delle pagine delle sezioni cantonali (piano «sezioni
 * articoli per cantone», P7b parte B). Run with `node --test`.
 *
 * Il render vero passa dall'engine (TypeScript, sotto tsx) e non gira in
 * questo gate: qui si provano le parti che decidono COSA viene pubblicato e
 * DOVE — chiavi R2, difetti che fermano una pagina, hub senza dati, sezioni
 * toccate da un commit, riconciliazione — e il cablaggio dei workflow.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE, ARTICLE_SECTION_CORE_ALL, ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import { CORPUS_ROUTE_OWNER_META_TAG } from '../../engine/shared/corpusRouteOwner.mjs';
import {
  UPLOAD_ORDER,
  aggregatePageDefects,
  articleManifestPages,
  archiveReleasePages,
  articleReleasePages,
  articleReleaseSnapshot,
  assertPublishableSection,
  createRenderRoot,
  ensureRouteOwnerMeta,
  hubMissingIsFatal,
  inUploadOrder,
  main,
  missingRenderedArticleIds,
  pageDefects,
  pageEntry,
  obsoleteArticlePages,
  obsoleteArchivePages,
  obsoleteReleasePages,
  parseArgs,
  publish,
  publishedReleaseReady,
  publishedStatus,
  rendererPageEntry,
} from '../../scripts/publish-section-pages.mjs';
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
import { bodyRegex, r2PublishPlan } from '../../scripts/ci/fast-publish-section.mjs';
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
  assert.match(wf, /group: fast-publish-\$\{\{ matrix\.target\.section \}\}\n\s+cancel-in-progress: false/);
  assert.match(wf, /fail-fast: false/);
  for (const p of ["'content/cantons/**'", "'content/blog-body-canton-*/**'", "'content/blog-meta-canton-*'"]) {
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
