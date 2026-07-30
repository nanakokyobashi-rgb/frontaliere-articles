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



// ── Sitemaps ──────────────────────────────────────────────────────
//
// The article sitemaps are derived entirely from data this repo owns — registry,
// per-locale meta, slug maps — so they belong here, not in the site repo. Emitting
// them alongside the JSON is what lets a new article be announced to crawlers
// without the site deploying: the site serves these as static files.
//
// Shape matches what the site published before the split, byte-for-byte in
// structure: IT locs only, an image block, lastmod, monthly/0.7.
const SITE = 'https://frontaliereticino.ch';

const xmlEsc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Per-locale section prefix. hreflang alternates are NOT optional decoration: the
// site's committed sitemaps carry five links per url (it/en/de/fr/x-default) and
// publishing without them would silently drop every alternate from the index.
const SECTION_PATHS = {
  frontaliere: {
    it: '/articoli-frontaliere/',
    en: '/en/cross-border-articles/',
    de: '/de/grenzgaenger-artikel/',
    fr: '/fr/articles-frontalier/',
  },
  svizzera: {
    it: '/articoli-svizzera/',
    en: '/en/swiss-articles/',
    de: '/de/schweiz-artikel/',
    fr: '/fr/articles-suisse/',
  },
};

function buildSitemap(entries, section, slugMap, meta, shadowed = new Set()) {
  const paths = SECTION_PATHS[section];
  const sectionPath = paths.it;
  const urls = [];
  for (const a of entries) {
    const slug = slugMap?.[a.id]?.it;
    if (!slug) continue;
    // A canonical-overridden ("shadowed") article points its canonical at a
    // different winner URL, so listing it here — as <loc> OR as an hreflang
    // alternate — contradicts the self-canonical gate the consumer enforces
    // (tests/blog-slugs-sitemap-sync.test.ts, guarding against #3120).
    if (shadowed.has(slug)) continue;
    const title = meta[`blog.article.${a.id}.title`];
    const alt = meta[`blog.article.${a.id}.imageAlt`];
    const lastmod = a.updatedAt || a.date || '';
    const img = a.image ? (a.image.startsWith('http') ? a.image : SITE + a.image) : null;
    const parts = [`  <url>`, `    <loc>${SITE}${sectionPath}${slug}/</loc>`];
    if (img) {
      parts.push(`    <image:image>`);
      parts.push(`      <image:loc>${xmlEsc(img)}</image:loc>`);
      if (title) parts.push(`      <image:title>${xmlEsc(title)}</image:title>`);
      if (alt) parts.push(`      <image:caption>${xmlEsc(alt)}</image:caption>`);
      parts.push(`    </image:image>`);
    }
    for (const loc of ['it', 'en', 'de', 'fr']) {
      const s2 = slugMap?.[a.id]?.[loc];
      if (s2) {
        parts.push(
          `    <xhtml:link rel="alternate" hreflang="${loc}" href="${SITE}${paths[loc]}${s2}/" />`,
        );
      }
    }
    parts.push(
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${sectionPath}${slug}/" />`,
    );
    if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
    parts.push(`    <changefreq>monthly</changefreq>`);
    parts.push(`    <priority>0.7</priority>`);
    parts.push(`  </url>`);
    urls.push(parts.join('\n'));
  }
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
      `        xmlns:xhtml="http://www.w3.org/1999/xhtml"\n` +
      `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
      urls.join('\n') +
      `\n</urlset>\n`,
    count: urls.length,
  };
}

const writeXml = (name, { xml, count }) => {
  fs.writeFileSync(path.join(OUT, name), xml);
  written[name] = xml.length;
  console.log(`[build-api] ${name}: ${count} urls, ${(xml.match(/xhtml:link/g) ?? []).length} alternates, ${xml.length} bytes`);
  return count;
};

// Canonical overrides travel WITH the corpus: they decide which swiss articles
// may appear in the sitemap at all, so keeping them in the site repo would leave
// this publisher unable to produce a correct file.
const shadowedSwissSlugs = new Set(
  Object.keys(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'swiss-article-canonical-overrides.json'), 'utf-8'))
      .overrides ?? {},
  ),
);
console.log(`[build-api] shadowed swiss slugs excluded: ${shadowedSwissSlugs.size}`);

const metaIt = (await load('content/blog-meta-it.ts')).default;
const metaChIt = (await load('content/blog-meta-ch-it.ts')).default;
const sitemapCounts = {
  blog: writeXml(
    'sitemap-blog.xml',
    buildSitemap(ARTICLES, 'frontaliere', blogSlugs.BLOG_SLUGS, metaIt),
  ),
  blogCh: writeXml(
    'sitemap-blog-ch.xml',
    buildSitemap(SWISS_ARTICLES, 'svizzera', swissSlugs.SWISS_SLUGS, metaChIt, shadowedSwissSlugs),
  ),
};
if (sitemapCounts.blog < 100) {
  throw new Error(`sitemap-blog.xml has only ${sitemapCounts.blog} urls — refusing to publish`);
}

// Written last: it records the byte size of every other artifact.
write('manifest.json', {
  schema: 1,
  commit,
  generatedAt: new Date().toISOString(),
  counts: {
    articles: ARTICLES.length,
    swissArticles: SWISS_ARTICLES.length,
    sitemapBlogUrls: sitemapCounts.blog,
    sitemapBlogChUrls: sitemapCounts.blogCh,
  },
  files: written,
});

console.log(`[build-api] wrote ${Object.keys(written).length} files to dist/api`);
