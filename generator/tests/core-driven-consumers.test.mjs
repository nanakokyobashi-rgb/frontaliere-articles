/**
 * I consumer del corpus derivano le sezioni dal core (piano «sezioni
 * cantonali», C1).
 *
 * Prima di C1 build-api, la sitemap, i pavimenti, l'indice runtime, il refresh
 * dell'hub, il fast-publish, il rebase del generatore e le guardie sui corpi
 * tenevano ciascuno la propria coppia frontaliere/svizzera scritta a mano. Ora
 * leggono `ARTICLE_SECTION_CORE` (lista ATTIVA) attraverso
 * `scripts/lib/corpus-sections.mjs`. Questo file prova due cose:
 *
 *   1. con le due sezioni storiche attive la derivazione da' ESATTAMENTE i
 *      valori che prima erano scritti a mano (nessun cambio di superficie);
 *   2. una sezione cantonale si comporta come deciso: pavimento 0 e verdetto
 *      di famiglia, errore esplicito dove la sua superficie non esiste ancora
 *      (API: P7, scritture di create-article: P6, shard Pages: mai).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARTICLE_SECTION_CORE_ALL,
  ARTICLE_SECTION_CORE_LIST,
} from '../../engine/shared/articleSectionCore.mjs';
import { RSS_SECTIONS } from '../../engine/rssFeeds.mjs';
import {
  API_SECTIONS,
  CORPUS_SECTIONS,
  KIND_FLOOR_POLICY,
  assertActiveSectionsPublishable,
  sectionApiSurfaces,
  sectionForBodyPath,
  sectionSourceSurfaces,
} from '../../scripts/lib/corpus-sections.mjs';
import { SECTION_PATHS } from '../../scripts/lib/build-sitemap.mjs';
import {
  SECTION_BODY_DIRS,
  SECTION_COUNTERS,
  SECTION_META_PREFIXES,
  SECTION_REGISTRY_FILES,
  SECTION_SITEMAPS,
  countSourceSitemapEntries,
  expectedBodyFiles,
  familyFloorVerdict,
  floorPolicyOf,
  sectionFloor,
} from '../../scripts/lib/corpus-floors.mjs';
import { SECTIONS as SURFACE_SECTIONS } from '../../scripts/lib/article-surfaces.mjs';
import { bodyRegex, sectionOf, shardOf } from '../../scripts/ci/fast-publish-section.mjs';
import { sectionRebaseArgs } from '../../scripts/ci/rebase-section-args.mjs';
import {
  BODY_ROOTS as LOCALE_BODY_ROOTS,
  inspectBlogLocaleCompleteness,
} from '../../scripts/ci/check-blog-locale-completeness.mjs';
import { SECTIONS as RECONCILE_SECTIONS } from '../../scripts/reconcile-article-shards.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const ACTIVE = ARTICLE_SECTION_CORE_LIST.map((core) => core.section);
const CANTON = ARTICLE_SECTION_CORE_ALL['canton-ti'];

// ── 1. Con la lista attiva di oggi, la derivazione e' la vecchia copia ────────

test('la lista attiva e\' quella delle due sezioni storiche (nessun cantone acceso)', () => {
  assert.deepEqual(ACTIVE, ['frontaliere', 'svizzera']);
  assert.ok(CANTON, 'il core deve conoscere canton-ti (inattiva) per provarne la regola');
  assert.deepEqual(CORPUS_SECTIONS.map((s) => s.section), ACTIVE);
  assert.deepEqual(API_SECTIONS.map((s) => s.section), ACTIVE);
});

test('i nomi pubblicati restano quelli storici', () => {
  assert.deepEqual(
    API_SECTIONS.map(({ section, api }) => [section, api.registry, api.metaFile('it'), api.slugsKey, api.reverseKey,
      api.counter, api.sitemap, api.sitemapCounter]),
    [
      ['frontaliere', 'articles.json', 'meta-it.json', 'blog', 'blogReverse', 'articles', 'sitemap-blog.xml', 'sitemapBlogUrls'],
      ['svizzera', 'swiss-articles.json', 'meta-ch-it.json', 'swiss', 'swissReverse', 'swissArticles', 'sitemap-blog-ch.xml', 'sitemapBlogChUrls'],
    ],
  );
});

test('le superfici sorgente derivate coincidono con le copie che sostituiscono', () => {
  const pick = (s) => [s.registryFile, s.registryExport, s.slugFile, s.slugExport, s.reverseExport,
    s.fallbackReasonsExport, s.metaFile('fr'), s.bodyDir, s.canonicalOverrides, s.shardKey];
  assert.deepEqual(pick(sectionSourceSurfaces('frontaliere')), [
    'content/blog-articles-data.ts', 'ARTICLES', 'content/routerBlogData.ts', 'BLOG_SLUGS', 'REVERSE_BLOG',
    'BLOG_SLUG_FALLBACK_REASONS', 'content/blog-meta-fr.ts', 'content/blog-body',
    'engine/shared/frontaliere-article-canonical-overrides.json', 'articolifrontaliere',
  ]);
  assert.deepEqual(pick(sectionSourceSurfaces('svizzera')), [
    'content/swiss-articles-data.ts', 'SWISS_ARTICLES', 'content/routerSwissData.ts', 'SWISS_SLUGS', 'REVERSE_SWISS',
    'SWISS_SLUG_FALLBACK_REASONS', 'content/blog-meta-ch-fr.ts', 'content/blog-body-ch',
    'content/swiss-article-canonical-overrides.json', 'articolisvizzera',
  ]);
});

test('build-sitemap: SECTION_PATHS derivati dal core = la vecchia tabella', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SECTION_PATHS)), {
    frontaliere: {
      it: '/articoli-frontaliere/', en: '/en/cross-border-articles/',
      de: '/de/grenzgaenger-artikel/', fr: '/fr/articles-frontalier/',
    },
    svizzera: {
      it: '/articoli-svizzera/', en: '/en/swiss-articles/', de: '/de/schweiz-artikel/', fr: '/fr/articles-suisse/',
    },
  });
});

test('corpus-floors: le mappe per sezione derivate = le vecchie tabelle', () => {
  assert.deepEqual({ ...SECTION_BODY_DIRS }, {
    frontaliere: path.join('content', 'blog-body', 'it'),
    svizzera: path.join('content', 'blog-body-ch', 'it'),
  });
  assert.deepEqual({ ...SECTION_COUNTERS }, { frontaliere: 'articles', svizzera: 'swissArticles' });
  assert.deepEqual({ ...SECTION_SITEMAPS }, { frontaliere: 'sitemap-blog.xml', svizzera: 'sitemap-blog-ch.xml' });
  assert.deepEqual({ ...SECTION_REGISTRY_FILES }, {
    frontaliere: path.join('content', 'blog-articles-data.ts'),
    svizzera: path.join('content', 'swiss-articles-data.ts'),
  });
  assert.deepEqual({ ...SECTION_META_PREFIXES }, { frontaliere: 'blog-meta-', svizzera: 'blog-meta-ch-' });
});

test('le radici dei corpi e gli shard da riconciliare vengono dal core', () => {
  assert.deepEqual(LOCALE_BODY_ROOTS.map((r) => [r.rel, r.name]), [
    ['content/blog-body', 'frontaliere'],
    ['content/blog-body-ch', 'svizzera'],
  ]);
  assert.deepEqual(RECONCILE_SECTIONS, [
    { section: 'frontaliere', shard: 'articolifrontaliere', slugsKey: 'blog' },
    { section: 'svizzera', shard: 'articolisvizzera', slugsKey: 'swiss' },
  ]);
  assert.deepEqual(Object.keys(SURFACE_SECTIONS), ACTIVE);
});

test('rebase: gli argomenti per sezione derivati = l\'elenco che generate-article.yml scriveva a mano', () => {
  assert.deepEqual(sectionRebaseArgs(SURFACE_SECTIONS), [
    'data/article-source-urls.json', 'data/article-source-quotas.json',
    'data/swiss-article-source-urls.json', 'data/swiss-article-source-quotas.json',
    ...[
      'content/blog-articles-data.ts', 'content/routerBlogData.ts', 'content/blogArticleIds.ts',
      'content/blog-meta-it.ts', 'content/blog-meta-en.ts', 'content/blog-meta-de.ts', 'content/blog-meta-fr.ts',
      'content/seo/seo-blog-5.ts',
      'content/swiss-articles-data.ts', 'content/routerSwissData.ts',
      'content/blog-meta-ch-it.ts', 'content/blog-meta-ch-en.ts', 'content/blog-meta-ch-de.ts', 'content/blog-meta-ch-fr.ts',
      'content/seo/seo-blog-ch.ts',
    ].flatMap((p) => ['--merge-registry', p]),
    ...['content/blog-body/', 'data/blog-articles/', 'content/blog-body-ch/', 'data/swiss-articles/']
      .flatMap((p) => ['--take-theirs', p]),
  ]);
});

test('rebase: una sezione senza una superficie di scrittura e\' un errore, non un buco', () => {
  const broken = { ...SURFACE_SECTIONS, 'canton-xx': { ...SURFACE_SECTIONS.svizzera, sourceLedger: undefined } };
  assert.throws(() => sectionRebaseArgs(broken), /canton-xx.*sourceLedger/);
  assert.throws(() => sectionRebaseArgs({}), /nessuna sezione attiva/);
});

test('rebase: generate-article.yml passa --section-surfaces e non ricopia i path per sezione', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/generate-article.yml'), 'utf8');
  assert.match(wf, /bash scripts\/lib\/rebase-onto-remote\.sh[\s\S]*?--section-surfaces \\/);
  assert.doesNotMatch(wf, /--merge-registry content\/swiss-articles-data\.ts/);
  assert.doesNotMatch(wf, /--take-theirs content\/blog-body-ch\//);
});

test('fast-publish: regex dei corpi, sezione e shard dal core', () => {
  assert.equal(bodyRegex(), '^content/(blog-body|blog-body-ch)/[a-z]{2}/.+\\.ts$');
  const re = new RegExp(bodyRegex());
  assert.ok(re.test('content/blog-body-ch/de/un-articolo.ts'));
  assert.ok(!re.test('content/blog-meta-it.ts'));
  assert.equal(sectionOf('content/blog-body/it/a.ts'), 'frontaliere');
  assert.equal(sectionOf('content/blog-body-ch/fr/b.ts'), 'svizzera');
  assert.throws(() => sectionOf('content/blog-body-canton-ti/it/c.ts'), /nessuna sezione attiva/);
  assert.equal(shardOf('frontaliere'), 'articolifrontaliere');
  assert.equal(shardOf('svizzera'), 'articolisvizzera');
  assert.throws(() => shardOf('canton-ti'), /non attiva/);
  assert.throws(() => shardOf('svizera'), /non attiva/);
});

test('fast-publish: una sezione cantonale attiva non ripiega sullo shard di un\'altra', () => {
  const withCanton = [...ARTICLE_SECTION_CORE_LIST, CANTON];
  assert.equal(sectionOf('content/blog-body-canton-ti/it/c.ts', withCanton), 'canton-ti');
  assert.match(bodyRegex(withCanton), /\|blog-body-canton-ti\)/);
  assert.throws(() => shardOf('canton-ti', withCanton), /non ha uno shard Pages.*R2.*P7/s);
  const cli = (args) => {
    try {
      execFileSync('node', [path.join(ROOT, 'scripts/ci/fast-publish-section.mjs'), ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(cli(['shard-of', 'svizzera']), 0);
  assert.equal(cli(['shard-of', 'canton-ti']), 1);
  assert.equal(cli(['section-of', 'content/blog-meta-it.ts']), 1);
});

test('il body dir di una sezione non cattura quello di un\'altra con lo stesso prefisso', () => {
  assert.equal(sectionForBodyPath('content/blog-body-ch/it/x.ts')?.section, 'svizzera');
  assert.equal(sectionForBodyPath('content/blog-body/it/x.ts')?.section, 'frontaliere');
  assert.equal(sectionForBodyPath('content/blog-body/xx/x.ts'), null);
  assert.equal(sectionForBodyPath('content/blog-body/it/sub/x.ts'), null);
});

// ── 2. La regola di una sezione cantonale, sul suo id vero ─────────────────────

test('una sezione cantonale ha le superfici sorgente derivate dal core, e la superficie API di famiglia', () => {
  const ti = sectionSourceSurfaces('canton-ti');
  assert.equal(ti.kind, 'canton');
  assert.equal(ti.shardKey, null);
  assert.equal(ti.registryFile, 'content/cantons/canton-ti/registry.ts');
  assert.equal(ti.slugFile, 'content/cantons/canton-ti/slugs.ts');
  assert.equal(ti.metaFile('it'), 'content/blog-meta-canton-ti-it.ts');
  assert.equal(ti.bodyDir, 'content/blog-body-canton-ti');
  assert.equal(ti.canonicalOverrides, null);
  assert.equal(floorPolicyOf('canton-ti'), 'family');
  assert.deepEqual(KIND_FLOOR_POLICY, { frontaliere: 'section', national: 'section', canton: 'family' });
  // P7: la famiglia canton pubblica in superfici aggregate (canton-articles.json,
  // meta-canton-<loc>.json, slugs.json.cantons) e una sitemap per sezione.
  assert.equal(sectionApiSurfaces('canton-ti').family, 'canton');
  assert.equal(sectionApiSurfaces('canton-ti').sitemap, 'sitemap-articles-canton-ti.xml');
  assert.equal(assertActiveSectionsPublishable([...ARTICLE_SECTION_CORE_LIST, CANTON]), true);
  assert.equal(assertActiveSectionsPublishable(), true);
  // Un tipo senza nessun profilo resta un rifiuto esplicito, mai un salto.
  assert.throws(
    () => assertActiveSectionsPublishable([...ARTICLE_SECTION_CORE_LIST, { ...CANTON, section: 'canton-zz', kind: 'regione' }]),
    /sezione articoli sconosciuta: "canton-zz"/,
  );
  assert.throws(() => sectionSourceSurfaces('canton-zz'), /sconosciuta/);
});

test('pavimenti: una sezione cantonale nuova vale 0 senza rifiuto; le storiche restano fail-closed', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'core-floors-'));
  assert.equal(sectionFloor(empty, 'canton-ti'), 0);
  assert.equal(countSourceSitemapEntries(empty, 'canton-ti'), 0);
  assert.equal(expectedBodyFiles(empty, 'canton-ti', { previousRegistryCount: 0 }), 0);
  // Il «corpus non materializzato» lo vedono comunque le sezioni storiche.
  assert.throws(() => sectionFloor(empty, 'frontaliere'), /riferimento del pavimento assente/);
  assert.throws(() => sectionFloor(empty, 'svizzera'), /riferimento del pavimento assente/);
});

test('pavimenti: il verdetto di famiglia rifiuta il troncamento, non la sezione nuova', () => {
  assert.equal(familyFloorVerdict([{ section: 'canton-ti', source: 0, emitted: 0 }]).truncated, false);
  assert.equal(
    familyFloorVerdict([
      { section: 'canton-ti', source: 0, emitted: 0 },
      { section: 'canton-gr', source: 40, emitted: 40 },
    ]).truncated,
    false,
  );
  const cut = familyFloorVerdict([
    { section: 'canton-ti', source: 30, emitted: 0 },
    { section: 'canton-gr', source: 30, emitted: 0 },
  ]);
  assert.equal(cut.truncated, true);
  assert.equal(cut.floor, 54);
  assert.deepEqual(cut.sections, ['canton-ti', 'canton-gr']);
  // La somma non nasconde una sezione svuotata dietro le altre (review #2212).
  const hidden = familyFloorVerdict([
    { section: 'canton-ti', source: 3, emitted: 0 },
    { section: 'canton-gr', source: 100, emitted: 100 },
  ]);
  assert.ok(hidden.emitted >= hidden.floor, 'il caso deve reggere il pavimento aggregato');
  assert.equal(hidden.truncated, true);
  assert.deepEqual(hidden.emptied, ['canton-ti']);
});

test('build-api: RSS di famiglia rifiuta ogni sezione con articoli e zero item, non solo la famiglia vuota', () => {
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  assert.match(build, /const \{ emptied \} = familyFloorVerdict\(familyRssRows\);/);
  assert.doesNotMatch(build, /familyRssRows\.every\(/);
});

test('locale completeness: una radice di famiglia nuova non scatta i pavimenti assoluti, una svuotata si', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'core-locale-'));
  const ti = { rel: 'content/blog-body-canton-ti', name: 'canton-ti', floorPolicy: 'family',
    registryFile: 'content/cantons/canton-ti/registry.ts' };
  const fresh = inspectBlogLocaleCompleteness({ root, bodyRoots: [ti] });
  assert.deepEqual(fresh.violations, [], 'una sezione cantonale appena accesa, senza registro ne\' corpi, e\' legittima');
  mkdirSync(path.join(root, 'content/cantons/canton-ti'), { recursive: true });
  writeFileSync(path.join(root, ti.registryFile), ['a', 'b', 'c'].map((id) => `  {\n    id: '${id}',\n  },\n`).join(''));
  const emptied = inspectBlogLocaleCompleteness({ root, bodyRoots: [ti] });
  assert.ok(emptied.violations.some((v) => v.code === 'family-source-floor' && v.section === 'canton-ti'));
  // Le radici storiche restano sui pavimenti assoluti.
  const historical = inspectBlogLocaleCompleteness({ root, bodyRoots: [LOCALE_BODY_ROOTS[0]] });
  assert.ok(historical.violations.some((v) => v.code === 'source-floor'));
});

test('publish-api: osserva corpus-sections e deriva dal core le cartelle dei corpi del preflight', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  assert.match(wf, /^      - 'scripts\/lib\/corpus-sections\.mjs'$/m);
  assert.match(wf, /^      - 'generator\/scripts\/lib\/corpus-paths\.mjs'$/m);
  assert.match(wf, /import\('\.\/scripts\/lib\/corpus-sections\.mjs'\)/);
  assert.match(wf, /git diff --name-only "\$BEFORE" HEAD -- "\$\{body_dir_list\[@\]\}"/);
  assert.doesNotMatch(wf, /-- content\/blog-body content\/blog-body-ch/);
});

test('RSS: con la lista attiva di oggi nessun profilo cantonale viene chiesto all\'engine', () => {
  // L'engine (P2) lancia per una sezione `canton` attiva senza profilo RSS
  // finche' P7/P11 non lo definiscono: con le due sezioni storiche non deve
  // scattare, e build-api passa i registri per id del core.
  assert.deepEqual(RSS_SECTIONS.map((s) => s.id), ACTIVE);
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  assert.match(build, /assertActiveSectionsPublishable\(\);/);
  assert.match(build, /registries: Object\.fromEntries\(PUBLISHED_API_SECTIONS\.map/);
  assert.doesNotMatch(build, /\['frontaliere', 'svizzera'\]/);
  assert.doesNotMatch(build, /SWISS_ARTICLES\.length/);
});
