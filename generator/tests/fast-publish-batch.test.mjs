import test from 'node:test';
import assert from 'node:assert/strict';
import '../../host/cantonSectionsBootstrap.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import { articlePublishPlan, bodyPublishPlan, bodyRegex } from '../../scripts/ci/fast-publish-section.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');
const publisher = readFileSync(resolve(here, '../../scripts/publish-article-fast.mjs'), 'utf8');
// La catena di render condivisa: gli id passano di qui al renderer.
const pipeline = readFileSync(resolve(here, '../../scripts/lib/article-render-pipeline.mjs'), 'utf8');
const observer = readFileSync(resolve(here, '../../scripts/ci/article-publication-observer.mjs'), 'utf8');
const pushBaseGuard = readFileSync(resolve(here, '../../scripts/ci/fetch-push-base-if-missing.sh'), 'utf8');
const pushBaseGuardPath = resolve(here, '../../scripts/ci/fetch-push-base-if-missing.sh');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function stepText(name) {
  const matches = [...workflow.matchAll(/^ {6}- name: (.+)$/gm)];
  const index = matches.findIndex((match) => match[1].trim() === name);
  assert.notEqual(index, -1, `step «${name}» non trovato: il test è diventato vacuo`);
  const start = matches[index].index;
  const end = matches[index + 1]?.index ?? workflow.length;
  return workflow.slice(start, end);
}

test('il trigger push conserva tutti gli ID dei body cambiati', () => {
  const resolveStep = stepText('Resolve mode, article ids and section');
  // Le cartelle dei corpi, la sezione, l'ammissione nel registry e lo shard
  // vengono dal core (scripts/ci/fast-publish-section.mjs), non da regex,
  // `case` o basename scritti nel workflow.
  // Solo le sezioni servite da uno shard: un corpo cantonale (R2) lo pubblica
  // fast-publish-section.yml, e qui farebbe fallire `shard-of`.
  assert.match(resolveStep, /fast-publish-section\.mjs body-plan shard/);
  assert.match(resolveStep, /fast-publish-section\.mjs article-plan shard/);
  assert.match(resolveStep, /surface_section=/);
  assert.match(resolveStep, /surface_ids_json=/);
  assert.match(resolveStep, /body_section=.*\.section/);
  assert.match(resolveStep, /body_ids_json=.*\.ids/);
  assert.match(resolveStep, /skipped_ids_json=.*\.skippedIds/);
  assert.match(resolveStep, /no publishable registry entry/);
  assert.match(resolveStep, /target_shard="\$\(node scripts\/ci\/fast-publish-section\.mjs shard-of "\$target_section"\)"/);
  assert.match(resolveStep, /echo "matrix=\$matrix_with_shards"/);
  assert.doesNotMatch(resolveStep, /body_section=svizzera/);
  assert.match(resolveStep, /merge_group_ids "\$body_section" "\$body_ids_json"/);
  assert.doesNotMatch(resolveStep, /one commit changes both article sections/);
  assert.match(resolveStep, /EVENT_NAME.*workflow_dispatch.*section.*body_section/);
  assert.match(resolveStep, /PUSH_BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(resolveStep, /if \[ "\$\{#ids\[@\]\}" -eq 0 \]; then[\s\S]*git diff --name-only "\$before" HEAD/);
  assert.doesNotMatch(resolveStep, /head\s+-1/);
});

test('i JSON di batch non passano a jq come argomenti di dimensione illimitata', () => {
  const resolveStep = stepText('Resolve mode, article ids and section');

  // A dependency change can select the whole registry. `--argjson` would put
  // that array in one argv string and fail before jq starts at MAX_ARG_STRLEN.
  assert.match(resolveStep, /merge_group_ids\(\)/);
  assert.match(resolveStep, /printf '%s\\n%s\\n' "\$groups" "\$merge_ids_json"[\s\S]*jq -cs/);
  assert.match(resolveStep, /append_matrix_target\(\)/);
  assert.match(resolveStep, /printf '%s\\n%s\\n' "\$matrix_with_shards" "\$matrix_target"[\s\S]*jq -cs/);
  assert.doesNotMatch(resolveStep, /--argjson\s+(?:ids|target)\s+"/u);
});

test('le superfici articolo oltre il body producono solo gli ID realmente cambiati', () => {
  const registry = new Map([
    ['frontaliere', new Set(['alpha', 'beta'])],
    ['svizzera', new Set()],
  ]);
  const previous = new Map([
    ['content/blog-articles-data.ts', "export const ARTICLES = [{ id: 'alpha', category: 'news', date: '2026-01-01', image: '/images/blog/alpha.webp' }, { id: 'beta', category: 'news', date: '2026-01-01', image: '/images/blog/beta.webp' }];\n"],
    ['content/seo/seo-blog-5.ts', "const SEO = {\n  'blog-alpha': { title: 'old' },\n  'blog-beta': { title: 'same' },\n};\n"],
    ['content/blog-meta-it.ts', "const META = {\n  'blog.article.alpha.title': 'A',\n  'blog.article.beta.title': 'old beta',\n};\n"],
    ['content/routerBlogData.ts', "const BLOG_SLUGS = {\n  'alpha': { it: 'alpha-it', en: 'alpha-en', de: 'alpha-de', fr: 'alpha-fr' },\n  'beta': { it: 'beta-it', en: 'beta-en', de: 'beta-de', fr: 'beta-fr' },\n};\n"],
  ]);
  const current = new Map([
    ['content/blog-articles-data.ts', "export const ARTICLES = [{ id: 'alpha', category: 'news', date: '2026-01-01', image: '/images/blog/alpha.webp' }, { id: 'beta', category: 'news', date: '2026-01-01', image: '/images/blog/beta.webp' }];\n"],
    ['content/seo/seo-blog-5.ts', "const SEO = {\n  'blog-alpha': { title: 'new alpha' },\n  'blog-beta': { title: 'same' },\n};\n"],
    ['content/blog-meta-it.ts', "const META = {\n  'blog.article.alpha.title': 'A',\n  'blog.article.beta.title': 'new beta',\n};\n"],
    ['content/routerBlogData.ts', "const BLOG_SLUGS = {\n  'alpha': { it: 'alpha-it', en: 'alpha-en', de: 'alpha-de', fr: 'alpha-fr' },\n  'beta': { it: 'beta-new-it', en: 'beta-en', de: 'beta-de', fr: 'beta-fr' },\n};\n"],
  ]);
  const plan = articlePublishPlan([
    'content/seo/seo-blog-5.ts',
    'content/blog-meta-it.ts',
    'content/routerBlogData.ts',
  ], ARTICLE_SECTION_CORE_LIST, {
    served: 'shard',
    articleIdsForSection: (section) => registry.get(section.section) ?? new Set(),
    readPreviousSource: (rel) => previous.get(rel) ?? null,
    readCurrentSource: (rel) => current.get(rel) ?? null,
  });

  assert.deepEqual(plan, [{
    section: 'frontaliere',
    ids: ['alpha', 'beta'],
    bootstrap: false,
  }]);

});

test('una dipendenza importata dal registry invalida tutti gli articoli registrati', () => {
  const registered = new Set(['alpha', 'beta']);
  const previousRegistry = `import { cdnBlogImage } from './blogImageCdnMirror';

const RAW_ARTICLES = [
  { id: 'alpha', image: '/images/blog/alpha.webp' },
  { id: 'beta', image: '/images/blog/beta.webp' },
];
export const ARTICLES = RAW_ARTICLES.map((article) => ({ ...article, image: cdnBlogImage(article.image) }));
`;
  const currentRegistry = previousRegistry.replace('blogImageCdnMirror', 'blogImageCdnMirrorV2');
  const previous = new Map([['content/blog-articles-data.ts', previousRegistry]]);
  const current = new Map([['content/blog-articles-data.ts', currentRegistry]]);

  const plan = articlePublishPlan(['content/blogImageCdnMirror.ts'], ARTICLE_SECTION_CORE_LIST, {
    served: 'shard',
    articleIdsForSection: () => registered,
    readPreviousSource: (rel) => previous.get(rel) ?? null,
    readCurrentSource: (rel) => current.get(rel) ?? null,
  });

  assert.deepEqual(plan, [{
    section: 'frontaliere',
    ids: ['alpha', 'beta'],
    bootstrap: false,
  }]);

  const transformedRegistry = previousRegistry.replace(
    'cdnBlogImage(article.image)',
    'cdnBlogImageV2(article.image)',
  );
  const transformedPlan = articlePublishPlan(['content/blog-articles-data.ts'], ARTICLE_SECTION_CORE_LIST, {
    served: 'shard',
    articleIdsForSection: () => registered,
    readPreviousSource: (rel) => previous.get(rel) ?? null,
    readCurrentSource: (rel) => rel === 'content/blog-articles-data.ts' ? transformedRegistry : null,
  });

  assert.deepEqual(transformedPlan, [{
    section: 'frontaliere',
    ids: ['alpha', 'beta'],
    bootstrap: false,
  }]);
});

test('un cambiamento fuori dalle entry SEO invalida gli articoli registrati', () => {
  const registered = new Set(['alpha', 'beta']);
  const previousSeo = `const SEO_BASE_URL = 'https://old.example';
const SEO = {
  'blog-alpha': { title: 'same alpha' },
  'blog-beta': { title: 'same beta' },
};\n`;
  const currentSeo = previousSeo.replace('https://old.example', 'https://new.example');
  const previous = new Map([['content/seo/seo-blog-5.ts', previousSeo]]);
  const current = new Map([['content/seo/seo-blog-5.ts', currentSeo]]);
  const plan = articlePublishPlan(['content/seo/seo-blog-5.ts'], ARTICLE_SECTION_CORE_LIST, {
    served: 'shard',
    articleIdsForSection: () => registered,
    readPreviousSource: (rel) => previous.get(rel) ?? null,
    readCurrentSource: (rel) => current.get(rel) ?? null,
  });

  assert.deepEqual(plan, [{
    section: 'frontaliere',
    ids: ['alpha', 'beta'],
    bootstrap: false,
  }]);
});

test('la mappa slug ignora l oggetto fallback omonimo e rileva lo slug cambiato', () => {
  const registered = new Set(['alpha', 'beta']);
  const registry = "export const ARTICLES = [{ id: 'alpha' }, { id: 'beta' }];\n";
  const previousSlugs = `const BLOG_SLUGS = {
  'alpha': { it: 'alpha-it', en: 'alpha-en', de: 'alpha-de', fr: 'alpha-fr' },
  'beta': { it: 'beta-old-it', en: 'beta-en', de: 'beta-de', fr: 'beta-fr' },
};
const BLOG_SLUG_FALLBACK_REASONS = {
  'beta': { it: 'legacy-reason', en: 'legacy-reason', de: 'legacy-reason', fr: 'legacy-reason' },
};
`;
  const currentSlugs = previousSlugs.replace('beta-old-it', 'beta-new-it');
  const previous = new Map([
    ['content/blog-articles-data.ts', registry],
    ['content/routerBlogData.ts', previousSlugs],
  ]);
  const current = new Map([
    ['content/blog-articles-data.ts', registry],
    ['content/routerBlogData.ts', currentSlugs],
  ]);
  const plan = articlePublishPlan(['content/routerBlogData.ts'], ARTICLE_SECTION_CORE_LIST, {
    served: 'shard',
    articleIdsForSection: () => registered,
    readPreviousSource: (rel) => previous.get(rel) ?? null,
    readCurrentSource: (rel) => current.get(rel) ?? null,
  });

  assert.deepEqual(plan, [{
    section: 'frontaliere',
    ids: ['beta'],
    bootstrap: false,
  }]);
});

test('una canonical override cambiata risveglia solo l articolo che possiede lo slug', () => {
  const registered = new Set(['alpha', 'beta']);
  const registry = "export const ARTICLES = [{ id: 'alpha' }, { id: 'beta' }];\n";
  const slugs = "export const BLOG_SLUGS = {\n  'alpha': { it: 'alpha-it', en: 'alpha-en', de: 'alpha-de', fr: 'alpha-fr' },\n  'beta': { it: 'beta-it', en: 'beta-en', de: 'beta-de', fr: 'beta-fr' },\n};\n";
  const previous = new Map([
    ['content/blog-articles-data.ts', registry],
    ['content/routerBlogData.ts', slugs],
    ['engine/shared/frontaliere-article-canonical-overrides.json', JSON.stringify({ overrides: { 'alpha-it': 'https://old.example/' } })],
  ]);
  const current = new Map([
    ['content/blog-articles-data.ts', registry],
    ['content/routerBlogData.ts', slugs],
    ['engine/shared/frontaliere-article-canonical-overrides.json', JSON.stringify({ overrides: { 'alpha-it': 'https://new.example/' } })],
  ]);
  const plan = articlePublishPlan([
    'engine/shared/frontaliere-article-canonical-overrides.json',
  ], ARTICLE_SECTION_CORE_LIST, {
    served: 'shard',
    articleIdsForSection: () => registered,
    readPreviousSource: (rel) => previous.get(rel) ?? null,
    readCurrentSource: (rel) => current.get(rel) ?? null,
  });

  assert.deepEqual(plan, [{ section: 'frontaliere', ids: ['alpha'], bootstrap: false }]);
});

test('uno slug winner cambiato risveglia i dipendenti shadowed e valida la chiave rinominata', () => {
  const registered = new Set(['winner', 'shadow']);
  const registry = "export const ARTICLES = [{ id: 'winner' }, { id: 'shadow' }];\n";
  const previousSlugs = `export const BLOG_SLUGS = {
  'winner': { it: 'winner-old-it', en: 'winner-old-en', de: 'winner-old-de', fr: 'winner-old-fr' },
  'shadow': { it: 'shadow-old-it', en: 'shadow-old-en', de: 'shadow-old-de', fr: 'shadow-old-fr' },
};\n`;
  const currentSlugs = previousSlugs
    .replaceAll('winner-old', 'winner-new')
    .replaceAll('shadow-old', 'shadow-new');
  const previousOverrides = JSON.stringify({ overrides: {
    'shadow-old-it': 'https://frontaliereticino.ch/articoli-frontaliere/winner-old-it/',
  } });
  const currentOverrides = JSON.stringify({ overrides: {
    'shadow-new-it': 'https://frontaliereticino.ch/articoli-frontaliere/winner-new-it/',
  } });
  const previous = new Map([
    ['content/blog-articles-data.ts', registry],
    ['content/routerBlogData.ts', previousSlugs],
    ['engine/shared/frontaliere-article-canonical-overrides.json', previousOverrides],
  ]);
  const current = new Map([
    ['content/blog-articles-data.ts', registry],
    ['content/routerBlogData.ts', currentSlugs],
    ['engine/shared/frontaliere-article-canonical-overrides.json', currentOverrides],
  ]);
  const plan = articlePublishPlan([
    'content/routerBlogData.ts',
    'engine/shared/frontaliere-article-canonical-overrides.json',
  ], ARTICLE_SECTION_CORE_LIST, {
    served: 'shard',
    articleIdsForSection: () => registered,
    readPreviousSource: (rel) => previous.get(rel) ?? null,
    readCurrentSource: (rel) => current.get(rel) ?? null,
  });

  assert.deepEqual(plan, [{
    section: 'frontaliere',
    ids: ['shadow', 'winner'],
    bootstrap: false,
  }]);

  const staleCurrent = new Map(current);
  staleCurrent.set(
    'engine/shared/frontaliere-article-canonical-overrides.json',
    previousOverrides,
  );
  assert.throws(
    () => articlePublishPlan(['content/routerBlogData.ts'], ARTICLE_SECTION_CORE_LIST, {
      served: 'shard',
      articleIdsForSection: () => registered,
      readPreviousSource: (rel) => previous.get(rel) ?? null,
      readCurrentSource: (rel) => staleCurrent.get(rel) ?? null,
    }),
    /canonical override corrente: chiave slug shadow-old-it non presente/,
  );
});

test('il resolver article non rifà il fetch del parent già presente nel checkout', () => {
  const resolveFetchStep = stepText('Fetch push base (resolve)');
  assert.match(resolveFetchStep, /bash scripts\/ci\/fetch-push-base-if-missing\.sh/);
  assert.match(pushBaseGuard, /git rev-parse --is-shallow-repository/);
  assert.match(pushBaseGuard, /git fetch --no-tags --unshallow origin main/);
  assert.match(pushBaseGuard, /HISTORY_FETCH_ATTEMPTS/);
  assert.match(pushBaseGuard, /HISTORY_FETCH_DELAY_S supera il cap di 60/);
  assert.match(pushBaseGuard, /HISTORY_FETCH_TIMEOUT_S/);
  assert.match(pushBaseGuard, /run_fetch_with_timeout/);
  assert.match(pushBaseGuard, /FETCH_MAIN/);
  assert.match(pushBaseGuard, /git cat-file -e "\$\{PUSH_BEFORE\}\^\{commit\}"/);
  assert.match(pushBaseGuard, /git fetch --no-tags origin "\$PUSH_BEFORE"/);
  assert.match(pushBaseGuard, /push base non presente dopo il fetch/);
});

test('il guard del push base ripristina la storia completa prima del preflight', () => {
  const root = mkdtempSync(join(tmpdir(), 'frontaliere-history-'));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const shallow = join(root, 'shallow');
  try {
    git(root, 'init', '--bare', '--initial-branch=main', origin);
    git(root, 'init', '--initial-branch=main', source);
    git(source, 'config', 'user.email', 'test@example.invalid');
    git(source, 'config', 'user.name', 'test');
    writeFileSync(join(source, 'history.txt'), 'base\n');
    git(source, 'add', 'history.txt');
    git(source, 'commit', '-m', 'base');
    const base = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'history.txt'), 'head\n');
    git(source, 'commit', '-am', 'head');
    git(source, 'remote', 'add', 'origin', origin);
    git(source, 'push', 'origin', 'main');
    git(root, 'clone', '--depth', '1', `file://${origin}`, shallow);
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'true');

    execFileSync('bash', [pushBaseGuardPath], {
      cwd: shallow,
      env: {
        ...process.env,
        PUSH_BEFORE: base,
        HISTORY_FETCH_ATTEMPTS: '3',
        HISTORY_FETCH_DELAY_S: '0',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'false');
    assert.equal(git(shallow, 'cat-file', '-e', `${base}^{commit}`), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il dry gate usa il piano delle superfici e il publisher porta i redirect di slug', () => {
  const resolveStep = stepText('Resolve mode, article ids and section');
  assert.match(resolveStep, /article_plan=.*fast-publish-section\.mjs article-plan shard/);
  assert.match(resolveStep, /printf '%s' "\$article_plan" \| jq 'length'/);
  assert.doesNotMatch(resolveStep, /engine\/shared\/\*-article-canonical-overrides\.json/);
  assert.match(workflow, /PUBLISH_BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(publisher, /redirectPaths/);
  assert.match(publisher, /writeLegacySlugRedirects/);
});

test('i body orfani non bloccano gli articoli registrati dello stesso push', () => {
  const registered = new Map([
    ['frontaliere', new Set(['articolo-valido'])],
    ['svizzera', new Set(['articolo-svizzero'])],
  ]);
  const plan = bodyPublishPlan([
    'content/blog-body/it/articolo-valido.ts',
    // Regressione della run 39145445206: questo body storico esiste, ma non
    // ha una voce nel registry pubblicabile della sezione frontaliere.
    'content/blog-body/it/carnevale-2026-lugano-laboratori-creativi-figli-frontalieri.ts',
    'content/blog-body-ch/de/articolo-svizzero.ts',
    'content/blog-body/it/articolo-valido.ts',
  ], ARTICLE_SECTION_CORE_LIST, {
    served: 'shard',
    fileExists: () => true,
    articleIdsForSection: (section) => registered.get(section.section) ?? new Set(),
  });

  assert.deepEqual(plan, [
    {
      section: 'frontaliere',
      ids: ['articolo-valido'],
      skippedIds: ['carnevale-2026-lugano-laboratori-creativi-figli-frontalieri'],
    },
    { section: 'svizzera', ids: ['articolo-svizzero'], skippedIds: [] },
  ]);
});

test('body e immagini multi-sezione diventano target matrix separati', () => {
  const resolveStep = stepText('Resolve mode, article ids and section');
  const imagePlan = resolveStep.slice(resolveStep.indexOf('image_plan='));
  assert.match(imagePlan, /image_section=/);
  assert.match(imagePlan, /image_ids_json=/);
  assert.match(imagePlan, /merge_group_ids "\$image_section" "\$image_ids_json"/);
  assert.doesNotMatch(imagePlan, /one commit changes both article sections/);
  assert.match(workflow, /matrix:\s*\n\s+target: \$\{\{ fromJSON\(needs\.resolve\.outputs\.matrix\) \}\}/);
  assert.match(workflow, /group: fast-publish-article-\$\{\{ matrix\.target\.shard \}\}/);
  assert.match(workflow, /ARTICLE_IDS_JSON: \$\{\{ toJSON\(matrix\.target\.ids\) \}\}/);
  assert.match(workflow, /--released-articles-file "\$RUNNER_TEMP\/fast-summary\.json"/);
});

test('i fallback persistenti entrano in archivio e landing, e il dispatch identifica il run', () => {
  assert.match(workflow, /run-name: cover-publish-article \/ \$\{\{ inputs\.section \|\| 'auto' \}\} \/ nonce=\$\{\{ inputs\.dispatch_nonce \|\| 'none' \}\}/);
  assert.match(workflow, /dispatch_nonce:/);
  assert.match(workflow, /gh issue list --repo "\$GH_REPO"/);
  assert.match(workflow, /article-image-fallbacks\.mjs/);
  assert.match(workflow, /--persistent-generic-fallbacks-file/);
  assert.match(publisher, /persistentReleasedArticles/);
  assert.match(publisher, /genericFallbackArticles/);
  assert.match(pipeline, /mergeGenericFallbacks\(persistentReleasedArticles, releasedWithGenericImage\)/);
  assert.match(pipeline, /releasedArticles: genericFallbackArticles/);
  assert.match(observer, /randomUUID\(\)/);
  assert.match(observer, /dispatch_nonce=/);
  assert.match(observer, /previousRunIds/);
  assert.match(observer, /displayTitle/);
});

test('il dispatch accetta una lista JSON e il workflow la passa al renderer batch', () => {
  assert.match(workflow, /article_ids:\s*\n\s+description: 'JSON array of article ids/);
  assert.match(workflow, /ARTICLE_IDS_INPUT: \$\{\{ inputs\.article_ids \}\}/);
  assert.match(workflow, /article_ids_file="\$RUNNER_TEMP\/fast-article-ids\.json"/);
  assert.match(workflow, /printf '%s' "\$ARTICLE_IDS_JSON" > "\$article_ids_file"/);
  assert.match(workflow, /--ids-file "\$article_ids_file"/);
  assert.doesNotMatch(workflow, /--ids "\$ARTICLE_IDS_JSON"/);
  assert.match(publisher, /--ids-file/);
  assert.match(publisher, /renderSectionArticlePipeline\(\{[\s\S]*?ids: args\.ids,/);
  assert.match(pipeline, /onlyArticleIds: ids \}\)/);
});

test('la revisione del corpus resta nel push e non entra nel motore HTML', () => {
  assert.match(publisher, /function corpusContentRevision\(\)/);
  assert.match(publisher, /const contentRevision = corpusContentRevision\(\);/);
  assert.match(workflow, /ARTICLE_CONTENT_REVISION/);
  const renderCall = publisher.match(/renderSectionArticlePipeline\(\{[\s\S]*?\}\);/)?.[0] ?? '';
  assert.doesNotMatch(renderCall, /contentRevision/);
  assert.doesNotMatch(pipeline, /contentRevision/);
});

test('il publisher rifiuta ID non risolti e riunisce tutte le pagine nel summary', () => {
  assert.match(pipeline, /const missingIds = ids\.filter/);
  assert.match(pipeline, /throw new Error\(`article id\(s\) not found in section/);
  assert.match(pipeline, /for \(const entry of entries\)/);
  assert.match(publisher, /articleIds = entries\.filter\(\(entry\) => entry\.paths\[locale\]\)/);
  assert.match(publisher, /bridgeIds = entries\.filter\(\(entry\) => entry\.flatPaths\[locale\]\)/);
  assert.match(publisher, /articlePaths = entries\.map/);
  assert.match(publisher, /bridgePaths = entries\.map/);
  assert.match(publisher, /writeLegacySlugRedirects/);
  assert.match(publisher, /PUBLISH_BEFORE/);
  assert.match(publisher, /buildFlatBridgeFromSibling/);
  assert.match(publisher, /redirectPaths = legacySlugRedirects\[locale\]/);
  assert.match(publisher, /paths: \[\.\.\.articlePaths, \.\.\.bridgePaths, \.\.\.redirectPaths, \.\.\.hubPaths\]/);
  assert.match(publisher, /url: urls\[0\],[\s\S]*urls,/);
  assert.match(publisher, /imagePostcondition/);
  assert.match(pipeline, /filterEntriesByImagePostcondition/);
});

test('un articolo ricaduto sull’immagine generica passa dalla lettura della pagina online e non esce in silenzio', () => {
  // La post-condizione da sola tratterrebbe anche l'articolo nuovo: il suo
  // risultato deve passare da releaseArticlesWithNothingToProtect, e il push
  // deve usare le voci che quella funzione restituisce.
  assert.match(
    pipeline,
    /const imagePostcondition = await releaseArticlesWithNothingToProtect\(\{\s*entries,\s*postcondition: filterEntriesByImagePostcondition\(/,
  );
  assert.ok(
    pipeline.indexOf('const imagePostcondition = await releaseArticlesWithNothingToProtect')
      < pipeline.indexOf('await renderArticleHubPages('),
    'la post-condizione deve decidere prima di renderizzare qualunque pagina aggregata',
  );
  // Un articolo trattenuto con la pagina online non ferma gli archivi. Un
  // articolo rilasciato col fallback invece li ferma: il registro completo
  // conserva ancora il path dell'immagine dichiarata che manca.
  assert.match(pipeline, /const aggregateVerdict = aggregatePageVerdict\(imagePostcondition\);/);
  assert.match(pipeline, /const aggregatePagesAllowed = aggregateVerdict\.allowed;/);
  assert.match(pipeline, /releasedWithGenericImage\.length > 0/);
  assert.doesNotMatch(pipeline, /aggregatePagesAllowed = imagePostcondition\.excludedArticles\.length === 0/);
  assert.match(pipeline, /if \(aggregatePagesAllowed\) \{[\s\S]*await renderArticleHubPages\(/);
  assert.match(pipeline, /let hubResult = \{ written: 0, pathsByLocale:/);
  assert.match(pipeline, /entries: imagePostcondition\.entries, hubResult/);
  assert.match(pipeline, /entries: imagePostcondition\.entries,/);
  assert.match(publisher, /aggregatePagesAllowed,/);
  // Trattenuto e uscito con l'immagine generica sono due avvisi distinti sulla run.
  assert.match(workflow, /\.imagePostcondition\.excludedArticles\[\]\?\.articleId/);
  assert.match(workflow, /\.imagePostcondition\.releasedArticles\[\]\?\.articleId/);
  assert.match(workflow, /::warning title=Articolo uscito con l'immagine generica::/);
});

test('la validazione distingue esplicitamente il percorso article-only dagli aggregati', () => {
  const refresh = stepText('Refresh the hub landing grid');
  const validation = stepText('Validate what was rendered');
  const publish = stepText('Publish to shards and CDN');
  assert.match(refresh, /jq -e '\.aggregatePagesAllowed == false'/);
  assert.match(validation, /aggregate_pages="\$\(jq -r '\.aggregatePagesAllowed'/);
  assert.match(validation, /if \[ "\$aggregate_pages" = "true" \]; then[\s\S]*hub_n/);
  assert.match(validation, /elif \[ "\$\{hub_n:-0\}" -ne 0 \]/);
  assert.match(validation, /aggregate pages intentionally withheld: validating the article-only set/);
  assert.match(publish, /if \[ "\$\{#paths\[@\]\}" -eq 0 \] && \[ "\$\{#hpaths\[@\]\}" -eq 0 \]/);
});

test('le immagini recuperate dal CDN restano sul CDN in indice e bridge', () => {
  assert.match(
    pipeline,
    /indexHtml = rewriteDownloadedImageRefs\(rewriteBlogImageRefs\(indexHtml\), imageStage\.downloadedImageKeys\)/,
  );
  assert.match(
    pipeline,
    /finalBridgeHtml = rewriteDownloadedImageRefs\(rewriteBlogImageRefs\(bridgeHtml\), imageStage\.downloadedImageKeys\)/,
  );
  assert.ok(
    pipeline.indexOf('rewriteDownloadedImageRefs(rewriteBlogImageRefs(indexHtml)')
      < pipeline.indexOf('const indexClean = sanitizeHtmlDocument(indexHtml)'),
    'la riscrittura deve precedere la scrittura dei byte pubblicati',
  );
  assert.match(
    pipeline,
    /rewriteDownloadedImageFiles\(\{\s*distDir,\s*relPaths: \[\.\.\.Object\.values\(hubResult\.pathsByLocale\)\.flat\(\), \.\.\.extraPaths\],/,
  );
  assert.ok(
    pipeline.indexOf('rewriteDownloadedImageFiles({') < pipeline.indexOf('// ── Step 7: offload-generated-images-cdn.mjs'),
    'landing e hub devono essere riscritti prima dell’offload',
  );
});

test('il workflow valida ID e cardinalità dei path per locale e sonda tutto il batch', () => {
  const validation = stepText('Validate what was rendered');
  assert.match(validation, /\.articlePaths \| length/);
  assert.match(validation, /\.bridgePaths \| length/);
  assert.match(validation, /\.hubPaths \| length/);
  assert.match(validation, /\.articleIds\[\]\?/);
  assert.match(validation, /\.bridgeIds\[\]\?/);
  assert.match(validation, /expected_ids/);
  assert.match(validation, /author_entry/);
  assert.match(validation, /@type.*Person\|Organization/);
  assert.match(validation, /frontaliereticino.*autori/);
  assert.doesNotMatch(validation, /has no Person author/);

  const probe = stepText('Verify the article is actually readable');
  assert.match(probe, /\.articlePaths\[\]/);
  assert.match(probe, /\.urls\[\]/);
  assert.match(probe, /origin_locale_gate_started/);
  assert.match(probe, /poll_origin "\$u" 1 8/);
  assert.doesNotMatch(probe, /\.articlePaths\[0\]/);
  assert.doesNotMatch(probe, /\.shards\[\]\.url(?:'|\s|$)/);
});

test('un push solo cantonale salta il publisher Pages e un push misto conserva le storiche', () => {
  const resolveStep = stepText('Resolve mode, article ids and section');
  const cantonSections = ARTICLE_SECTION_CORE_LIST.filter((section) => section.kind === 'canton');
  assert.equal(cantonSections.length, 24, 'la regressione deve coprire tutte le sezioni cantonali del core');
  const cantonFiles = cantonSections.flatMap((section) => [
    `content/${section.bodyDir}/it/example.ts`,
    `content/cantons/${section.section}/registry.ts`,
    `content/blog-meta-${section.section}-it.ts`,
  ]);
  const pagesBody = new RegExp(bodyRegex(ARTICLE_SECTION_CORE_LIST, { served: 'shard' }));
  assert.deepEqual(cantonFiles.filter((file) => pagesBody.test(file)), []);
  assert.deepEqual(
    ['content/blog-body/it/historical.ts', ...cantonFiles].filter((file) => pagesBody.test(file)),
    ['content/blog-body/it/historical.ts'],
  );
  assert.match(resolveStep, /CANTON_CONTENT_HANDLED_BY_FAST_PUBLISH_SECTION=1/);
  assert.match(resolveStep, /skip_reason=canton-only-r2/);
  assert.match(resolveStep, /fast-publish-section\.yml.*R2/);
});

test('la validazione accetta il profilo editoriale nominato ma non il fallback generico', () => {
  const validation = stepText('Validate what was rendered');
  assert.match(validation, /Person\|Organization/);
  assert.match(validation, /autori/);
  assert.doesNotMatch(validation, /no Person author/);
});
