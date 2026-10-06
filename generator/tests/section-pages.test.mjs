/**
 * La pubblicazione R2 delle pagine delle sezioni cantonali (piano «sezioni
 * articoli per cantone», P7b parte B). Run with `node --test`.
 *
 * Il render vero passa dall'engine (TypeScript, sotto tsx) e non gira in
 * questo gate: qui si provano le parti che decidono COSA viene pubblicato e
 * DOVE — chiavi R2, difetti che fermano una pagina, hub senza dati, sezioni
 * toccate da un commit, riconciliazione — e il cablaggio dei workflow.
 */
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
  assertPublishableSection,
  createRenderRoot,
  ensureRouteOwnerMeta,
  inUploadOrder,
  pageDefects,
  pageEntry,
  parseArgs,
  publishedStatus,
  rendererPageEntry,
} from '../../scripts/publish-section-pages.mjs';
import { cantonHubCoverage, cantonHubDataFile, cantonHubTopics, readCantonHubData } from '../../scripts/lib/canton-hub-data.mjs';
import { declaredRegistryErrors, SECTION_REGISTRY_FILE } from '../../scripts/lib/section-registry.mjs';
import { bodyRegex, r2PublishPlan } from '../../scripts/ci/fast-publish-section.mjs';
import { cdnUrlFor, expectedSectionPages, planSectionBackfill, reconcile } from '../../scripts/reconcile-section-pages.mjs';
import { cantonSectionPaths } from '../scripts/lib/canton-section-profile.mjs';
import { corpusPath } from '../scripts/lib/corpus-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TI = ARTICLE_SECTION_CORE_ALL['canton-ti'];
const WITH_TI = [...ARTICLE_SECTION_CORE_LIST, TI];
const ACTIVE_WITH_TI = { ...ARTICLE_SECTION_CORE, 'canton-ti': TI };
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

test('publisher: argomenti', () => {
  assert.throws(() => parseArgs(['--section', 'svizzera', '--out', 'o', '--summary', 's']), /shard Pages/);
  assert.throws(() => parseArgs(['--out', 'o', '--summary', 's']), /manca --section/);
  assert.throws(() => parseArgs(['--section']), /richiede un valore/);
  assert.throws(() => parseArgs(['--section', 'canton-ti', '--ids', 'x', '--out', 'o', '--summary', 's']), /array JSON/);
  assert.throws(() => parseArgs(['--section', 'canton-ti', '--boh']), /argomento sconosciuto/);
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
    globalThis.fetch = async () => ({ status: 200, text: async () => '{"sections":{"canton-ti":{"status":"stale"}}}' });
    assert.equal(await publishedStatus('canton-ti'), null);
    globalThis.fetch = async () => ({ status: 200, text: async () => '{"sections":{"canton-ti":{"status":"draft"}}}' });
    assert.equal(await publishedStatus('canton-ti'), 'draft');
    globalThis.fetch = async () => ({ status: 200, text: async () => '{"sections":{"canton-ti":{"status":"live"}}}' });
    assert.equal(await publishedStatus('canton-ti'), 'live');
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.match(read('scripts/publish-section-pages.mjs'), /beforeStatus === null/);
  assert.match(read('scripts/publish-section-pages.mjs'), /if \(status === null\)/);
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
const locale = (localeCode, topic, intro = 'Testo evergreen.') => ({
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
  assert.equal(readCantonHubData(root, 'canton-ti', 'fisco').de.intro, 'Testo evergreen.');
  assert.equal(readCantonHubData(root, 'canton-ti', 'eventi').fr.intro, 'Testo evergreen.');
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

test('registro: una sezione live deve avere i dati di tutti e sei gli hub (mai noindex, resta draft)', () => {
  const doc = JSON.parse(read(SECTION_REGISTRY_FILE));
  doc.sections['canton-ti'].status = 'live';
  const withHubs = (missing) => declaredRegistryErrors(doc, { active: ACTIVE_WITH_TI, missingHubsOf: () => missing });
  assert.deepEqual(withHubs([]), []);
  assert.match(withHubs(['eventi', 'servizi']).join('\n'), /canton-ti: dichiarata live senza i dati degli hub eventi, servizi/);
  // Dati malformati: errore del registro, non un'eccezione che nasconde gli altri.
  const broken = declaredRegistryErrors(doc, { active: ACTIVE_WITH_TI, missingHubsOf: () => { throw new Error('intro "de" vuota'); } });
  assert.match(broken.join('\n'), /canton-ti: dati hub non validi \(intro "de" vuota\)/);
  // Draft: nessun vincolo sugli hub.
  doc.sections['canton-ti'].status = 'draft';
  assert.deepEqual(declaredRegistryErrors(doc, { missingHubsOf: () => ['eventi'] }), []);
  // Il publisher ripete il vincolo sul commit che sta pubblicando.
  assert.match(read('scripts/publish-section-pages.mjs'), /if \(declared === 'live'\) defects\.push\(`sezione live con \$\{note\}`\)/);
  assert.match(read('scripts/build-api.mjs'), /loadDeclaredRegistry\(ROOT\)/);
});

// ── Cosa fa scattare un publish ──────────────────────────────────────────────

test('piano R2: sezioni cantonali toccate da un commit, con gli id dei corpi cambiati', () => {
  assert.deepEqual(r2PublishPlan(['content/blog-body-canton-ti/it/a.ts'], ARTICLE_SECTION_CORE_LIST), [], 'sezione non attiva: niente');
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
  assert.deepEqual(r2PublishPlan(['content/cantons/canton-gr/registry.ts', 'content/blog-meta-canton-tipo-it.ts'], WITH_TI), []);
});

test('fast-publish verso gli shard ignora i corpi cantonali, quello R2 ignora le storiche', () => {
  assert.equal(bodyRegex(WITH_TI, { served: 'shard' }), '^content/(blog-body|blog-body-ch)/[a-z]{2}/.+\\.ts$');
  assert.equal(bodyRegex(WITH_TI, { served: 'r2' }), '^content/(blog-body-canton-ti)/[a-z]{2}/.+\\.ts$');
  assert.equal(bodyRegex(ARTICLE_SECTION_CORE_LIST, { served: 'r2' }), '^$', 'nessuna sezione R2 attiva: non combacia con niente');
  assert.ok(!new RegExp(bodyRegex(ARTICLE_SECTION_CORE_LIST, { served: 'r2' })).test('content/blog-body/it/x.ts'));
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
  assert.match(wf, /git diff --name-status HEAD~1 HEAD/);
  assert.match(wf, /bootstrap: \(\.bootstrap \/\/ false\)/);
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
const sectionSitemapPaths = [
  '/articoli-ticino/', '/en/ticino-articles/', '/de/tessin-artikel/', '/fr/articles-tessin/',
  ...['carburanti', 'fisco', 'mobilita', 'eventi', 'pensioni', 'servizi'].flatMap((topic) => [
    `/articoli-ticino/${topic}/`, `/en/ticino-articles/${topic}/`, `/de/tessin-artikel/${topic}/`, `/fr/articles-tessin/${topic}/`,
  ]),
  ...[1, 2].flatMap((page) => [
    `/articoli-ticino/tutti/${page === 1 ? '' : `page-${page}/`}`,
    `/en/ticino-articles/tutti/${page === 1 ? '' : `page-${page}/`}`,
    `/de/tessin-artikel/tutti/${page === 1 ? '' : `page-${page}/`}`,
    `/fr/articles-tessin/tutti/${page === 1 ? '' : `page-${page}/`}`,
  ]),
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
  assert.ok(pages.some((p) => p.path === '/de/tessin-artikel/carburanti/'));
  assert.ok(pages.some((p) => p.path === '/fr/articles-tessin/tutti/page-2/'), 'le page-N dell\'archivio vengono dalla sitemap');
  assert.equal(cdnUrlFor('/en/ticino-articles/a-en/'), 'https://cdn.frontaliereticino.ch/edge/sections/en/ticino-articles/a-en/index.html');
  assert.throws(() => expectedSectionPages({ id: 'canton-zz', paths: {} }, {}, SITEMAP_TI), /sconosciuta/);
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
});

function fakeFetch({ commit = 'abc1234', sectionsCommit = commit, edgeCommit = commit, live = true, missing = new Set(), broken = new Set() }) {
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

test('reconcile-section-pages.yml: dispatch per sezione, niente catena stretta', () => {
  const wf = read('.github/workflows/reconcile-section-pages.yml');
  assert.match(wf, /workflows: \[fast-publish-section\]/);
  assert.match(wf, /node scripts\/reconcile-section-pages\.mjs/);
  assert.match(wf, /gh workflow run fast-publish-section\.yml[^\n]*\\\n\s+-f section="\$section" -f article_ids="\$ids" -f bootstrap=false -f dry_run=false/);
  assert.match(wf, /github\.event\.workflow_run\.event \}\}" = "workflow_dispatch"/);
  assert.match(wf, /actions: write/);
  // Il nome del workflow osservato e' quello vero.
  assert.match(read('.github/workflows/fast-publish-section.yml'), /^name: fast-publish-section$/m);
});
