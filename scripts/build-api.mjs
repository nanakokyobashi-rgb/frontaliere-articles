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
 *   sitemap-blog.xml / sitemap-blog-ch.xml   article sitemaps, with hreflang
 *   rss*.xml           ten RSS feeds (two sections x four locales + main copy)
 *   news-ticker-live.json  the homepage ticker's five newest articles
 *   sitemap-news-candidates.xml  Google News candidates (migration §7.2)
 *   images-manifest.json + images/blog/*.webp  hero images (migration §7.1),
 *                      emitted ONLY when this repo actually holds images
 *
 * Run with tsx: the corpus sources use extensionless relative specifiers, which
 * plain Node ESM does not resolve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { buildAllRssFeeds, RSS_SECTIONS } from '../engine/rssFeeds.mjs';
// The vendored Google News whitelist (issue #4974 item 3, §5.3). Imported, not
// re-copied: main pulls the eligibility decision from this repo and a third copy
// of the token list is exactly the drift that module's header warns about. A
// static import is also the point — the failure this replaced was a regex parse
// that silently returned [], which `isArticleNewsEligible` would read as
// allow-all. A missing module throws; an empty list does not.
import {
  isArticleNewsEligible,
  NEWS_SITEMAP_WINDOW_HOURS,
} from '../generator/data/news-sitemap-whitelist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'api');
const LOCALES = ['it', 'en', 'de', 'fr'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Migration artifact names (docs/articles-generator-migration.md §7). Spelled
// exactly as scripts/pull-articles-api.mjs fetches them in the site repo.
const NEWS_CANDIDATES = 'sitemap-news-candidates.xml';
const IMAGE_MANIFEST = 'images-manifest.json';
/** Site-consumed ranking snapshot republished from the generator's output (§4). */
const BORDER_RANKING = 'border-wait-ranking.json';

let newsCandidateCount = 0;
let imageCount = 0;
let borderRankingEntries = 0;

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

// ── RSS feeds ─────────────────────────────────────────────────────
//
// Same argument as the sitemaps: the feeds are a pure function of the corpus,
// so the repo that owns the corpus is the one that can emit them without being
// a publish cycle behind. The generator itself is NOT reimplemented here — it
// is `engine/rssFeeds.mjs`, the very module the site repo calls, arriving with
// the mirror. A second copy would drift silently: nobody diffs a feed once it
// is served, so a divergence surfaces only when an aggregator drops the channel.
//
// `layout` is the whole difference between the two callers: the site keeps the
// corpus under services/, this repo under content/.
const rssSections = buildAllRssFeeds({
  fs,
  path,
  rootDir: ROOT,
  registries: { frontaliere: ARTICLES, svizzera: SWISS_ARTICLES },
  layout: { seoDir: 'content/seo', localesDir: 'content', slugDir: 'content' },
});

let rssFeedCount = 0;
let rssItemTotal = 0;
for (const section of rssSections) {
  if (section.feeds.length === 0) {
    throw new Error(
      `rss: section '${section.id}' produced no feeds (${section.articleCount} articles parsed) — refusing to publish`,
    );
  }
  for (const [name, xml] of section.feeds) {
    const items = (xml.match(/<item>/g) ?? []).length;
    if (items === 0) throw new Error(`rss: ${name} has no <item> entries — refusing to publish`);
    fs.writeFileSync(path.join(OUT, name), xml);
    written[name] = xml.length;
    rssFeedCount++;
    rssItemTotal += items;
    console.log(`[build-api] ${name}: ${items} items, ${xml.length} bytes`);
  }
}

// ── News-ticker payload ───────────────────────────────────────────
//
// The homepage ticker shows the 5 newest articles. The site used to compute
// this at build time from its own copy of the corpus; it now consumes this
// file, which means a newly published article reaches the ticker without a
// site build. `hubLocales` is passed explicitly — `computeTickerArticles`
// otherwise reads it from the site shell, which does not exist here (that
// coupling is exactly what issue #4974 item 2 removed).
const { computeTickerArticles } = await load('engine/newsTickerDataPlugin.ts');
const tickerArticles = computeTickerArticles(fs, path, ROOT, ARTICLES, {
  hubLocales: LOCALES,
  metaDir: 'content',
  slugDataFile: 'content/routerBlogData.ts',
});
if (tickerArticles.length === 0) {
  throw new Error('news-ticker-live.json would be empty — refusing to publish');
}
for (const art of tickerArticles) {
  for (const loc of LOCALES) {
    if (!art.title?.[loc] || art.title[loc] === `blog.article.${art.id}.title`) {
      throw new Error(
        `news-ticker: article '${art.id}' has no ${loc} title (raw i18n key would ship) — refusing to publish`,
      );
    }
    if (!art.slug?.[loc]) {
      throw new Error(`news-ticker: article '${art.id}' has no ${loc} slug — refusing to publish`);
    }
  }
}
write('news-ticker-live.json', { schema: 1, articles: tickerArticles });

// ── Google News candidates (migration §7.2) ───────────────────────
//
// §3 picks option (a): THIS repo decides Google News eligibility once, from the
// whitelist vendored into its own tree, and publishes the resulting <url> blocks
// as candidates. The site never re-decides eligibility — it merges these over
// what it is serving and applies the mechanical 48h prune. Two independent
// eligibility codepaths is the "two producers, last writer wins" failure that
// create-article's own modifySitemap() comment warns about.
//
// Derived from the corpus rather than accumulated in a committed file, for the
// same reason sitemap-blog.xml and the feeds are: a state file that create-article
// appends to would be a second source of truth that drifts the moment a run dies
// between writing the corpus and writing the file. This is a pure function of the
// registry, so republishing on every push is idempotent and self-healing.
//
// The candidate set is ALLOWED to be empty, and the file is emitted anyway: the
// window prunes it every day and a quiet day is a correct outcome, not an absence.
// The consumer accepts an empty <urlset> and refuses a non-sitemap document, so
// emitting always is also what lets it run under --require-new.
{
  /**
   * Per-article SEO text the whitelist matches on. `keywords` lives only in the
   * seo-blog*.ts chunks, so it has to be read from there; `articleSection` and
   * `tags` are NOT persisted anywhere in this repo (create-article has them only
   * in memory during generation), so the registry's `category` stands in for
   * articleSection and tags are simply absent. That is the whole of what the
   * corpus retains — not a sampling of it.
   */
  const seoTextById = new Map();
  for (const section of RSS_SECTIONS) {
    for (const file of section.seoFiles) {
      const fp = path.join(ROOT, 'content', 'seo', file);
      if (!fs.existsSync(fp)) continue;
      const src = fs.readFileSync(fp, 'utf-8');
      const entryRe = /'blog-([^']+)':\s*\{/g;
      const positions = [];
      let m;
      while ((m = entryRe.exec(src)) !== null) positions.push({ id: m[1], start: m.index });
      for (let i = 0; i < positions.length; i++) {
        const { id, start } = positions[i];
        const end = i + 1 < positions.length ? positions[i + 1].start : src.length;
        const block = src.slice(start, Math.min(end, start + 4000));
        // `(?:[^'\\]|\\.)*` rather than `[^']+`: create-article escapes literal
        // apostrophes into these values, and the naive class stops at the
        // backslash-quote — which in Italian truncates a third of the corpus
        // (the bug engine/rssFeeds.mjs documents against its own parser).
        const keywords = block.match(/keywords:\s*'((?:[^'\\]|\\.)*)'/)?.[1];
        const headline = block.match(/"headline":\s*"((?:[^"\\]|\\.)*)"/)?.[1];
        seoTextById.set(id, { keywords, headline });
      }
    }
  }

  const NEWS_PUBLICATION = 'Frontaliere Ticino';
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  const candidateBlocks = [];
  let considered = 0;

  const collect = (entries, sectionId, slugMap, meta) => {
    const paths = SECTION_PATHS[sectionId];
    for (const a of entries) {
      const slug = slugMap?.[a.id]?.it;
      if (!slug) continue;
      const publishedAt = a.date;
      if (!publishedAt) continue;
      considered += 1;

      const title = meta[`blog.article.${a.id}.title`] || '';
      const seo = seoTextById.get(a.id) ?? {};
      // headline and title are the same string for every generator-written
      // article, but create-article's own gate reads BOTH — so both are fed in
      // rather than assuming they agree. They go into the `title` slot because
      // the vendored predicate is a byte-faithful mirror of main's, and adding a
      // field to it here is precisely the divergence the vendoring forbids.
      const titleText = [title, seo.headline].filter(Boolean).join(' ');

      if (
        !isArticleNewsEligible(
          {
            slug,
            title: titleText,
            articleSection: a.category,
            keywords: seo.keywords,
            publishedAt,
          },
          now,
        )
      ) {
        continue;
      }

      const itLoc = `${SITE}${paths.it}${slug}/`;
      const img = a.image ? (a.image.startsWith('http') ? a.image : SITE + a.image) : null;

      const parts = [`  <url>`, `    <loc>${itLoc}</loc>`, `    <lastmod>${today}</lastmod>`];
      for (const loc of LOCALES) {
        const s2 = slugMap?.[a.id]?.[loc];
        if (s2) {
          parts.push(
            `    <xhtml:link rel="alternate" hreflang="${loc}" href="${SITE}${paths[loc]}${s2}/" />`,
          );
        }
      }
      parts.push(
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${itLoc}" />`,
        `    <news:news>`,
        `      <news:publication>`,
        `        <news:name>${NEWS_PUBLICATION}</news:name>`,
        `        <news:language>it</news:language>`,
        `      </news:publication>`,
        // The consumer refuses a block without this field and prunes on it, so
        // it carries the registry's own timestamp verbatim. Generator-written
        // entries hold a full ISO instant; the handful of legacy day-only dates
        // resolve to midnight UTC, which costs part of a window but never
        // fabricates freshness.
        `      <news:publication_date>${xmlEsc(publishedAt)}</news:publication_date>`,
        `      <news:title>${xmlEsc(title)}</news:title>`,
        `    </news:news>`,
      );
      if (img) {
        parts.push(
          `    <image:image>`,
          `      <image:loc>${xmlEsc(img)}</image:loc>`,
          `      <image:title>${xmlEsc(title)}</image:title>`,
          `    </image:image>`,
        );
      }
      parts.push(`  </url>`);
      candidateBlocks.push(parts.join('\n'));
    }
  };

  collect(ARTICLES, 'frontaliere', blogSlugs.BLOG_SLUGS, metaIt);
  collect(SWISS_ARTICLES, 'svizzera', swissSlugs.SWISS_SLUGS, metaChIt);

  const candidatesXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"\n` +
    `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"\n` +
    `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    (candidateBlocks.length ? candidateBlocks.join('\n') + '\n' : '') +
    `</urlset>\n`;

  fs.writeFileSync(path.join(OUT, NEWS_CANDIDATES), candidatesXml);
  written[NEWS_CANDIDATES] = candidatesXml.length;
  newsCandidateCount = candidateBlocks.length;
  console.log(
    `[build-api] ${NEWS_CANDIDATES}: ${candidateBlocks.length} candidates from ` +
      `${considered} dated articles (${NEWS_SITEMAP_WINDOW_HOURS}h window), ${candidatesXml.length} bytes`,
  );
}

// ── Hero images (migration §7.1) ──────────────────────────────────
//
// Unlike every other artifact here an image cannot be re-derived by the consumer,
// so it has to be transferred. The manifest is a plain list, not a diff: it is
// republished whole on every push and the site downloads only what it is missing,
// which keeps the pull idempotent without either side tracking the other's state.
//
// Emitted ONLY when there is at least one image. The consumer refuses a manifest
// listing zero images — deliberately, since an empty list is indistinguishable
// from a publisher that broke halfway — so publishing one while generation still
// runs in the site repo (and this repo therefore holds no images at all) would
// turn every sync red. Absence is the correct signal until the generator cuts
// over and starts writing public/images/blog/ here.
{
  const srcDir = path.join(ROOT, 'public', 'images', 'blog');
  const files = fs.existsSync(srcDir)
    ? fs.readdirSync(srcDir).filter((f) => f.endsWith('.webp')).sort()
    : [];

  if (files.length === 0) {
    console.log(
      `[build-api] ${IMAGE_MANIFEST}: not emitted — public/images/blog holds no .webp ` +
        `(the consumer refuses a zero-image manifest; absence is the correct signal)`,
    );
  } else {
    const destDir = path.join(OUT, 'images', 'blog');
    fs.mkdirSync(destDir, { recursive: true });
    const images = [];
    for (const file of files) {
      const bytes = fs.readFileSync(path.join(srcDir, file));
      fs.writeFileSync(path.join(destDir, file), bytes);
      images.push({ id: file.replace(/\.webp$/, ''), path: `images/blog/${file}`, bytes: bytes.length });
    }
    write(IMAGE_MANIFEST, { commit, images });
    imageCount = images.length;
    console.log(`[build-api] images/blog: ${images.length} files copied to dist/api`);
  }
}

// ── Border-wait ranking snapshot (migration §4) ───────────────────
//
// generate-border-wait-ranking-article.mjs writes public/data/border-wait-ranking.json
// alongside the article bodies. That file is NOT article content — it feeds the
// site's InlineBorderWaitRanking chart — so §4 left it as an open question:
// either the site keeps producing it, or this repo produces it and the site pulls
// it. This is the second option, and it is the only one consistent with the rest
// of the split: the ranking is computed from the same 7-day window this repo
// already fetches, so having the site recompute it would mean two producers of
// one number, disagreeing whenever their windows differ by a run.
//
// Republished verbatim, not re-derived: whatever the generator wrote is what the
// site gets. Absent until the ranking producer has run at least once here, which
// is why this is emitted conditionally rather than gated — the site's pull treats
// it exactly like the image manifest, absence meaning "not produced yet".
{
  const src = path.join(ROOT, 'public', 'data', 'border-wait-ranking.json');
  if (fs.existsSync(src)) {
    const raw = fs.readFileSync(src, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`public/data/border-wait-ranking.json is not valid JSON: ${err.message}`);
    }
    // A ranking with no crossings would blank the live chart. Refuse rather than
    // publish it — the site cannot tell an empty ranking from a broken one.
    const entries = Array.isArray(parsed?.ranking) ? parsed.ranking : null;
    if (!entries || entries.length === 0) {
      throw new Error('border-wait-ranking.json carries no ranking entries — refusing to publish');
    }
    fs.writeFileSync(path.join(OUT, BORDER_RANKING), raw);
    written[BORDER_RANKING] = raw.length;
    borderRankingEntries = entries.length;
    console.log(`[build-api] ${BORDER_RANKING}: ${entries.length} crossings, ${raw.length} bytes`);
  } else {
    console.log(
      `[build-api] ${BORDER_RANKING}: not emitted — the ranking producer has not run here yet`,
    );
  }
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
    rssFeeds: rssFeedCount,
    rssItems: rssItemTotal,
    tickerArticles: tickerArticles.length,
    newsCandidates: newsCandidateCount,
    images: imageCount,
    borderRankingEntries,
  },
  files: written,
});

console.log(`[build-api] wrote ${Object.keys(written).length} files to dist/api`);
