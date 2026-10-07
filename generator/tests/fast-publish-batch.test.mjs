import test from 'node:test';
import assert from 'node:assert/strict';
import '../../host/cantonSectionsBootstrap.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import { bodyRegex } from '../../scripts/ci/fast-publish-section.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');
const publisher = readFileSync(resolve(here, '../../scripts/publish-article-fast.mjs'), 'utf8');
// La catena di render condivisa: gli id passano di qui al renderer.
const pipeline = readFileSync(resolve(here, '../../scripts/lib/article-render-pipeline.mjs'), 'utf8');

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
  // Le cartelle dei corpi, la sezione di ogni corpo e lo shard vengono dal
  // core (scripts/ci/fast-publish-section.mjs), non da una regex e un `case`
  // scritti nel workflow; il comportamento dell'helper e' provato in
  // core-driven-consumers.test.mjs.
  // Solo le sezioni servite da uno shard: un corpo cantonale (R2) lo pubblica
  // fast-publish-section.yml, e qui farebbe fallire `shard-of`.
  assert.match(resolveStep, /body_re="\$\(node scripts\/ci\/fast-publish-section\.mjs body-regex shard\)"/);
  assert.match(resolveStep, /grep -E "\$body_re"/);
  assert.match(resolveStep, /body_section="\$\(node scripts\/ci\/fast-publish-section\.mjs section-of "\$body"\)"/);
  assert.match(resolveStep, /shard="\$\(node scripts\/ci\/fast-publish-section\.mjs shard-of "\$section"\)"/);
  assert.match(resolveStep, /echo "shard=\$shard"/);
  assert.doesNotMatch(resolveStep, /body_section=svizzera/);
  assert.match(resolveStep, /sort -u/);
  assert.match(resolveStep, /ids\+=\("\$body_id"\)/);
  assert.match(resolveStep, /echo "ids=\$ids_json"/);
  assert.match(resolveStep, /PUSH_BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(resolveStep, /if \[ "\$\{#ids\[@\]\}" -eq 0 \]; then[\s\S]*git diff --name-only "\$before" HEAD/);
  assert.doesNotMatch(resolveStep, /head\s+-1/);
});

test('il dispatch accetta una lista JSON e il workflow la passa al renderer batch', () => {
  assert.match(workflow, /article_ids:\s*\n\s+description: 'JSON array of article ids/);
  assert.match(workflow, /ARTICLE_IDS_INPUT: \$\{\{ inputs\.article_ids \}\}/);
  assert.match(workflow, /--ids "\$ARTICLE_IDS_JSON"/);
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
  assert.match(publisher, /paths: \[\.\.\.articlePaths, \.\.\.bridgePaths, \.\.\.hubPaths\]/);
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
  // Un articolo trattenuto con la pagina online non ferma gli archivi: li ferma
  // solo quello la cui pagina non è dimostrata (vedi article-online-image-probe).
  assert.match(pipeline, /const heldWithoutOnlinePage = heldArticlesWithoutOnlinePage\(imagePostcondition\.excludedArticles\);/);
  assert.match(pipeline, /const aggregatePagesAllowed = heldWithoutOnlinePage\.length === 0;/);
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
