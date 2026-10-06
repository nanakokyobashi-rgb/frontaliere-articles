/**
 * Il registro delle sezioni cantonali e i documenti che ne derivano (piano
 * «sezioni articoli per cantone», P7). Run with `node --test`.
 *
 * Cosa si prova:
 *   1. `sections/registry.json` committato e' valido e, oggi, tutto `draft`;
 *   2. il validatore rifiuta ogni forma che il Worker scarterebbe (che
 *      altrimenti resterebbe sull'ultimo registro in memoria, in silenzio) e
 *      ogni disaccordo col core;
 *   3. il kill-switch di Remote Config spegne solo, e solo con il marker di
 *      caricamento verificato la copia per il Worker viene scritta;
 *   4. sitemap di sezione (landing, 6 hub indicizzabili, archivio, articoli) e
 *      indice (mai vuoto);
 *   5. la superficie API di famiglia in corpus-sections.mjs;
 *   6. il piano di pubblicazione R2 (ordine, cancellazione dell'indice, purge);
 *   7. il cablaggio in load-rc-env.mjs e publish-api.yml.
 *
 * Le regole speculari al Worker (`parseCorpusSectionRegistry`,
 * `corpusSectionCanonicalDir`, `CORPUS_REDIRECT_TARGET_RE` in
 * infra/cloudflare-worker/locale-router.js del sito) sono provate sui casi che
 * il Worker documenta: il Worker e' uno script autonomo e non si importa da qui.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  ARTICLE_SECTION_CORE,
  ARTICLE_SECTION_CORE_ALL,
  ARTICLE_SECTION_CORE_LIST,
} from '../../engine/shared/articleSectionCore.mjs';
import {
  EDGE_SECTION_REGISTRY_FILE,
  SECTION_REGISTRY_FILE,
  buildEdgeRegistry,
  buildSectionsCatalog,
  buildSitemapIndex,
  canonicalSectionDir,
  declaredRegistryErrors,
  edgeRegistryPublishable,
  effectiveStatuses,
  familySourceMissing,
  latestArticleDate,
  loadDeclaredRegistry,
  matchSectionPath,
  parseKillSwitch,
  registryRetiredSlugs,
  registrySectionIds,
  resolveKillSwitch,
  validateEdgeRelease,
  validateEdgeSectionRegistry,
} from '../../scripts/lib/section-registry.mjs';
import {
  API_SECTIONS,
  FAMILY_API_SECTIONS,
  PUBLISHED_API_SECTIONS,
  activeApiFamilies,
  assertActiveSectionsPublishable,
  hasApiSurfaces,
  hasOwnApiSurfaces,
  publishedApiSections,
  sectionApiSurfaces,
  sectionRssLayout,
  sectionSourceSurfaces,
} from '../../scripts/lib/corpus-sections.mjs';
import {
  archiveUnionSize,
  buildArticleUrlBlocks,
  buildFamilySectionSitemap,
  buildSitemap,
  familySectionPages,
  SECTION_PATHS,
} from '../../scripts/lib/build-sitemap.mjs';
import { countXmlTags } from '../../scripts/lib/count-xml-tags.mjs';
import { CORPUS_ROUTE_OWNER_META_TAG } from '../../engine/shared/corpusRouteOwner.mjs';
import { isNewFamilySection } from '../../scripts/lib/corpus-floors.mjs';
import {
  cantonSeoSourceFile,
  createEngineCorpusView,
  engineSeoChunkName,
  engineViewRssLayout,
  seoChunkSources,
} from '../../scripts/lib/engine-corpus-view.mjs';
import { floorViolations } from '../../scripts/ci/verify-api-floors.mjs';
import {
  declaredFiles,
  main as edgeMain,
  planRelease,
  publishRelease,
  purgeChunks,
  readPreviousRelease,
  registryState,
  requiredPageKeys,
  sitemapPaths,
  releaseDiffers,
} from '../../scripts/publish-section-edge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMIT = 'ce0973785b6fff2ce470b7f7dcba7c1ebdb9dd48';
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');
const committed = () => JSON.parse(readFileSync(path.join(ROOT, SECTION_REGISTRY_FILE), 'utf8'));
const TI = ARTICLE_SECTION_CORE_ALL['canton-ti'];
const ACTIVE_WITH_TI = { ...ARTICLE_SECTION_CORE, 'canton-ti': TI };

// ── 1. Il registro committato ────────────────────────────────────────────────

test('sections/registry.json: valido, le 24 sezioni cantonali del core, tutte draft finche\' nessuna e\' accesa', () => {
  const doc = loadDeclaredRegistry(ROOT);
  assert.deepEqual(Object.keys(doc.sections), registrySectionIds());
  assert.equal(Object.keys(doc.sections).length, 24);
  // Lo stato oggi: nessun cantone attivo nel core, quindi nessuno puo' essere live.
  if (!ARTICLE_SECTION_CORE_LIST.some((core) => core.kind === 'canton')) {
    assert.ok(Object.values(doc.sections).every((entry) => entry.status === 'draft'));
  }
});

// ── 2. Validatore ────────────────────────────────────────────────────────────

test('validatore: insieme chiuso, parita\' col core, stato ammesso', () => {
  const missing = committed();
  delete missing.sections['canton-ti'];
  assert.match(declaredRegistryErrors(missing).join('\n'), /canton-ti: manca/);

  const extra = committed();
  extra.sections.frontaliere = clone(extra.sections['canton-ti']);
  assert.match(declaredRegistryErrors(extra).join('\n'), /frontaliere: non e' una sezione cantonale/);

  const status = committed();
  status.sections['canton-ti'].status = 'online';
  assert.match(declaredRegistryErrors(status).join('\n'), /canton-ti\.status "online"/);

  const slug = committed();
  slug.sections['canton-ti'].indexSlug.fr = 'articles-ticino';
  assert.match(declaredRegistryErrors(slug).join('\n'), /canton-ti\.indexSlug diverge/);

  const topics = committed();
  topics.sections['canton-ti'].topics.fisco.en = 'taxes';
  assert.match(declaredRegistryErrors(topics).join('\n'), /canton-ti\.topics diverge/);

  const typo = committed();
  typo.sections['canton-ti'].stauts = 'live';
  assert.match(declaredRegistryErrors(typo).join('\n'), /chiave sconosciuta "stauts"/);

  const schema = committed();
  schema.schema = 2;
  assert.match(declaredRegistryErrors(schema).join('\n'), /schema 2/);
});

test('validatore: live solo per una sezione attiva nel core', () => {
  const live = committed();
  live.sections['canton-ti'].status = 'live';
  assert.match(declaredRegistryErrors(live).join('\n'), /canton-ti: dichiarata live ma non attiva nel core/);
  assert.deepEqual(declaredRegistryErrors(live, { active: ACTIVE_WITH_TI }), []);
  // retired e draft non chiedono che la sezione sia attiva.
  live.sections['canton-ti'].status = 'retired';
  assert.deepEqual(declaredRegistryErrors(live), []);
});

test('validatore: redirects e gone con le regole del Worker', () => {
  const errorsFor = (entryPatch) => {
    const doc = committed();
    Object.assign(doc.sections['canton-ti'], entryPatch);
    return declaredRegistryErrors(doc).join('\n');
  };
  assert.equal(errorsFor({ redirects: { '/articoli-ticino/vecchio/': '/articoli-ticino/nuovo/' } }), '');
  assert.equal(errorsFor({ redirects: { '/en/ticino-articles/old/': '/' } }), '', 'la radice del sito e\' un target ammesso');
  assert.equal(errorsFor({ gone: ['/de/tessin-artikel/weg/'] }), '');
  // Fuori sezione, non canonico, target non same-origin, verso se stesso.
  assert.match(errorsFor({ redirects: { '/articoli-grigioni/x/': '/' } }), /non e' un path canonico/);
  assert.match(errorsFor({ redirects: { '/articoli-ticino/x': '/' } }), /non e' un path canonico/);
  assert.match(errorsFor({ redirects: { '/articoli-ticino/Maiuscole/': '/' } }), /non e' un path canonico/);
  assert.match(errorsFor({ redirects: { '/articoli-ticino/x/': '//evil.example/' } }), /same-origin/);
  assert.match(errorsFor({ redirects: { '/articoli-ticino/x/': 'https://evil.example/' } }), /same-origin/);
  assert.match(errorsFor({ redirects: { '/articoli-ticino/x/': '/articoli-ticino/y' } }), /same-origin/);
  assert.match(errorsFor({ redirects: { '/articoli-ticino/x/': '/articoli-ticino/x/' } }), /verso se stesso/);
  assert.match(errorsFor({ gone: ['/articoli-ticino/x/'], redirects: { '/articoli-ticino/x/': '/' } }), /anche un redirect/);
  assert.match(errorsFor({ gone: '/articoli-ticino/x/' }), /deve essere un array/);

  const cycle = committed();
  cycle.sections['canton-ti'].redirects = { '/articoli-ticino/a/': '/articoli-grigioni/b/' };
  cycle.sections['canton-gr'].redirects = { '/articoli-grigioni/b/': '/articoli-ticino/a/' };
  assert.match(declaredRegistryErrors(cycle).join('\n'), /redirect circolare/);
});

test('copie del Worker: prefissi, forma canonica, segmenti', () => {
  assert.deepEqual(matchSectionPath('/articoli-ticino/x/'), { section: 'canton-ti', locale: 'it', prefix: '/articoli-ticino' });
  assert.equal(matchSectionPath('/articoli-ticino-altro/'), null);
  assert.equal(matchSectionPath('/articoli-frontaliere/x/'), null);
  assert.equal(matchSectionPath('/fr/articles-bale/').section, 'canton-basilea');
  const route = matchSectionPath('/articoli-ticino');
  assert.equal(canonicalSectionDir('/articoli-ticino', route), '/articoli-ticino/');
  assert.equal(canonicalSectionDir('/articoli-ticino.html', route), '/articoli-ticino/');
  assert.equal(canonicalSectionDir('/articoli-ticino/x/index.html', route), '/articoli-ticino/x/');
  assert.equal(canonicalSectionDir('/articoli-ticino/a/b/c/d/', route), '/articoli-ticino/a/b/c/d/');
  assert.equal(canonicalSectionDir('/articoli-ticino/a/b/c/d/e/', route), null);
  assert.equal(canonicalSectionDir('/articoli-ticino/a_b/', route), null);
});

// ── 3. Kill-switch ───────────────────────────────────────────────────────────

test('kill-switch: codici di gruppo, id, all; token ignoti riportati', () => {
  assert.deepEqual(parseKillSwitch(undefined), { sections: [], unknown: [] });
  assert.deepEqual(parseKillSwitch(''), { sections: [], unknown: [] });
  assert.deepEqual(parseKillSwitch('TI, gr;canton-be  basilea'), {
    sections: ['canton-basilea', 'canton-be', 'canton-gr', 'canton-ti'],
    unknown: [],
  });
  assert.deepEqual(parseKillSwitch('TI XX canton-zz'), { sections: ['canton-ti'], unknown: ['XX', 'canton-zz'] });
  assert.equal(parseKillSwitch('all').sections.length, 24);
  assert.equal(parseKillSwitch('*').sections.length, 24);
});

test('kill-switch: verificato solo col marker del loader; spegne live, non tocca retired', () => {
  assert.equal(resolveKillSwitch({}).state, 'unverified');
  assert.equal(resolveKillSwitch({ RC_ENV_LOADED: 'true' }).state, 'unverified');
  const ks = resolveKillSwitch({ RC_ENV_LOADED: '1', CANTON_ARTICLE_SECTIONS_KILL: 'TI GR' });
  assert.equal(ks.state, 'verified');
  const doc = committed();
  doc.sections['canton-ti'].status = 'live';
  doc.sections['canton-gr'].status = 'retired';
  doc.sections['canton-be'].status = 'live';
  const eff = effectiveStatuses(doc, ks);
  assert.deepEqual(eff['canton-ti'], { declared: 'live', status: 'draft', killed: true });
  assert.deepEqual(eff['canton-gr'], { declared: 'retired', status: 'retired', killed: false });
  assert.deepEqual(eff['canton-be'], { declared: 'live', status: 'live', killed: false });
});

test('copia per il Worker: scritta se verificato o se nessuna sezione e\' live', () => {
  const doc = committed();
  assert.equal(edgeRegistryPublishable(doc, { state: 'unverified', sections: [] }), true, 'tutte draft: niente da spegnere');
  doc.sections['canton-ti'].status = 'live';
  assert.equal(edgeRegistryPublishable(doc, { state: 'unverified', sections: [] }), false);
  assert.equal(edgeRegistryPublishable(doc, { state: 'verified', sections: [] }), true);
});

test('copia per il Worker: formato di parseCorpusSectionRegistry, accettata dal suo parse', () => {
  const doc = committed();
  doc.sections['canton-ti'].status = 'live';
  doc.sections['canton-ti'].redirects = { '/articoli-ticino/vecchio/': '/articoli-ticino/nuovo/' };
  doc.sections['canton-ti'].gone = ['/en/ticino-articles/ritirato/'];
  const ks = { state: 'verified', sections: [], unknown: [] };
  const edge = buildEdgeRegistry({ declared: doc, effective: effectiveStatuses(doc, ks), commit: COMMIT });
  assert.equal(edge.schema, 1);
  assert.equal(edge.commit, COMMIT);
  assert.deepEqual(edge.sections['canton-ti'], {
    status: 'live',
    redirects: { '/articoli-ticino/vecchio/': '/articoli-ticino/nuovo/' },
    gone: ['/en/ticino-articles/ritirato/'],
  });
  assert.deepEqual(edge.sections['canton-gr'], { status: 'draft' }, 'niente chiavi vuote');
  assert.equal(validateEdgeSectionRegistry(edge), true);
  // Le forme che il Worker scarta per intero.
  assert.equal(validateEdgeSectionRegistry({ ...edge, schema: 2 }), false);
  assert.equal(validateEdgeSectionRegistry({ ...edge, commit: 'HEAD' }), false);
  assert.equal(validateEdgeSectionRegistry({ ...edge, sections: { ...edge.sections, svizzera: { status: 'live' } } }), false);
  assert.equal(validateEdgeSectionRegistry({ ...edge, sections: { 'canton-ti': { status: 'on' } } }), false);
  assert.equal(
    validateEdgeSectionRegistry({ ...edge, sections: { 'canton-ti': { status: 'live', redirects: { '/articoli-ticino/x/': '//evil/' } } } }),
    false,
  );
});

test('catalogo sections.json: cosa sono le sezioni, MAI in che stato sono (una sola fonte: il registro su R2)', () => {
  const doc = committed();
  doc.sections['canton-ti'].status = 'live';
  doc.sections['canton-gr'].status = 'retired';
  const catalog = buildSectionsCatalog({
    declared: doc,
    commit: COMMIT,
    articles: { 'canton-ti': 3 },
    sitemapOf: (id) => (id === 'canton-ti' ? 'sitemap-articles-canton-ti.xml' : null),
  });
  assert.equal(catalog.authoritative, false);
  assert.equal(catalog.statusSource, 'https://cdn.frontaliereticino.ch/edge/sections/registry.json');
  assert.equal(catalog.sections.length, 24);
  const ti = catalog.sections.find((entry) => entry.id === 'canton-ti');
  assert.deepEqual(Object.keys(ti), ['id', 'kind', 'canton', 'indexSlug', 'paths', 'topics', 'counts', 'sitemap']);
  assert.deepEqual(ti.paths, { it: '/articoli-ticino/', en: '/en/ticino-articles/', de: '/de/tessin-artikel/', fr: '/fr/articles-tessin/' });
  assert.deepEqual(ti.topics.map((t) => t.id), ['carburanti', 'fisco', 'mobilita', 'eventi', 'pensioni', 'servizi']);
  assert.equal(ti.sitemap, '/sitemap-articles-canton-ti.xml');
  assert.deepEqual(ti.counts, { articles: 3 });
  // Nessuna traccia dello stato, ne' effettivo ne' dichiarato, in nessuna voce.
  assert.ok(!/"(status|declaredStatus|killSwitch)"/.test(JSON.stringify(catalog)));
  assert.ok(!/live|retired|draft/.test(JSON.stringify(catalog.sections)));
  // E build-api lo impone sul file scritto.
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  assert.match(build, /catalog\.authoritative !== false \|\| \(catalog\.sections \?\? \[\]\)\.some\(\(entry\) => 'status' in entry/);
});

// ── 4. Sitemap ───────────────────────────────────────────────────────────────

test('indice sitemap-cantons.xml: mai vuoto (lo schema chiede almeno un <sitemap>)', () => {
  assert.equal(buildSitemapIndex([]), null);
  const xml = buildSitemapIndex([{ file: 'sitemap-articles-canton-ti.xml', lastmod: '2026-10-05T10:00:00Z' }, { file: 'sitemap-articles-canton-gr.xml' }]);
  assert.equal(countXmlTags(xml, 'sitemap'), 2);
  assert.match(xml, /<loc>https:\/\/frontaliereticino\.ch\/sitemap-articles-canton-ti\.xml<\/loc>\n {4}<lastmod>2026-10-05T10:00:00Z<\/lastmod>/);
  assert.equal(latestArticleDate([{ date: '2026-10-01' }, { date: '2026-09-01', updatedAt: '2026-10-03T00:00:00Z' }, { date: 'x' }]), '2026-10-03T00:00:00Z');
  assert.equal(latestArticleDate([]), null);
  assert.equal(latestArticleDate([{ updatedAt: 'boh', date: '2026-10-02' }]), '2026-10-02', 'un updatedAt illeggibile non nasconde la date');
  assert.equal(latestArticleDate([{ date: 'Oct 5, 2026 10:00 UTC' }]), '2026-10-05T10:00:00.000Z', 'una data non ISO si normalizza');
  assert.equal(latestArticleDate([{ date: '2026-10-05T10:00:00+02:00' }]), '2026-10-05T10:00:00+02:00');
});

test('sitemap di sezione: landing, 6 hub indicizzabili, archivio paginato, articoli', () => {
  const entries = [
    { id: 'a', date: '2026-10-04', image: '/images/blog/a.webp' },
    { id: 'b', date: '2026-10-05' },
    { id: 'c', date: '2026-10-05' },
  ];
  const slugMap = Object.fromEntries(entries.map(({ id }) => [id, { it: `${id}-it`, en: `${id}-en`, de: `${id}-de`, fr: `${id}-fr` }]));
  const built = buildFamilySectionSitemap({ section: 'canton-ti', entries, slugMap, meta: {}, pageSize: 2 });
  // (landing + 6 hub + 2 pagine d'archivio) x 4 locali + 3 articoli.
  assert.equal(built.pageCount, (1 + 6 + 2) * 4);
  assert.equal(built.articleCount, 3);
  assert.equal(built.count, built.pageCount + 3);
  assert.equal(countXmlTags(built.xml, 'url'), built.count);
  for (const loc of [
    '/articoli-ticino/', '/en/ticino-articles/', '/articoli-ticino/carburanti/', '/en/ticino-articles/fuel/',
    '/de/tessin-artikel/dienstleistungen/', '/fr/articles-tessin/fiscalite/', '/articoli-ticino/tutti/',
    '/articoli-ticino/tutti/page-2/', '/de/tessin-artikel/alle/page-2/', '/articoli-ticino/a-it/',
  ]) {
    assert.ok(built.xml.includes(`<loc>https://frontaliereticino.ch${loc}</loc>`), loc);
  }
  assert.ok(!built.xml.includes('/tutti/page-3/'));
  assert.ok(!/noindex/.test(built.xml));
  // Gli articoli hanno la stessa forma della sitemap blog.
  const blocks = buildArticleUrlBlocks(entries, { it: '/articoli-ticino/', en: '/en/ticino-articles/', de: '/de/tessin-artikel/', fr: '/fr/articles-tessin/' }, slugMap, {});
  assert.ok(built.xml.includes(blocks.join('\n')));
  // Una pagina di sezione ritirata dal registro in una locale esce in tutte e quattro.
  const cut = buildFamilySectionSitemap({ section: 'canton-ti', entries, slugMap, meta: {}, pageSize: 2,
    retiredPaths: new Set(['/en/ticino-articles/fuel/']) });
  assert.equal(cut.pageCount, built.pageCount - 4);
  assert.ok(!cut.xml.includes('/articoli-ticino/carburanti/'));
  // Sezione senza articoli: le pagine ci sono comunque, archivio di una pagina.
  assert.equal(familySectionPages('canton-gr', 0, 24).length, 1 + 6 + 1);
  assert.throws(() => familySectionPages('frontaliere', 0, 24), /hub tematici/);
});

test('sitemap storica: il refactor in blocchi lascia l\'output identico', () => {
  const entries = [{ id: 'x', date: '2026-01-01', image: 'https://cdn.example/x.webp' }];
  const slugMap = { x: { it: 'x-it', en: 'x-en', de: 'x-de', fr: 'x-fr' } };
  const meta = { 'blog.article.x.title': 'T & <b>', 'blog.article.x.imageAlt': 'A' };
  const { xml, count } = buildSitemap(entries, 'svizzera', slugMap, meta);
  assert.equal(count, 1);
  assert.equal(
    xml,
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n' +
      '        xmlns:xhtml="http://www.w3.org/1999/xhtml"\n' +
      '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
      buildArticleUrlBlocks(entries, SECTION_PATHS.svizzera, slugMap, meta).join('\n') +
      '\n</urlset>\n',
  );
});

// ── 5. Superficie API di famiglia ────────────────────────────────────────────

test('corpus-sections: la famiglia canton ha nomi aggregati, le storiche restano proprie', () => {
  assert.equal(hasApiSurfaces('canton-ti'), true);
  assert.equal(hasOwnApiSurfaces('canton-ti'), false);
  assert.equal(hasOwnApiSurfaces('svizzera'), true);
  const api = sectionApiSurfaces('canton-ti');
  assert.deepEqual(
    [api.family, api.registry, api.metaFile('de'), api.slugsKey, api.reverseKey, api.counter, api.sitemap, api.sitemapCounter],
    ['canton', 'canton-articles.json', 'meta-canton-de.json', 'cantons', null, 'cantonArticles', 'sitemap-articles-canton-ti.xml', 'sitemapCantonUrls'],
  );
  assert.equal(sectionApiSurfaces('frontaliere').family, null);
  // Con la lista attiva di oggi niente di famiglia e' pubblicato.
  assert.deepEqual(FAMILY_API_SECTIONS, []);
  assert.deepEqual(PUBLISHED_API_SECTIONS.map((s) => s.section), API_SECTIONS.map((s) => s.section));
  // Accesa, la sezione cantonale entra nella famiglia, non fra le storiche.
  const withTi = publishedApiSections([...ARTICLE_SECTION_CORE_LIST, TI]);
  assert.deepEqual(withTi.map((s) => s.section), ['frontaliere', 'svizzera', 'canton-ti']);
  const families = activeApiFamilies(withTi);
  assert.equal(families.length, 1);
  assert.equal(families[0].family, 'canton');
  assert.deepEqual(families[0].sections.map((s) => s.section), ['canton-ti']);
  assert.equal(assertActiveSectionsPublishable([...ARTICLE_SECTION_CORE_LIST, TI]), true);
  // Gli export che create-article scrive per una sezione cantonale.
  const src = sectionSourceSurfaces('canton-ti');
  assert.deepEqual([src.registryExport, src.slugExport, src.reverseExport, src.fallbackReasonsExport],
    ['CANTON_ARTICLES', 'CANTON_SLUGS', null, 'CANTON_SLUG_FALLBACK_REASONS']);
});

test('RSS: le storiche dalla radice col layout di sempre; una cantonale attraverso la vista nel layout dell\'engine', () => {
  for (const id of ['frontaliere', 'svizzera']) {
    assert.deepEqual(sectionRssLayout(id), { seoDir: 'content/seo', localesDir: 'content', slugDir: 'content' });
  }
  // L'engine risolve `<slugDir>/<basename del file slug>`: per canton-ti deve cadere sul file vero.
  const slugFile = sectionSourceSurfaces('canton-ti').slugFile;
  const layout = engineViewRssLayout(slugFile);
  assert.deepEqual(layout, { seoDir: 'services/seo', localesDir: 'services/locales', slugDir: 'content/cantons/canton-ti' });
  assert.equal(path.join(layout.slugDir, path.basename(slugFile)), 'content/cantons/canton-ti/slugs.ts');
  assert.match(readFileSync(path.join(ROOT, 'engine/rssFeeds.mjs'), 'utf8'), /return path\.join\(slugDir, path\.basename\(slugFile\)\);/);
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  assert.match(build, /rootDir: viaView \? familyRssView : ROOT,/);
  assert.match(build, /layout: viaView \? engineViewRssLayout\(published\.slugFile\) : sectionRssLayout\(section\.id\),/);
  // E build-api rifiuta un feed di famiglia che ha letto una mappa slug diversa da quella pubblicata.
  assert.match(build, /if \(section\.slugCount !== emitted\) \{\s+throw new Error\(/);
});

test('vista del corpus nel layout dell\'engine: il chunk SEO cantonale ha il nome che l\'engine cerca', () => {
  // I due nomi dello stesso file: dove create-article lo scrive, come l'engine lo cerca.
  assert.equal(cantonSeoSourceFile('canton-ti'), 'content/cantons/canton-ti/seo.ts');
  assert.equal(engineSeoChunkName('canton-ti'), 'seo-blog-canton-ti.ts');
  const generator = path.join(ROOT, 'generator/scripts/lib/canton-section-profile.mjs');
  if (existsSync(generator)) assert.ok(readFileSync(generator, 'utf8').includes('seoFile: `packages/articles/content/cantons/${section}/seo.ts`'));
  assert.ok(readFileSync(path.join(ROOT, 'engine/shared/articleSectionDescriptors.ts'), 'utf8').includes('seoFiles: [`services/seo/seo-blog-${core.section}.ts`]'));

  const root = mkdtempSync(path.join(tmpdir(), 'view-root-'));
  for (const [rel, body] of [
    ['content/seo/seo-blog-ch.ts', 'ch'],
    ['content/cantons/canton-ti/seo.ts', 'ti'],
    ['content/cantons/canton-ti/slugs.ts', 'slugs'],
    ['content/blog-meta-canton-ti-it.ts', 'meta'],
    ['engine/x.mjs', 'engine'],
    ['services/routerSwissData.ts', 'router'],
    ['scripts/a.mjs', 'script'],
  ]) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  mkdirSync(path.join(root, '.git'));
  const view = createEngineCorpusView(root, mkdtempSync(path.join(tmpdir(), 'view-')));
  try {
    const at = (rel) => readFileSync(path.join(view, rel), 'utf8');
    assert.equal(at('services/seo/seo-blog-canton-ti.ts'), 'ti', 'il nome dell\'engine cade sul chunk scritto da create-article');
    assert.equal(at('services/seo/seo-blog-ch.ts'), 'ch');
    assert.equal(at('services/locales/blog-meta-canton-ti-it.ts'), 'meta');
    assert.equal(at('packages/articles/content/cantons/canton-ti/slugs.ts'), 'slugs');
    assert.equal(at('content/cantons/canton-ti/slugs.ts'), 'slugs');
    assert.equal(at('services/routerSwissData.ts'), 'router');
    assert.equal(at('packages/articles/engine/x.mjs'), 'engine');
    assert.ok(!existsSync(path.join(view, '.git')));
    // Una sezione senza chunk non ha un alias penzolante.
    assert.ok(!existsSync(path.join(view, 'services/seo/seo-blog-canton-gr.ts')));
  } finally {
    rmSync(view, { recursive: true, force: true });
  }
  assert.equal(readFileSync(path.join(root, 'content/cantons/canton-ti/seo.ts'), 'utf8'), 'ti', 'rimuovere la vista non tocca il corpus');
  // I pavimenti contano i chunk dove stanno nel corpus.
  assert.deepEqual(seoChunkSources({ id: 'canton-ti', seoFiles: ['seo-blog-canton-ti.ts'] }), { seoDir: 'content/cantons/canton-ti', files: ['seo.ts'], historyComparable: false });
  assert.deepEqual(seoChunkSources({ id: 'svizzera', seoFiles: ['seo-blog-ch.ts'] }), { seoDir: 'content/seo', files: ['seo-blog-ch.ts'], historyComparable: true });
  assert.match(readFileSync(path.join(ROOT, 'scripts/ci/verify-api-floors.mjs'), 'utf8'), /countSeoEntries\(root, seo\.files, seo\.seoDir\)/);
});

test('corpus-sections: gli export dichiarati coincidono con quelli che create-article scrive (P6b)', async (t) => {
  const profile = path.join(ROOT, 'generator/scripts/lib/canton-section-profile.mjs');
  if (!existsSync(profile)) {
    t.skip('canton-section-profile.mjs non ancora sul ramo (P6b)');
    return;
  }
  const { cantonSectionSkeletons } = await import(profile);
  const skeleton = Object.values(cantonSectionSkeletons('canton-ti')).join('\n');
  const src = sectionSourceSurfaces('canton-ti');
  for (const name of [src.registryExport, src.slugExport, src.fallbackReasonsExport]) {
    assert.match(skeleton, new RegExp(`export const ${name}\\b`), name);
  }
});

test('famiglia: una sezione nuova non ha nessun file; un insieme parziale e\' un rifiuto', () => {
  const base = { section: 'canton-ti', rel: 'content/blog-meta-canton-ti-de.ts', registryRel: 'content/cantons/canton-ti/registry.ts' };
  assert.equal(familySourceMissing({ ...base, present: false, registryPresent: false }), true, 'sezione nuova: vale vuoto');
  assert.equal(familySourceMissing({ ...base, present: true, registryPresent: true }), false);
  assert.throws(() => familySourceMissing({ ...base, present: false, registryPresent: true }), /assente mentre .*registry\.ts esiste.*parziale/);
  assert.throws(() => familySourceMissing({ ...base, present: true, registryPresent: false }), /esiste ma .*registry\.ts no.*parziale/);
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  assert.match(build, /familySourceMissing\(\{/);
  assert.match(build, /if \(familyFileMissing\(section, section\.metaFile\(loc\)\)\) return \{\};/);
});

test('sitemap di sezione: un articolo ritirato o spostato in QUALSIASI locale esce intero', () => {
  const prefixes = { it: '/articoli-ticino/', en: '/en/ticino-articles/', de: '/de/tessin-artikel/', fr: '/fr/articles-tessin/' };
  const slugMap = {
    a: { it: 'a-it', en: 'a-en', de: 'a-de', fr: 'a-fr' },
    b: { it: 'b-it', en: 'b-en', de: 'b-de', fr: 'b-fr' },
    c: { it: 'c-it', en: 'c-en', de: 'c-de', fr: 'c-fr' },
    d: { it: 'd-it', en: 'd-en', de: 'd-de', fr: 'd-fr' },
  };
  const entry = {
    gone: ['/en/ticino-articles/a-en/', '/articoli-ticino/carburanti/'],
    redirects: { '/fr/articles-tessin/b-fr/': '/fr/articles-tessin/', '/articoli-ticino/c-it/': '/articoli-ticino/d-it/' },
  };
  assert.deepEqual(registryRetiredSlugs(entry, slugMap, prefixes), ['a-it', 'b-it', 'c-it']);
  assert.deepEqual(registryRetiredSlugs({}, slugMap, prefixes), []);
  assert.deepEqual(registryRetiredSlugs(undefined, slugMap, prefixes), []);
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  assert.match(build, /registryRetiredSlugs\(declaredSections\.sections\[section\.section\]/);
  // I ritiri dichiarati escono anche dal riferimento del pavimento di famiglia.
  assert.match(build, /source: Math\.max\(0, source - retiredSource\)/);
});

test('una sezione di famiglia accesa e VUOTA attraversa tutti i gate di publish-api (indice runtime, pavimenti dei feed)', () => {
  // Nuova = senza registro. Al primo articolo tornano le regole di tutte le altre.
  const root = mkdtempSync(path.join(tmpdir(), 'new-family-'));
  assert.equal(isNewFamilySection(root, 'canton-ti'), true);
  assert.equal(isNewFamilySection(root, 'svizzera'), false, 'una sezione storica senza registro non e\' «nuova»: e\' un corpus sparito');
  mkdirSync(path.join(root, 'content/cantons/canton-ti'), { recursive: true });
  writeFileSync(path.join(root, 'content/cantons/canton-ti/registry.ts'), "export const CANTON_ARTICLES = [\n  {\n    id: 'a',\n  },\n];\n");
  assert.equal(isNewFamilySection(root, 'canton-ti'), false);
  // build-blog-index: l'indice di una sezione senza articoli non ha un «piu' recente» da stampare.
  const index = readFileSync(path.join(ROOT, 'scripts/build-blog-index.mjs'), 'utf8');
  assert.doesNotMatch(index, /capped\[0\]\.date/);
  assert.match(index, /capped\[0\]\?\.date \?\?/);
  // verify-api-floors: i feed vuoti o assenti di una sezione nuova non sono un riferimento mancante;
  // un feed con item senza registro sorgente invece si'.
  const floors = readFileSync(path.join(ROOT, 'scripts/ci/verify-api-floors.mjs'), 'utf8');
  assert.match(floors, /RSS_SECTIONS\.filter\(\(section\) => isNewFamilySection\(root, section\.id\)\)/);
  assert.match(floors, /if \(newFamily\.has\(feedSection\(feedName\)\)\) continue;/);
  assert.match(floors, /if \(newFamily\.has\(section\)\) \{[\s\S]*?if \(feed\.items > 0\) violations\.push/);
  const none = { feeds: [], missingFeeds: [], imageErrors: [] };
  assert.deepEqual(
    floorViolations(none, { sourceArticles: {}, feedSources: {}, sourceImages: null, rssMaxItems: 50, newFamilySections: ['canton-ti'] })
      .filter((line) => /feed|RSS/.test(line)),
    [],
  );
});

test('Google News: le sezioni cantonali restano fuori dalla v1 (decisione D5), per scelta dichiarata', () => {
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  const at = build.indexOf('«Fuori v1: Google News sitemap, news ticker, homepage»');
  assert.ok(at > 0, 'la decisione deve restare scritta dove il collector sceglie le sezioni');
  assert.match(build.slice(at, at + 700), /for \(const section of API_SECTIONS\) \{\s+collect\(/);
});

// ── 6. Pubblicazione su R2: release versionata, un solo PUT ──────────────────

const DRAFT_ALL = (commit = COMMIT) => ({ schema: 1, commit, sections: Object.fromEntries(registrySectionIds().map((id) => [id, { status: 'draft' }])) });
const withLive = (ids, commit = COMMIT) => {
  const doc = DRAFT_ALL(commit);
  for (const id of ids) doc.sections[id] = { status: 'live' };
  return doc;
};
const OLD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

/** Un dist/api come lo scrive build-api per un dato registro (`salt` cambia i byte delle sitemap). */
function fakeDist(registry, { index = undefined, salt = '', extraArticles = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'section-edge-'));
  const live = Object.keys(registry.sections).filter((id) => registry.sections[id].status === 'live');
  mkdirSync(path.join(dir, 'edge/sections'), { recursive: true });
  writeFileSync(path.join(dir, EDGE_SECTION_REGISTRY_FILE), JSON.stringify(registry));
  for (const id of live) writeFileSync(path.join(dir, `sitemap-articles-${id}.xml`), sitemapOf(id, salt, extraArticles));
  if (index ?? live.length > 0) writeFileSync(path.join(dir, 'sitemap-cantons.xml'), `<sitemapindex><!-- ${live.join(',')} --></sitemapindex>`);
  return dir;
}

/** R2 + CDN finti: `store` e' cio' che R2 ha; `io.fail`/`io.corrupt` decidono cosa va storto. */
function fakeIo() {
  const store = new Map();
  const io = {
    store,
    ops: [],
    purged: [],
    fail: () => false,
    corrupt: () => false,
    upload: (local, key, cacheControl) => {
      io.ops.push(`put ${key}`);
      if (io.fail('upload', key)) return false;
      store.set(key, io.corrupt(key) ? Buffer.from('troncato') : readFileSync(local));
      store.set(`cc:${key}`, cacheControl);
      return true;
    },
    remove: (key) => {
      io.ops.push(`del ${key}`);
      if (io.fail('remove', key)) return false;
      store.delete(key);
      return true;
    },
    purge: (urls) => {
      io.ops.push(`purge ${urls.length}`);
      io.purged.push(...urls);
      return !io.fail('purge', urls.join(','));
    },
    fetchBytes: async (url) => {
      const key = url.replace('https://cdn.frontaliereticino.ch/', '');
      if (io.fail('fetch', key)) return { status: 0 };
      return store.has(key) ? { status: 200, body: store.get(key) } : { status: 404 };
    },
  };
  return io;
}

const CREDS = { R2_ACCESS_KEY_ID: 'x', R2_SECRET_ACCESS_KEY: 'x', R2_S3_ENDPOINT: 'x', R2_BUCKET: 'x', CF_API_TOKEN: 'x' };
const pointerOf = (io) => {
  if (!io.store.has(EDGE_SECTION_REGISTRY_FILE)) return null;
  const raw = io.store.get(EDGE_SECTION_REGISTRY_FILE).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { unreadable: raw, sections: {} };
  }
};
/**
 * Cio' che il Worker serve: lo stato del puntatore e, per ogni nome che il
 * puntatore dichiara, i byte sotto la SUA base. E' la sola cosa che un
 * fallimento prima del PUT deve lasciare identica.
 */
const PAGE_KEY_RE = /^edge\/sections\/(?!_releases\/|registry\.json$)/;
function served(io) {
  const pointer = pointerOf(io);
  if (!pointer) return JSON.stringify({ state: registryState({ sections: {} }), files: {} });
  const files = Object.fromEntries(Object.keys(pointer.release?.files ?? {}).map((name) => [name, io.store.get(`${pointer.release.base}${name}`)?.toString('utf8') ?? null]));
  return JSON.stringify({ state: registryState(pointer), files });
}

/**
 * Pubblica `registry` su un R2 finto. Le release in `history` vengono PRIMA
 * pubblicate davvero, in ordine, con lo stesso protocollo; `seed(io)` puo'
 * poi alterare R2 a mano. I guasti valgono solo per la pubblicazione sotto prova.
 */
const liveIds = (registry) => Object.keys(registry.sections).filter((id) => registry.sections[id].status === 'live');
/** Mette su R2 le pagine di bootstrap di una sezione (cio' che fa publish-section-pages). */
const SECTION_PAGES = (id) => familySectionPages(id, 0, 1).flatMap((page) => Object.values(page.paths));
/** La sitemap finta di una sezione: le pagine di sezione, una page-2 d'archivio e un articolo. */
const sitemapOf = (id, salt = '', extraArticles = []) => {
  const [it, en, de, fr] = SECTION_PAGES(id);
  const locs = [...SECTION_PAGES(id), `${it}tutti/page-2/`];
  // Un articolo come lo scrive buildArticleUrlBlocks: loc IT, le altre lingue solo negli alternate.
  const article = (slug) =>
    `<url><loc>https://frontaliereticino.ch${it}${slug}/</loc>` +
    [['en', en], ['de', de], ['fr', fr]].map(([l, base]) => `<xhtml:link rel="alternate" hreflang="${l}" href="https://frontaliereticino.ch${base}${slug}-${l}/" />`).join('') +
    '</url>';
  return `<urlset><!-- ${id}${salt} -->${locs.map((p) => `<url><loc>https://frontaliereticino.ch${p}</loc></url>`).join('')}${['un-articolo', ...extraArticles].map(article).join('')}</urlset>`;
};
function seedPages(io, ids) {
  for (const id of ids) {
    for (const key of requiredPageKeys(id, { sitemapXml: sitemapOf(id) })) {
      io.store.set(key, Buffer.from(`<html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head></html>`));
    }
  }
}

async function publish(registry, { history = [], seed, fail, corrupt, salt, extraArticles, bootstrap = true, bootstrapWaitMs = 0, sleep } = {}, env = CREDS) {
  const io = fakeIo();
  for (const past of history) {
    seedPages(io, liveIds(past));
    const first = await publishRelease(planRelease(fakeDist(past)), { io, env: CREDS, log: () => {}, bootstrapWaitMs: 0 });
    assert.equal(first.code, 0, 'una release della storia deve pubblicarsi');
  }
  if (bootstrap) seedPages(io, liveIds(registry));
  if (seed) seed(io);
  io.ops.length = 0;
  io.purged.length = 0;
  if (fail) io.fail = fail;
  if (corrupt) io.corrupt = corrupt;
  const logs = [];
  const before = served(io);
  const result = await publishRelease(planRelease(fakeDist(registry, { salt, extraArticles })), { io, env, log: (line) => logs.push(line), bootstrapWaitMs, sleep });
  return { io, logs, before, result };
}

test('edge: lo stato e\' status+redirects+gone; commit e release non sono stato', () => {
  assert.equal(registryState(DRAFT_ALL()), registryState({ sections: {} }), 'una sezione assente vale draft');
  assert.equal(registryState(withLive(['canton-ti'], OLD)), registryState({ ...withLive(['canton-ti']), release: { commit: 'x' } }));
  assert.notEqual(registryState(withLive(['canton-ti'])), registryState(DRAFT_ALL()));
  assert.notEqual(
    registryState({ sections: { 'canton-ti': { status: 'live', gone: ['/articoli-ticino/x/'] } } }),
    registryState(withLive(['canton-ti'])),
  );
});

test('edge: il puntatore porta la release (base versionata, sha256 e bytes dei file) e resta nel contratto del Worker', () => {
  const release = planRelease(fakeDist(withLive(['canton-ti', 'canton-gr'])));
  assert.equal(release.base, `edge/sections/_releases/${COMMIT}/`);
  assert.deepEqual(release.files.map((f) => f.key), [
    `edge/sections/_releases/${COMMIT}/sitemap-articles-canton-gr.xml`,
    `edge/sections/_releases/${COMMIT}/sitemap-articles-canton-ti.xml`,
    `edge/sections/_releases/${COMMIT}/sitemap-cantons.xml`,
  ]);
  const { release: rel, ...state } = release.pointer;
  assert.deepEqual(state, release.registry, 'i campi di stato che il Worker legge non cambiano');
  assert.deepEqual(Object.keys(rel), ['commit', 'base', 'files', 'previous']);
  assert.equal(rel.base, release.base);
  for (const file of release.files) assert.deepEqual(rel.files[file.name], { sha256: file.sha256, bytes: file.bytes });
  assert.ok(release.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0));
  assert.equal(validateEdgeSectionRegistry(release.pointer), true);
  // La forma che il Worker legge (`parseCorpusSectionRelease`, sito #11811): base ESATTAMENTE
  // `edge/sections/_releases/<commit>/`, sha256 a 64 hex e bytes intero per ogni file; un `release`
  // non valido fa scartare il registro intero, quindi qui deve essere un rifiuto prima di pubblicare.
  assert.equal(validateEdgeRelease(rel), true);
  for (const bad of [
    { ...rel, base: 'edge/sections/_releases/0000000/' },
    { ...rel, base: `edge/sections/_releases/${COMMIT}` },
    { ...rel, commit: 'HEAD' },
    { ...rel, files: { 'sitemap-cantons.xml': { sha256: 'abc', bytes: 1 } } },
    { ...rel, files: { 'sitemap-cantons.xml': { sha256: 'f'.repeat(64), bytes: -1 } } },
    { ...rel, files: { 'sitemap-cantons.xml': { sha256: 'f'.repeat(64) } } },
    { ...rel, files: [] },
  ]) {
    assert.equal(validateEdgeRelease(bad), false, JSON.stringify(bad).slice(0, 80));
    assert.equal(validateEdgeSectionRegistry({ ...release.pointer, release: bad }), false);
  }
  // Tutto draft: nessun file, puntatore comunque valido.
  assert.deepEqual(planRelease(fakeDist(DRAFT_ALL())).pointer.release.files, {});
  // Niente registro in dist (kill-switch non verificato): nessuna release.
  assert.equal(planRelease(mkdtempSync(path.join(tmpdir(), 'no-edge-'))), null);
  // Release incoerenti: rifiuto, non un upload parziale.
  assert.throws(() => planRelease(fakeDist(withLive(['canton-ti']), { index: false })), /release incoerente/);
  assert.throws(() => planRelease(fakeDist(DRAFT_ALL(), { index: true })), /release incoerente/);
  const noSitemap = fakeDist(withLive(['canton-ti']));
  rmSync(path.join(noSitemap, 'sitemap-articles-canton-ti.xml'));
  assert.throws(() => planRelease(noSitemap), /sitemap-articles-canton-ti\.xml: manca/);
});

test('edge: ordine — file sotto la base della release, riletti, poi UN solo PUT; nessun path fisso', async () => {
  const { io, result } = await publish(withLive(['canton-ti']), { history: [DRAFT_ALL(OLD)] });
  assert.deepEqual(result, { code: 0, phase: 'done', flipped: true });
  const base = `edge/sections/_releases/${COMMIT}/`;
  assert.deepEqual(io.ops, [
    `put ${base}sitemap-articles-canton-ti.xml`,
    `put ${base}sitemap-cantons.xml`,
    'put edge/sections/registry.json',
    'purge 3',
  ]);
  // Nessuna chiave fuori dalla base della release, a parte il puntatore.
  const written = [...io.store.keys()].filter((key) => !key.startsWith('cc:') && !PAGE_KEY_RE.test(key));
  assert.ok(written.every((key) => key === 'edge/sections/registry.json' || key.startsWith('edge/sections/_releases/')), written.join(', '));
  assert.equal(io.store.get('cc:edge/sections/registry.json'), 'public,max-age=60');
  assert.equal(io.store.get(`cc:${base}sitemap-cantons.xml`), 'public,max-age=31536000,immutable');
  assert.deepEqual([...io.purged].sort(), [
    'https://cdn.frontaliereticino.ch/edge/sections/registry.json',
    'https://frontaliereticino.ch/sitemap-articles-canton-ti.xml',
    'https://frontaliereticino.ch/sitemap-cantons.xml',
  ].sort());
  const pointer = pointerOf(io);
  assert.equal(pointer.release.base, base);
  assert.equal(registryState(pointer), registryState(withLive(['canton-ti'])));
  assert.equal(validateEdgeSectionRegistry(pointer), true);
});

test('edge: push obbligatorio a ogni differenza — accensione, spegnimento, ritiro, byte di un file', async () => {
  const live = planRelease(fakeDist(withLive(['canton-ti'])));
  const draft = planRelease(fakeDist(DRAFT_ALL()));
  const retiredDoc = DRAFT_ALL();
  retiredDoc.sections['canton-ti'] = { status: 'retired' };
  const retired = planRelease(fakeDist(retiredDoc));
  const servedAs = (release, commit = OLD) => ({ state: 'ok', doc: { ...release.pointer, commit } });
  assert.equal(releaseDiffers(draft, { state: 'absent' }), false, 'oggi: tutto draft, mai pubblicato');
  assert.equal(releaseDiffers(draft, servedAs(draft)), false, 'cambia solo il commit');
  assert.equal(releaseDiffers(live, servedAs(live)), false, 'stessi stati, stessi file');
  assert.equal(releaseDiffers(live, { state: 'absent' }), true, 'accensione');
  assert.equal(releaseDiffers(live, servedAs(draft)), true, 'accensione');
  assert.equal(releaseDiffers(draft, servedAs(live)), true, 'spegnimento');
  assert.equal(releaseDiffers(retired, servedAs(live)), true, 'ritiro');
  // Stessi stati ma una sitemap con byte diversi: il Worker la servirebbe vecchia.
  const refreshed = planRelease(fakeDist(withLive(['canton-ti']), { salt: ' v2' }));
  assert.equal(releaseDiffers(refreshed, servedAs(live)), true);
  // Stato precedente non dimostrato: sempre, anche per una release tutta draft.
  assert.equal(releaseDiffers(draft, { state: 'unknown' }), true);
  assert.equal(releaseDiffers(draft, undefined), true);
  // Puntatore pre-protocollo con una sezione live e nessuna `release`: illeggibile.
  assert.equal(declaredFiles(withLive(['canton-ti'])), null);
  assert.deepEqual(declaredFiles(DRAFT_ALL()), {});
  assert.equal(declaredFiles({ ...live.pointer, release: { ...live.pointer.release, base: 'edge/sitemap/' } }), null);
  assert.equal(declaredFiles({ ...live.pointer, release: { ...live.pointer.release, files: { '../x': { sha256: 'f'.repeat(64) } } } }), null);
});

test('edge: la release servita e\' NOTA solo se ogni file dichiarato c\'e\' con il suo sha256', async () => {
  const seeded = async (seed) => {
    const io = fakeIo();
    seedPages(io, ['canton-ti']);
    await publishRelease(planRelease(fakeDist(withLive(['canton-ti'], OLD))), { io, env: CREDS, log: () => {}, bootstrapWaitMs: 0 });
    seed(io);
    return io;
  };
  const oldBase = `edge/sections/_releases/${OLD}/`;
  assert.equal((await readPreviousRelease(await seeded(() => {}))).state, 'ok');
  assert.equal((await readPreviousRelease(fakeIo())).state, 'absent');
  for (const [what, seed] of [
    ['sitemap mancante', (io) => io.store.delete(`${oldBase}sitemap-articles-canton-ti.xml`)],
    ['sitemap corrotta', (io) => io.store.set(`${oldBase}sitemap-articles-canton-ti.xml`, Buffer.from('altro'))],
    ['indice mancante', (io) => io.store.delete(`${oldBase}sitemap-cantons.xml`)],
    ['puntatore fuori contratto', (io) => io.store.set(EDGE_SECTION_REGISTRY_FILE, Buffer.from(JSON.stringify({ schema: 2, commit: OLD, sections: {} })))],
    ['puntatore non JSON', (io) => io.store.set(EDGE_SECTION_REGISTRY_FILE, Buffer.from('<html>'))],
    ['puntatore live senza release', (io) => io.store.set(EDGE_SECTION_REGISTRY_FILE, Buffer.from(JSON.stringify(withLive(['canton-ti'], OLD))))],
  ]) {
    assert.equal((await readPreviousRelease(await seeded(seed))).state, 'unknown', what);
    // Con uno stato non dimostrato un guasto ferma SEMPRE il publish, anche se la release e' la stessa o tutta draft.
    for (const next of [withLive(['canton-ti']), DRAFT_ALL()]) {
      const failed = await publish(next, { history: [withLive(['canton-ti'], OLD)], seed, fail: (op, key) => op === 'upload' });
      assert.equal(failed.result.code, 1, what);
      assert.match(failed.logs.join('\n'), /release su R2 unknown; push OBBLIGATORIO/, what);
    }
    // Senza guasti la pubblicazione ripara: il nuovo puntatore serve file verificati.
    const healed = await publish(withLive(['canton-ti']), { history: [withLive(['canton-ti'], OLD)], seed });
    assert.equal(healed.result.code, 0, what);
    assert.equal((await readPreviousRelease(healed.io)).state, 'ok', what);
  }
  // CDN illeggibile.
  const io = await seeded(() => {});
  io.fail = (op) => op === 'fetch';
  assert.equal((await readPreviousRelease(io)).state, 'unknown');
});

test('edge: ogni fallimento PRIMA del PUT lascia servita la release di prima, intera — in accensione, spegnimento e refresh', async () => {
  const cases = [
    ['accensione', withLive(['canton-ti']), DRAFT_ALL(OLD), {}],
    ['spegnimento', DRAFT_ALL(), withLive(['canton-ti'], OLD), {}],
    ['due sezioni', withLive(['canton-ti', 'canton-gr']), withLive(['canton-ti'], OLD), {}],
    ['refresh dei byte', withLive(['canton-ti']), withLive(['canton-ti'], OLD), { salt: ' v2' }],
  ];
  // Fabbriche, non oggetti: ogni caso ha i suoi contatori.
  const failures = [
    ['staging: upload', () => ({ fail: (op, key) => op === 'upload' && key.includes(`/_releases/${COMMIT}/`) })],
    ['staging: secondo upload', () => { let n = 0; return { fail: (op, key) => op === 'upload' && key.includes(`/_releases/${COMMIT}/`) && ++n === 2 }; }],
    ['staging: byte non corrispondenti', () => ({ corrupt: (key) => key.includes(`/_releases/${COMMIT}/`) })],
    ['staging: CDN illeggibile', () => ({ fail: (op, key) => op === 'fetch' && key.includes(`/_releases/${COMMIT}/`) })],
    ['flip: puntatore', () => ({ fail: (op, key) => op === 'upload' && key === 'edge/sections/registry.json' })],
  ];
  for (const [direction, next, previous, extra] of cases) {
    for (const [what, hooks] of failures) {
      const { io, logs, before, result } = await publish(next, { history: [previous], ...extra, ...hooks() });
      const staged = planRelease(fakeDist(next)).files.length;
      if (staged === 0 && what.startsWith('staging')) continue; // release senza file: lo staging non ha niente da fare
      if (staged < 2 && what === 'staging: secondo upload') continue;
      assert.equal(result.code, 1, `${direction} / ${what}: il push e' obbligatorio`);
      assert.equal(result.flipped, false, `${direction} / ${what}`);
      assert.equal(served(io), before, `${direction} / ${what}: stato E file serviti devono restare quelli di prima`);
      assert.equal(pointerOf(io).commit, OLD, `${direction} / ${what}`);
      assert.match(logs.join('\n'), /::error::\[section-edge\].*il Worker serve la release di prima, intera; il publish si ferma/);
    }
  }
});

test('edge: il puntatore non gira finche\' OGNI URL che le sitemap annunciano non e\' su R2', async () => {
  // Ogni URL annunciato: le <loc> E gli href degli alternate (un articolo ha la loc in IT e le altre tre lingue solo li').
  const all = requiredPageKeys('canton-ti', { sitemapXml: sitemapOf('canton-ti') });
  assert.equal(all.length, (1 + 6 + 1) * 4 + 1 + 4);
  for (const key of [
    'edge/sections/articoli-ticino/index.html', 'edge/sections/en/ticino-articles/fuel/index.html', 'edge/sections/de/tessin-artikel/alle/index.html',
    'edge/sections/articoli-ticino/tutti/page-2/index.html', 'edge/sections/articoli-ticino/un-articolo/index.html',
    'edge/sections/en/ticino-articles/un-articolo-en/index.html', 'edge/sections/fr/articles-tessin/un-articolo-fr/index.html',
  ]) {
    assert.ok(all.includes(key), key);
  }
  assert.deepEqual([...sitemapPaths('<url><loc>https://frontaliereticino.ch/a/</loc><xhtml:link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/a/" /></url>')], ['/a/', '/en/a/']);
  assert.throws(() => requiredPageKeys('canton-ti', {}), /serve la sitemap/);
  assert.throws(() => requiredPageKeys('canton-ti', { sitemapXml: '<loc>https://evil.example/x/</loc>' }), /fuori dall'apex/);
  assert.throws(() => requiredPageKeys('canton-ti', { sitemapXml: '<xhtml:link hreflang="en" href="https://evil.example/x/" />' }), /fuori dall'apex/);
  // Sezione gia' live: solo gli URL nuovi rispetto alla sitemap servita, piu' le 4 landing.
  assert.deepEqual(requiredPageKeys('canton-ti', { sitemapXml: sitemapOf('canton-ti', '', ['nuovo']), previousSitemapXml: sitemapOf('canton-ti') }).sort(), [
    'edge/sections/articoli-ticino/index.html', 'edge/sections/en/ticino-articles/index.html',
    'edge/sections/de/tessin-artikel/index.html', 'edge/sections/fr/articles-tessin/index.html',
    'edge/sections/articoli-ticino/nuovo/index.html', 'edge/sections/en/ticino-articles/nuovo-en/index.html',
    'edge/sections/de/tessin-artikel/nuovo-de/index.html', 'edge/sections/fr/articles-tessin/nuovo-fr/index.html',
  ].sort());

  // ACCENSIONE senza le pagine, o con una sola mancante, o con una pagina senza il meta di proprieta': niente flip.
  for (const [what, opts] of [
    ['nessuna pagina', { bootstrap: false }],
    ['un hub mancante', { seed: (io) => io.store.delete('edge/sections/fr/articles-tessin/fiscalite/index.html') }],
    ['una page-N dell\'archivio mancante', { seed: (io) => io.store.delete('edge/sections/articoli-ticino/tutti/page-2/index.html') }],
    ['un articolo mancante', { seed: (io) => io.store.delete('edge/sections/articoli-ticino/un-articolo/index.html') }],
    ['la traduzione di un articolo mancante (solo negli alternate)', { seed: (io) => io.store.delete('edge/sections/de/tessin-artikel/un-articolo-de/index.html') }],
    ['landing senza ft-route-owner', { seed: (io) => io.store.set('edge/sections/articoli-ticino/index.html', Buffer.from('<html></html>')) }],
  ]) {
    const { io, logs, before, result } = await publish(withLive(['canton-ti']), { history: [DRAFT_ALL(OLD)], ...opts });
    assert.deepEqual([result.code, result.phase, result.flipped], [1, 'bootstrap', false], what);
    assert.equal(served(io), before, `${what}: la sezione resta com'era`);
    assert.match(logs.join('\n'), /pagine annunciate dalle sitemap delle sezioni live non sono su R2/);
    // I file caricati in staging non sono puntati da niente: vengono tolti.
    assert.ok(![...io.store.keys()].some((key) => !key.startsWith('cc:') && key.includes(`/_releases/${COMMIT}/`)), `${what}: staging ripulito`);
  }

  // SEZIONE GIA' LIVE con un articolo nuovo nella sitemap: le sue 4 pagine devono esserci prima del flip.
  const newArticle = { history: [withLive(['canton-ti'], OLD)], extraArticles: ['nuovo'] };
  const early = await publish(withLive(['canton-ti']), newArticle);
  assert.deepEqual([early.result.code, early.result.phase, early.result.flipped], [1, 'bootstrap', false], 'la sitemap non annuncia un articolo che R2 non ha');
  assert.equal(served(early.io), early.before);
  const seedNew = (io, locales) => {
    for (const [l, base] of [['it', 'articoli-ticino/nuovo'], ['en', 'en/ticino-articles/nuovo-en'], ['de', 'de/tessin-artikel/nuovo-de'], ['fr', 'fr/articles-tessin/nuovo-fr']]) {
      if (locales.includes(l)) io.store.set(`edge/sections/${base}/index.html`, Buffer.from(`<html><head>${CORPUS_ROUTE_OWNER_META_TAG}</head></html>`));
    }
  };
  const partial = await publish(withLive(['canton-ti']), { ...newArticle, seed: (io) => seedNew(io, ['it', 'en', 'de']) });
  assert.equal(partial.result.phase, 'bootstrap', 'una sola lingua mancante basta a fermare il flip');
  const ready = await publish(withLive(['canton-ti']), { ...newArticle, seed: (io) => seedNew(io, ['it', 'en', 'de', 'fr']) });
  assert.deepEqual([ready.result.code, ready.result.phase], [0, 'done']);
  // fast-publish-section parte dallo stesso push e puo' finire dopo: le pagine mancanti si riprovano.
  let waits = 0;
  let lateIo;
  const late = await publish(withLive(['canton-ti']), {
    ...newArticle,
    seed: (io) => { lateIo = io; },
    bootstrapWaitMs: 60_000,
    sleep: async () => { waits += 1; if (waits === 2) seedNew(lateIo, ['it', 'en', 'de', 'fr']); },
  });
  assert.deepEqual([late.result.code, late.result.phase, waits], [0, 'done', 2]);
  // Una pagina vecchia sparita (non nuova nella sitemap) non ferma la pubblicazione delle altre: la riconcilia il reconcile.
  const kept = await publish(withLive(['canton-ti']), {
    history: [withLive(['canton-ti'], OLD)],
    salt: ' v2',
    seed: (io) => io.store.delete('edge/sections/fr/articles-tessin/fiscalite/index.html'),
  });
  assert.equal(kept.result.code, 0);
  const lost = await publish(withLive(['canton-ti']), {
    history: [withLive(['canton-ti'], OLD)],
    salt: ' v2',
    seed: (io) => io.store.delete('edge/sections/articoli-ticino/index.html'),
  });
  assert.deepEqual([lost.result.code, lost.result.phase], [1, 'bootstrap']);
});

test('edge: dopo il PUT la release nuova e\' servita intera; un purge fallito esce non-zero senza incoerenze', async () => {
  const { io, logs, result } = await publish(DRAFT_ALL(), { history: [withLive(['canton-ti'], OLD)], fail: (op) => op === 'purge' });
  assert.deepEqual([result.code, result.phase, result.flipped], [1, 'purge', true]);
  assert.equal(served(io), JSON.stringify({ state: registryState(DRAFT_ALL()), files: {} }), 'spegnimento arrivato: nessuna sitemap, nessun indice');
  assert.match(logs.join('\n'), /il Worker serve la release nuova, intera/);
  // Lo spegnimento purga anche le URL apex della sitemap e dell'indice che la release di prima esponeva.
  const off = await publish(DRAFT_ALL(), { history: [withLive(['canton-ti'], OLD)] });
  assert.equal(off.result.code, 0);
  assert.deepEqual([...off.io.purged].sort(), [
    'https://cdn.frontaliereticino.ch/edge/sections/registry.json',
    'https://frontaliereticino.ch/sitemap-articles-canton-ti.xml',
    'https://frontaliereticino.ch/sitemap-cantons.xml',
  ].sort());
});

test('edge: pulizia best-effort — mai la release puntata, mai la precedente', async () => {
  const { io, result } = await publish(withLive(['canton-ti']), { history: [withLive(['canton-ti'], OLDER), withLive(['canton-gr'], OLD)] });
  assert.equal(result.code, 0);
  const keys = [...io.store.keys()].filter((key) => key.includes('/_releases/')).filter((key) => !key.startsWith('cc:'));
  assert.ok(keys.some((key) => key.includes(`/_releases/${COMMIT}/`)), 'la release puntata resta');
  assert.ok(keys.some((key) => key.includes(`/_releases/${OLD}/`)), 'la precedente resta (una richiesta in volo puo\' leggerla)');
  assert.ok(!keys.some((key) => key.includes(`/_releases/${OLDER}/`)), 'quella ancora prima viene ripulita');
  assert.deepEqual(io.ops.filter((op) => op.startsWith('del ')), [
    `del edge/sections/_releases/${OLDER}/sitemap-articles-canton-ti.xml`,
    `del edge/sections/_releases/${OLDER}/sitemap-cantons.xml`,
  ]);
  assert.deepEqual(pointerOf(io).release.previous, { base: `edge/sections/_releases/${OLD}/`, files: ['sitemap-articles-canton-gr.xml', 'sitemap-cantons.xml'] });
  // Una pulizia fallita non e' un fallimento della pubblicazione.
  const stuck = await publish(withLive(['canton-ti']), { history: [withLive(['canton-ti'], OLDER), withLive(['canton-gr'], OLD)], fail: (op) => op === 'remove' });
  assert.equal(stuck.result.code, 0);
  // Un `previous` manomesso nel puntatore servito non diventa un elenco di chiavi da cancellare.
  const dirty = await publish(withLive(['canton-ti']), {
    history: [DRAFT_ALL(OLD)],
    seed: (io2) => {
      const pointer = pointerOf(io2);
      pointer.release.previous = { base: 'edge/sections/', files: ['registry.json', '../../x'] };
      io2.store.set(EDGE_SECTION_REGISTRY_FILE, Buffer.from(JSON.stringify(pointer)));
    },
  });
  assert.deepEqual(dirty.io.ops.filter((op) => op.startsWith('del ')), []);
});

test('edge: se niente di servito cambia un problema di R2 non ferma gli articoli; con un cambio, le credenziali sono obbligatorie', async () => {
  const same = await publish(DRAFT_ALL(), { history: [DRAFT_ALL(OLD)], fail: (op) => op === 'upload' });
  assert.equal(same.result.code, 0);
  assert.match(same.logs.join('\n'), /release su R2 ok; push facoltativo/);
  assert.match(same.logs.join('\n'), /::warning::\[section-edge\].*il publish prosegue/);
  // Mai pubblicato, tutto draft (oggi), senza credenziali: warning, niente caricato.
  const noCredsSame = await publish(DRAFT_ALL(), {}, {});
  assert.deepEqual([noCredsSame.result.code, noCredsSame.io.ops], [0, []]);
  const noCredsOff = await publish(DRAFT_ALL(), { history: [withLive(['canton-ti'], OLD)] }, {});
  assert.deepEqual([noCredsOff.result.code, noCredsOff.io.ops], [1, []], 'uno spegnimento senza credenziali ferma il publish');
  // CDN illeggibile e nessuna credenziale: stato non dimostrato, quindi stop — mai exit 0.
  const blind = await publish(DRAFT_ALL(), { fail: (op) => op === 'fetch' }, {});
  assert.deepEqual([blind.result.code, blind.io.ops], [1, []]);
});

test('edge: CLI — senza registro in dist nessuna release; argomenti malformati rifiutati', async () => {
  const logs = [];
  const none = mkdtempSync(path.join(tmpdir(), 'no-edge-'));
  assert.equal(await edgeMain(['--dist', none], { env: {}, io: fakeIo(), log: (l) => logs.push(l) }), 0);
  assert.match(logs.join('\n'), /nessuna release/);
  await assert.rejects(edgeMain(['--dist'], { log: () => {} }), /--dist richiede/);
  await assert.rejects(edgeMain(['--boh'], { log: () => {} }), /sconosciuti/);
  await assert.rejects(edgeMain(['--dry-run', '--dry-run'], { log: () => {} }), /una volta sola/);
  await assert.rejects(edgeMain(['--dist', path.join(none, 'non-esiste')], { log: () => {} }), /cartella inesistente/);
  const dry = [];
  assert.equal(await edgeMain(['--dist', fakeDist(DRAFT_ALL()), '--dry-run'], { io: fakeIo(), log: (l) => dry.push(l) }), 0);
  assert.equal(JSON.parse(dry.join('')).base, `edge/sections/_releases/${COMMIT}/`);
});

test('edge: purge a blocchi da 30 senza duplicati', () => {
  const urls = Array.from({ length: 65 }, (_, i) => `https://x/${i % 61}`);
  const chunks = purgeChunks(urls);
  assert.deepEqual(chunks.map((c) => c.length), [30, 30, 1]);
  assert.throws(() => purgeChunks(urls, 0), /size non valido/);
  assert.throws(() => purgeChunks(urls, -1), /size non valido/);
  assert.throws(() => buildSitemapIndex(null), /atteso un array/);
});

test('sitemap di sezione: le pagine d\'archivio si contano sull\'unione del renderer (meta IT ∪ mappa slug)', () => {
  assert.equal(archiveUnionSize({ 'blog.article.a.title': 'A', 'blog.article.b.title': 'B', 'blog.article.a.excerpt': 'x' }, { b: {}, c: {} }), 3);
  assert.equal(archiveUnionSize(undefined, undefined), 0);
  // 3 id nell'unione ma un solo articolo con slug IT: l'archivio ha 2 pagine (pageSize 2), e la sitemap le elenca entrambe.
  const built = buildFamilySectionSitemap({
    section: 'canton-ti',
    entries: [{ id: 'a', date: '2026-10-01' }, { id: 'b', date: '2026-10-01' }],
    slugMap: { a: { it: 'a-it' }, c: { en: 'c-en' } },
    meta: { 'blog.article.a.title': 'A', 'blog.article.b.title': 'B' },
    pageSize: 2,
  });
  assert.equal(built.articleCount, 1);
  assert.ok(built.xml.includes('<loc>https://frontaliereticino.ch/articoli-ticino/tutti/page-2/</loc>'));
});

test('build-api: il pavimento RSS di famiglia ha il corpus come riferimento, non il parser del feed', () => {
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  assert.match(build, /familyRssRows\.push\(\{ section: section\.id, source: countSourceArticles\(ROOT, section\.id\), emitted: sectionItems \}\)/);
  assert.doesNotMatch(build, /source: section\.articleCount/);
});

test('delete-cdn-file.sh: solo chiavi delle sezioni cantonali', () => {
  const run = (key) => spawnSync('bash', [path.join(ROOT, 'scripts/lib/delete-cdn-file.sh'), key], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  for (const bad of ['data/blog-index-svizzera-it.json', 'edge/sitemap-blog.xml', 'edge/sitemap-cantons.xml', 'edge/sitemap-articles-canton-ti.xml', 'edge/sections/../rss.xml', 'images/x.webp']) {
    assert.equal(run(bad).status, 1, bad);
  }
  for (const ok of ['edge/sections/registry.json', `edge/sections/_releases/${COMMIT}/sitemap-cantons.xml`, `/edge/sections/_releases/${COMMIT}/sitemap-articles-canton-ti.xml`]) {
    const res = run(ok);
    assert.equal(res.status, 0, ok);
    assert.match(res.stdout, /credentials missing/, 'senza credenziali non tocca niente');
  }
});

// ── 7. Cablaggio ─────────────────────────────────────────────────────────────

test('load-rc-env: kill-switch mappato, assente per default, marker scritto solo dopo il template', async () => {
  const src = readFileSync(path.join(ROOT, 'generator/scripts/load-rc-env.mjs'), 'utf8');
  assert.match(src, /^ {2}CANTON_ARTICLE_SECTIONS_KILL: +\['CANTON_ARTICLE_SECTIONS_KILL'\],$/m);
  const { EXPECTED_ABSENT_RC_KEYS, RC_LOADED_MARKER } = await import('../../generator/scripts/load-rc-env.mjs');
  assert.ok(EXPECTED_ABSENT_RC_KEYS.has('CANTON_ARTICLE_SECTIONS_KILL'));
  assert.equal(RC_LOADED_MARKER, 'RC_ENV_LOADED');
  const main = src.slice(src.indexOf('async function main()'));
  const templateAt = main.indexOf('const paramCount');
  const markerAt = main.indexOf('lines.push(isCI ? `${RC_LOADED_MARKER}=1`');
  assert.ok(templateAt > 0 && markerAt > templateAt, 'il marker va scritto solo dopo aver letto il template');
});

test('publish-api: osserva tutta la chiusura degli import del publisher, e pubblica la release edge DOPO il deploy Pages, per ultima', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  const filters = [...wf.slice(0, wf.indexOf('\n  schedule:')).matchAll(/^      - '([^']+)'$/gm)].map((m) => m[1]);
  const covered = (file) => filters.some((p) => p === file || (p.endsWith('/**') && file.startsWith(p.slice(0, -2))));
  for (const p of ['sections/**', 'scripts/lib/section-registry.mjs', 'scripts/publish-section-edge.mjs', 'scripts/lib/delete-cdn-file.sh', 'generator/scripts/load-rc-env.mjs']) {
    assert.ok(filters.includes(p), p);
  }
  // La chiusura degli import (statici e dinamici, relativi) dei quattro
  // entrypoint del publisher: un modulo importato e non osservato e' un fix
  // che non ripubblica.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !existsSync(path.join(ROOT, file))) return;
    seen.add(file);
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.normalize(path.join(path.dirname(file), m[1]));
      if (path.extname(target)) walk(target);
    }
  };
  for (const entry of ['scripts/build-api.mjs', 'scripts/build-blog-index.mjs', 'scripts/publish-section-edge.mjs', 'scripts/ci/verify-api-floors.mjs']) walk(entry);
  // Piu' cio' che publish-section-edge ESEGUE (non importa): gli script che lancia, e i loro import.
  const edge = readFileSync(path.join(ROOT, 'scripts/publish-section-edge.mjs'), 'utf8');
  const realIoSrc = edge.slice(edge.indexOf('export const realIo = {'), edge.indexOf('/** Quanto si aspetta'));
  const spawned = [...realIoSrc.matchAll(/'(scripts\/[A-Za-z0-9_\/.-]+\.(?:sh|mjs))'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(spawned)].sort(), ['scripts/cf-purge-cache.mjs', 'scripts/ci/retry-cmd.sh', 'scripts/lib/delete-cdn-file.sh', 'scripts/lib/upload-cdn-file.sh']);
  for (const file of spawned) walk(file);
  assert.ok(seen.size > 20, 'la chiusura e\' vuota: il test sarebbe vacuo');
  assert.deepEqual([...seen].filter((file) => !covered(file)).sort(), [], 'moduli importati dal publisher e non osservati da on.push.paths');

  // DOPO il deploy Pages (le superfici di famiglia escono con Pages) e per
  // ultimo: se fallisce non salta ne' le sitemap blog ne' la notifica al sito.
  const at = wf.indexOf('      - name: Publish the canton sections release to the edge\n');
  assert.ok(at > wf.indexOf('uses: actions/deploy-pages'));
  assert.ok(at > wf.indexOf('- name: Notify the site'));
  assert.equal(wf.slice(at).trimEnd(), [
    '      - name: Publish the canton sections release to the edge',
    "        if: steps.deploy.outcome == 'success'",
    '        run: node scripts/publish-section-edge.mjs',
  ].join('\n'));
  // Il build gira dopo il caricamento di Remote Config: il kill-switch e il marker sono nell'ambiente.
  assert.ok(wf.indexOf('node generator/scripts/load-rc-env.mjs') < wf.indexOf('scripts/build-api.mjs\n'));
  assert.match(wf, /for f in articles\.json slugs\.json manifest\.json sections\.json; do/);
});
