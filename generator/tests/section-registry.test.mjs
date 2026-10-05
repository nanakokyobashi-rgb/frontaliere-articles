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
import { edgePushIsMandatory, planSectionEdge, purgeChunks, registryState } from '../../scripts/publish-section-edge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMIT = 'ce0973785b6fff2ce470b7f7dcba7c1ebdb9dd48';
const clone = (value) => JSON.parse(JSON.stringify(value));
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
  assert.deepEqual(eff['canton-ti'], { declared: 'live', status: 'draft', killed: true, held: false });
  assert.deepEqual(eff['canton-gr'], { declared: 'retired', status: 'retired', killed: false, held: false });
  assert.deepEqual(eff['canton-be'], { declared: 'live', status: 'live', killed: false, held: false });
  // Senza verifica nessuna sezione dichiarata live esce live: il catalogo non
  // deve andare avanti rispetto al registro che il Worker ha su R2.
  const unverified = effectiveStatuses(doc, resolveKillSwitch({ CANTON_ARTICLE_SECTIONS_KILL: 'TI' }));
  assert.deepEqual(unverified['canton-ti'], { declared: 'live', status: 'draft', killed: true, held: false });
  assert.deepEqual(unverified['canton-be'], { declared: 'live', status: 'draft', killed: false, held: true });
  assert.deepEqual(unverified['canton-gr'], { declared: 'retired', status: 'retired', killed: false, held: false });
  const held = buildSectionsCatalog({ declared: doc, effective: unverified, killSwitch: { state: 'unverified', unknown: [] },
    commit: COMMIT, sitemapOf: () => { throw new Error('nessuna sezione live: non va chiesta nessuna sitemap'); } });
  assert.deepEqual(held.killSwitch, { state: 'unverified', applied: ['canton-ti'], held: ['canton-be'], unknown: [] });
  assert.ok(held.sections.every((entry) => entry.status !== 'live' && entry.sitemap === null));
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

test('catalogo sections.json: stato effettivo, percorsi, temi, sitemap solo se live', () => {
  const doc = committed();
  doc.sections['canton-ti'].status = 'live';
  const ks = { state: 'verified', sections: [], unknown: [] };
  const catalog = buildSectionsCatalog({
    declared: doc,
    effective: effectiveStatuses(doc, ks),
    killSwitch: ks,
    commit: COMMIT,
    articles: { 'canton-ti': 3 },
    sitemapOf: (id) => `sitemap-articles-${id}.xml`,
  });
  assert.equal(catalog.sections.length, 24);
  const ti = catalog.sections.find((entry) => entry.id === 'canton-ti');
  assert.deepEqual(ti.paths, { it: '/articoli-ticino/', en: '/en/ticino-articles/', de: '/de/tessin-artikel/', fr: '/fr/articles-tessin/' });
  assert.deepEqual(ti.topics.map((t) => t.id), ['carburanti', 'fisco', 'mobilita', 'eventi', 'pensioni', 'servizi']);
  assert.equal(ti.sitemap, '/sitemap-articles-canton-ti.xml');
  assert.deepEqual(ti.counts, { articles: 3 });
  assert.equal(catalog.sections.find((entry) => entry.id === 'canton-gr').sitemap, null);
  assert.deepEqual(catalog.killSwitch, { state: 'verified', applied: [], held: [], unknown: [] });
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

// ── 6. Pubblicazione su R2 ───────────────────────────────────────────────────

function fakeDist({ live = [], index = true, edge = true }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'section-edge-'));
  const sections = registrySectionIds().map((id) => ({
    id,
    status: live.includes(id) ? 'live' : 'draft',
    sitemap: live.includes(id) ? `/sitemap-articles-${id}.xml` : null,
  }));
  writeFileSync(path.join(dir, 'sections.json'), JSON.stringify({ schema: 1, sections }));
  for (const id of live) writeFileSync(path.join(dir, `sitemap-articles-${id}.xml`), '<urlset/>');
  if (live.length && index) writeFileSync(path.join(dir, 'sitemap-cantons.xml'), '<sitemapindex/>');
  if (edge) {
    mkdirSync(path.join(dir, 'edge/sections'), { recursive: true });
    writeFileSync(path.join(dir, EDGE_SECTION_REGISTRY_FILE), '{}');
  }
  return dir;
}

test('edge: nessuna sezione live → registro e poi cancellazione dell\'indice', () => {
  // (ordine comune a tutti i casi: l'indice si tocca solo DOPO il registro)
  const { ops } = planSectionEdge(fakeDist({}));
  assert.deepEqual(ops.map((op) => [op.op, op.key]), [
    ['upload', 'edge/sections/registry.json'],
    ['delete', 'edge/sitemap-cantons.xml'],
  ]);
  assert.deepEqual(ops[0].purge, ['https://cdn.frontaliereticino.ch/edge/sections/registry.json']);
  assert.equal(ops[0].cacheControl, 'public,max-age=60');
  assert.deepEqual(ops[1].purge, ['https://frontaliereticino.ch/sitemap-cantons.xml', 'https://cdn.frontaliereticino.ch/edge/sitemap-cantons.xml']);
});

test('edge: sezioni live → sitemap, registro, indice solo dopo il registro', () => {
  const { ops } = planSectionEdge(fakeDist({ live: ['canton-ti', 'canton-gr'] }));
  assert.deepEqual(ops.map((op) => [op.op, op.key]), [
    ['upload', 'edge/sitemap-articles-canton-gr.xml'],
    ['upload', 'edge/sitemap-articles-canton-ti.xml'],
    ['upload', 'edge/sections/registry.json'],
    ['upload', 'edge/sitemap-cantons.xml'],
  ]);
  // Un indice nuovo sopra un registro vecchio annuncerebbe sitemap non servite:
  // l'esecutore si ferma al registro non confermato, prima dell'indice.
  const src = readFileSync(path.join(ROOT, 'scripts/publish-section-edge.mjs'), 'utf8');
  assert.match(src, /if \(op\.registry\) break;/);
  assert.match(src, /if \(op\.registry && failures > 0\) \{[\s\S]*?break;/);
  assert.ok(ops[0].purge.includes('https://frontaliereticino.ch/sitemap-articles-canton-gr.xml'));
  assert.ok(ops[0].purge.includes('https://cdn.frontaliereticino.ch/edge/sitemap-articles-canton-gr.xml'));
});

test('edge: registro non emesso (kill-switch non verificato) → registro e indice su R2 intatti', () => {
  const { ops, notes } = planSectionEdge(fakeDist({ live: ['canton-ti'], edge: false }));
  assert.deepEqual(ops.map((op) => [op.op, op.key]), [['upload', 'edge/sitemap-articles-canton-ti.xml']]);
  assert.match(notes.join('\n'), /non emesso/);
});

test('edge: una sezione live senza la sua sitemap e\' un errore, non un upload mancato', () => {
  const dir = fakeDist({ live: ['canton-ti'] });
  rmSync(path.join(dir, 'sitemap-articles-canton-ti.xml'));
  assert.throws(() => planSectionEdge(dir), /live ma sitemap-articles-canton-ti\.xml manca/);
});

test('edge: obbligatorio quando lo stato delle sezioni cambia rispetto a R2, in entrambe le direzioni', () => {
  const draftAll = { schema: 1, commit: 'aaaaaaa', sections: Object.fromEntries(registrySectionIds().map((id) => [id, { status: 'draft' }])) };
  const tiLive = { schema: 1, commit: 'bbbbbbb', sections: { ...draftAll.sections, 'canton-ti': { status: 'live' } } };
  const withEdge = (dir, doc) => {
    writeFileSync(path.join(dir, EDGE_SECTION_REGISTRY_FILE), JSON.stringify(doc));
    return dir;
  };
  // Il commit non e' stato; una sezione assente vale draft.
  assert.equal(registryState(draftAll), registryState({ sections: {} }));
  assert.notEqual(registryState(tiLive), registryState(draftAll));
  assert.notEqual(
    registryState({ sections: { 'canton-ti': { status: 'live', gone: ['/articoli-ticino/x/'] } } }),
    registryState(tiLive),
  );

  const allDraft = withEdge(fakeDist({}), draftAll);
  assert.equal(edgePushIsMandatory(allDraft, { state: 'absent' }), false, 'oggi: tutto draft, mai pubblicato');
  assert.equal(edgePushIsMandatory(allDraft, { state: 'ok', doc: { ...draftAll, commit: 'ccccccc' } }), false, 'cambia solo il commit');
  assert.equal(edgePushIsMandatory(allDraft, { state: 'unknown' }), false);
  // SPEGNIMENTO: R2 serve ancora la sezione, il catalogo nuovo la direbbe draft.
  assert.equal(edgePushIsMandatory(allDraft, { state: 'ok', doc: tiLive }), true);
  // ACCENSIONE, e stato invariato a sezione live.
  const live = withEdge(fakeDist({ live: ['canton-ti'] }), tiLive);
  assert.equal(edgePushIsMandatory(live, { state: 'absent' }), true);
  assert.equal(edgePushIsMandatory(live, { state: 'ok', doc: draftAll }), true);
  assert.equal(edgePushIsMandatory(live, { state: 'ok', doc: { ...tiLive, commit: 'ddddddd' } }), false);
  // R2 illeggibile: non si puo' dimostrare che lo stato coincide.
  assert.equal(edgePushIsMandatory(live, { state: 'unknown' }), true);
  // Registro non emesso (kill-switch non verificato): niente da spingere.
  assert.equal(edgePushIsMandatory(fakeDist({ edge: false }), { state: 'ok', doc: tiLive }), false);

  // In un sottoprocesso: lo script parla su stdout, e un test non deve scrivere
  // sulla pipe dei frame del runner (scripts/ci/check-node-test-stdout.mjs).
  // `--previous` da' lo stato di R2 a mano: nessuna rete nel test.
  const edge = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/publish-section-edge.mjs'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  const prev = path.join(mkdtempSync(path.join(tmpdir(), 'prev-')), 'registry.json');
  writeFileSync(prev, JSON.stringify(tiLive));
  const refused = edge('--dist', allDraft, '--previous', prev);
  assert.equal(refused.status, 1, 'spegnimento senza credenziali: il publish si ferma');
  assert.match(refused.stdout, /push OBBLIGATORIO/);
  assert.match(refused.stdout, /::error::\[section-edge\] credenziali assenti.*il publish si ferma/);
  const tolerated = edge('--dist', allDraft, '--previous', 'absent');
  assert.equal(tolerated.status, 0);
  assert.match(tolerated.stdout, /::warning::\[section-edge\] credenziali assenti/);
  for (const [args, re] of [[['--dist'], /--dist richiede/], [['--boh'], /sconosciuti/], [['--dry-run', '--dry-run'], /una volta sola/]]) {
    const res = edge(...args);
    assert.equal(res.status, 1);
    assert.match(res.stderr, re);
  }
  // Un push riuscito a meta' ripristina il registro di prima.
  const src = readFileSync(path.join(ROOT, 'scripts/publish-section-edge.mjs'), 'utf8');
  assert.match(src, /if \(registryUploaded && mustSucceed\) \{[\s\S]*?rollbackRegistry\(previous, tmpDir\)/);
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

test('edge: purge a blocchi da 30 senza duplicati', () => {
  const urls = Array.from({ length: 65 }, (_, i) => `https://x/${i % 61}`);
  const chunks = purgeChunks(urls);
  assert.deepEqual(chunks.map((c) => c.length), [30, 30, 1]);
  assert.throws(() => purgeChunks(urls, 0), /size non valido/);
  assert.throws(() => purgeChunks(urls, -1), /size non valido/);
  assert.throws(() => buildSitemapIndex(null), /atteso un array/);
});

test('delete-cdn-file.sh: solo chiavi delle sezioni cantonali', () => {
  const run = (key) => spawnSync('bash', [path.join(ROOT, 'scripts/lib/delete-cdn-file.sh'), key], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  for (const bad of ['data/blog-index-svizzera-it.json', 'edge/sitemap-blog.xml', 'edge/sections/../rss.xml', 'images/x.webp']) {
    assert.equal(run(bad).status, 1, bad);
  }
  for (const ok of ['edge/sitemap-cantons.xml', '/edge/sitemap-articles-canton-ti.xml', 'edge/sections/registry.json']) {
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

test('publish-api: osserva il registro e spinge registro e sitemap cantonali dopo il deploy', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  for (const p of ['sections/**', 'scripts/lib/section-registry.mjs', 'scripts/publish-section-edge.mjs', 'scripts/lib/delete-cdn-file.sh', 'generator/scripts/load-rc-env.mjs']) {
    assert.ok(wf.includes(`      - '${p}'\n`), p);
  }
  // Prima del deploy Pages e senza continue-on-error: il catalogo (Pages) non
  // deve mai uscire prima del registro (R2) che descrive.
  const at = wf.indexOf('      - name: Push the section registry and the canton sitemaps to the edge\n');
  assert.ok(at > 0);
  assert.equal(wf.slice(at, wf.indexOf('\n\n', at)), '      - name: Push the section registry and the canton sitemaps to the edge\n        run: node scripts/publish-section-edge.mjs');
  assert.ok(at > wf.indexOf('- name: Verify artifact') && at < wf.indexOf('- uses: actions/configure-pages'));
  assert.ok(at < wf.indexOf('uses: actions/deploy-pages'));
  // Il build gira dopo il caricamento di Remote Config: il kill-switch e il marker sono nell'ambiente.
  assert.ok(wf.indexOf('node generator/scripts/load-rc-env.mjs') < wf.indexOf('scripts/build-api.mjs\n'));
  assert.match(wf, /for f in articles\.json slugs\.json manifest\.json sections\.json; do/);
});
