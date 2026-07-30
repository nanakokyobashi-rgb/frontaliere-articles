/**
 * Build the public data surface of this repository.
 *
 * This repo owns the article corpus; the site that renders it is a separate
 * repository and must consume this data as plain JSON over HTTP — never by
 * reaching into these sources at build time. That boundary is the point: the
 * previous coupling shipped the registry as a Rollup-shaped ES module, and when
 * it was republished out-of-band as a standalone esbuild bundle the two disagreed
 * about a generated namespace export. The consumer dereferenced `undefined`, threw
 * past its own chunk-load recovery, and every article page on the live site sat on
 * a loading skeleton with nothing in the console.
 *
 * JSON cannot fail that way. There is no module shape to agree on — only keys.
 *
 * Emits, into dist/api/:
 *   manifest.json      commit, generatedAt, counts, per-file byte sizes
 *   articles.json      the frontaliere registry (ARTICLES)
 *   swiss-articles.json the svizzera registry (SWISS_ARTICLES)
 *   meta-<locale>.json      title/excerpt/imageAlt per article, frontaliere
 *   meta-ch-<locale>.json   same, svizzera
 *   slugs.json         id -> per-locale slug, plus the reverse map
 *
 * Run with tsx: the corpus sources use extensionless relative specifiers, which
 * plain Node ESM does not resolve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'api');
const LOCALES = ['it', 'en', 'de', 'fr'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const written = {};
const write = (name, value) => {
  const file = path.join(OUT, name);
  const json = JSON.stringify(value);
  fs.writeFileSync(file, json);
  written[name] = json.length;
  console.log(`[build-api] ${name}: ${json.length} bytes`);
  return value;
};

const load = async (rel) => import(path.join(ROOT, rel));

const { ARTICLES } = await load('content/blog-articles-data.ts');
const { SWISS_ARTICLES } = await load('content/swiss-articles-data.ts');
if (!Array.isArray(ARTICLES) || ARTICLES.length === 0) {
  throw new Error('ARTICLES is empty — refusing to publish an empty registry');
}
if (!Array.isArray(SWISS_ARTICLES)) {
  throw new Error('SWISS_ARTICLES is not an array');
}

write('articles.json', ARTICLES);
write('swiss-articles.json', SWISS_ARTICLES);

for (const loc of LOCALES) {
  const meta = (await load(`content/blog-meta-${loc}.ts`)).default;
  const metaCh = (await load(`content/blog-meta-ch-${loc}.ts`)).default;
  if (!meta || typeof meta !== 'object') throw new Error(`blog-meta-${loc} default is not an object`);
  if (!metaCh || typeof metaCh !== 'object') throw new Error(`blog-meta-ch-${loc} default is not an object`);
  write(`meta-${loc}.json`, meta);
  write(`meta-ch-${loc}.json`, metaCh);
}

const blogSlugs = await load('content/routerBlogData.ts');
const swissSlugs = await load('content/routerSwissData.ts');
write('slugs.json', {
  blog: blogSlugs.BLOG_SLUGS,
  blogReverse: blogSlugs.REVERSE_BLOG,
  swiss: swissSlugs.SWISS_SLUGS ?? null,
  swissReverse: swissSlugs.REVERSE_SWISS ?? null,
});

const commit = (() => {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
})();

write('manifest.json', {
  schema: 1,
  commit,
  generatedAt: new Date().toISOString(),
  counts: {
    articles: ARTICLES.length,
    swissArticles: SWISS_ARTICLES.length,
  },
  files: written,
});

console.log(`[build-api] wrote ${Object.keys(written).length} files to dist/api`);
