import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COVER = '/images/blog/article-cantello-teatro-dialettale-ottobre-2026.webp';
const MCDONALDS_COVER = '/images/blog/article-mcdonalds-pulizia-malnate-2026.webp';

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  });
}

test('article body fields never embed a following body payload', () => {
  const offenders = filesBelow(path.join(ROOT, 'content'))
    .filter((file) => /blog-body/.test(file) && file.endsWith('.ts'))
    .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').flatMap((line, index) => (
      /\.body1'/.test(line) && /\\n\\nbody2:/.test(line)
        ? [`${path.relative(ROOT, file)}:${index + 1}`]
        : []
    )));

  assert.deepEqual(offenders, []);
});

test('Cantello registry, SEO metadata and public asset use the dedicated cover', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content/blog-articles-data.ts'), 'utf8');
  const seo = fs.readFileSync(path.join(ROOT, 'content/seo/seo-blog-5.ts'), 'utf8');
  const article = registry.match(/id: 'cantello-teatro-dialettale-ottobre-2026',[\s\S]*?\n\s*\},?/)?.[0];
  const metadata = seo.match(/'blog-cantello-teatro-dialettale-ottobre-2026': \{[\s\S]*?\n\s*\},\n\n/)?.[0];

  assert.ok(article, 'Cantello article record is missing');
  assert.match(article, new RegExp(`image: '${COVER.replaceAll('/', '\\/')}'`));
  assert.ok(metadata, 'Cantello SEO metadata is missing');
  assert.ok(metadata.includes('${BASE_URL}' + COVER));
  assert.ok(fs.existsSync(path.join(ROOT, `public${COVER}`)), 'Cantello cover blob is missing');
});

test('Locate Varesino remains paired across typed and runtime id registries', () => {
  const articleId = 'caduta-scala-locate-varesino';
  const typedIds = fs.readFileSync(path.join(ROOT, 'content/blogArticleIds.ts'), 'utf8');
  const runtimeIds = fs.readFileSync(path.join(ROOT, 'content/routerBlogData.ts'), 'utf8');
  const sentinels = typedIds.match(/export const BLOG_ARTICLE_ID_REGISTRY_SENTINELS\s*=\s*\[([\s\S]*?)\]/)?.[1];
  const runtimeList = runtimeIds.match(/export const ALL_BLOG_ARTICLE_IDS[^=]*=\s*\[([\s\S]*?)\];/)?.[1];

  assert.equal(typedIds.match(new RegExp(articleId, 'g'))?.length, 2);
  assert.ok(sentinels, 'BLOG_ARTICLE_ID_REGISTRY_SENTINELS is missing');
  assert.match(sentinels, new RegExp(`'${articleId}'`));
  assert.ok(runtimeList, 'ALL_BLOG_ARTICLE_IDS is missing');
  assert.match(runtimeList, new RegExp(`'${articleId}'`));
});

test('Malnate cleanup registry, SEO metadata and public asset use the dedicated cover', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content/blog-articles-data.ts'), 'utf8');
  const seo = fs.readFileSync(path.join(ROOT, 'content/seo/seo-blog-5.ts'), 'utf8');
  const article = registry.match(/id: 'mcdonalds-pulizia-malnate-2026',[\s\S]*?\n\s*\},?/)?.[0];
  const metadata = seo.match(/'blog-mcdonalds-pulizia-malnate-2026': \{[\s\S]*?\n\s*\},\n\n/)?.[0];

  assert.ok(article, 'Malnate cleanup article record is missing');
  assert.match(article, new RegExp(`image: '${MCDONALDS_COVER.replaceAll('/', '\\/')}'`));
  assert.ok(metadata, 'Malnate cleanup SEO metadata is missing');
  assert.ok(metadata.includes('${BASE_URL}' + MCDONALDS_COVER));
  assert.ok(fs.existsSync(path.join(ROOT, `public${MCDONALDS_COVER}`)), 'Malnate cleanup cover blob is missing');
});
