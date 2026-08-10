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
// repairSerpSnippet vive in clauseTail.mjs (un .mjs) proprio perche' questo file
// non puo' importare un .ts: e' la sorgente unica che il layer TS riesporta.
// Senza passarla, rssFeeds.mjs spedirebbe le description verbatim (#5453).
import { repairSerpSnippet } from '../host/shared/clauseTail.mjs';
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
// Sitemap retention for the dated daily editions (Bollettino del Frontaliere):
// the newest N stay listed, older ones are DE-LISTED but never deleted — same
// semantics as the swiss canonical-override shadowing below, same house rule
// ("never noindex, never delete HTML"). Imported so the selector has exactly
// one implementation, shared with the generator's tests.
import { selectRetiredDailyEditions } from '../generator/scripts/lib/daily-brief-content.mjs';
// Output-boundary sanitisation. The corpus is allowed to hold a control
// character — the generator wrote it, and two titles do — but nothing this
// script emits is: XML 1.0 admits no C0 but TAB/LF/CR, so a single 0x08 in one
// <image:title> makes the whole 3120-url sitemap not well-formed and a strict
// consumer may drop all of it. Applied at the four places bytes actually leave
// this process (write / writeXml / the RSS + candidates writes / the verbatim
// republishes), not at each field, so an emitter added later inherits it.
import {
  sanitizeDeep,
  sanitizeXmlDocument,
  sanitizeJsonText,
  assertNoControlChars,
} from './lib/sanitize-control-chars.mjs';
// Sanificare non basta: togliere il byte C0 distrugge il MARKER che rende esatta
// una riparazione futura. Qui si registra prima di distruggere (#95, #133).
import {
  reportStrippedControlChars,
  reportStrippedControlCharsDeep,
} from '../generator/scripts/lib/control-char-write-report.mjs';
// Pure XML builder, no .ts imports on purpose (see that file's header): lets
// generator/tests/frontaliere-sitemap-shadow.test.mjs exercise it directly
// under plain `node --test`, without a tsx subprocess.
import { SITE, xmlEsc, SECTION_PATHS, buildSitemap } from './lib/build-sitemap.mjs';

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
/** Daily-brief snapshot (Bollettino del Frontaliere) — same republish contract. */
const DAILY_BRIEF = 'daily-brief.json';

let newsCandidateCount = 0;
let imageCount = 0;
let borderRankingEntries = 0;
let dailyBriefBlocks = 0;

const written = {};
// Sanitised on the value, not on the serialised text: JSON.stringify ESCAPES a
// control character into `\u0008`, which is valid JSON and therefore survives
// any scan of the emitted bytes — while every consumer that parses the file
// gets the control character back. The only place to catch it is before the
// stringify. `written[name]` records the sanitised length, so manifest.json
// keeps describing the bytes actually served.
const write = (name, value) => {
  const file = path.join(OUT, name);
  const cleanValue = sanitizeDeep(value);
  // Prima della stringify, non dopo: JSON.stringify escapa i byte C0, quindi
  // sulla forma serializzata non ci sarebbe piu' niente da vedere (#133).
  reportStrippedControlCharsDeep(file, value, cleanValue);
  const json = JSON.stringify(cleanValue);
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
//
// SITE, xmlEsc, SECTION_PATHS and buildSitemap() itself live in
// ./lib/build-sitemap.mjs (imported above) — moved there so the sitemap logic
// can be unit-tested under plain `node --test` (see that file's header).

// One sanitisation point for every sitemap this file emits, on the assembled
// document rather than on each interpolated field: xmlEsc() escapes the five
// markup characters and has nothing to say about a control byte, and the parts
// that skip xmlEsc entirely (<loc>, <lastmod>) are as capable of carrying one.
const writeXml = (name, { xml, count }) => {
  const clean = sanitizeXmlDocument(xml);
  reportStrippedControlChars(path.join(OUT, name), xml, clean);
  assertNoControlChars(clean, name);
  fs.writeFileSync(path.join(OUT, name), clean);
  written[name] = clean.length;
  console.log(`[build-api] ${name}: ${count} urls, ${(clean.match(/xhtml:link/g) ?? []).length} alternates, ${clean.length} bytes`);
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

// Same mechanism, frontaliere section (issue #138 item 1). The file is the
// engine's, not the corpus's: it ships inside packages/articles/engine/shared/
// on the site and lands at engine/shared/ here via mirror-articles-engine.yml
// (see that file's _doc for why it lives in the engine and not in content/).
// Same shape as the swiss map — a flat `overrides` object keyed by the
// shadowed slug — so the same Object.keys() extraction applies unchanged; the
// only structural difference is an extra `_groups` block that documents which
// shadowed slugs share a winner, which this reader does not need.
const shadowedFrontaliereSlugs = new Set(
  Object.keys(
    JSON.parse(
      fs.readFileSync(path.join(ROOT, 'engine', 'shared', 'frontaliere-article-canonical-overrides.json'), 'utf-8'),
    ).overrides ?? {},
  ),
);
console.log(`[build-api] shadowed frontaliere slugs excluded: ${shadowedFrontaliereSlugs.size}`);

const metaIt = (await load('content/blog-meta-it.ts')).default;
const metaChIt = (await load('content/blog-meta-ch-it.ts')).default;
// Daily editions carry their date in the id, and slugs.it === id, so the
// retired set plugs straight into buildSitemap's shadowed parameter.
const retiredDailyEditions = selectRetiredDailyEditions(ARTICLES.map((a) => a.id));
console.log(`[build-api] retired daily editions de-listed from sitemap: ${retiredDailyEditions.size}`);
// buildSitemap takes a single `shadowed` set, so the frontaliere call unions
// the two de-listing reasons — retired daily editions and canonical-shadowed
// duplicates — the same way the svizzera call already gets its own dedicated set.
const frontaliereSitemapShadow = new Set([...retiredDailyEditions, ...shadowedFrontaliereSlugs]);
const sitemapCounts = {
  blog: writeXml(
    'sitemap-blog.xml',
    buildSitemap(ARTICLES, 'frontaliere', blogSlugs.BLOG_SLUGS, metaIt, frontaliereSitemapShadow),
  ),
  blogCh: writeXml(
    'sitemap-blog-ch.xml',
    buildSitemap(SWISS_ARTICLES, 'svizzera', swissSlugs.SWISS_SLUGS, metaChIt, shadowedSwissSlugs),
  ),
};
if (sitemapCounts.blog < 100) {
  throw new Error(`sitemap-blog.xml has only ${sitemapCounts.blog} urls — refusing to publish`);
}

// ── Archive pages (issue #4974) ───────────────────────────────────────────
// `/{section}/{all}/` and its `page-N` chain existed and appeared in NO
// sitemap. `emitSeoHubs` pushes an entry per page, but only into the sitemap
// the site build writes — and the site stopped emitting these pages when
// BUILD_EMIT_SKIP went on, while fast-publish (which does emit them) passes
// `sitemapEntries: []`. Measured on the live index: zero archive URLs across
// every sitemap it lists. With every locale now emitting every page, that is
// ~240 indexable pages declared nowhere.
//
// Page count comes from the SAME union the emitter paginates
// (`readArticleArchiveUnionSlugs`), so this file cannot list a page the
// archive does not have. The page size is spelled out rather than read from
// the site shell, which does not exist in this process — see the ticker call
// below for the same reason. It must track ARTICLES_PAGE_SIZE in
// `build-plugins/seoHubsData.ts`; the count assertion below is what catches a
// drift.
const ARCHIVE_ALL_SLUG = { it: 'tutti', en: 'all', de: 'alle', fr: 'tous' };
const ARCHIVE_PAGE_SIZE = 100;
const { readArticleArchiveUnionSlugs } = await load('engine/shared/articleArchiveUnion.ts');
const { ARTICLE_SECTIONS } = await load('articleSections.ts');

function archiveBase(section, locale) {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/${ARTICLE_SECTIONS[section].indexSlug[locale]}/${ARCHIVE_ALL_SLUG[locale]}/`;
}

function buildArchiveSitemap() {
  const urls = [];
  for (const section of ['frontaliere', 'svizzera']) {
    const total = readArticleArchiveUnionSlugs(fs, path, ROOT, section).size;
    const pages = Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));
    for (const locale of LOCALES) {
      for (let page = 1; page <= pages; page++) {
        const base = archiveBase(section, locale);
        const loc = page === 1 ? base : `${base.slice(0, -1)}/page-${page}/`;
        const parts = [`  <url>`, `    <loc>${SITE}${loc}</loc>`];
        // Alternates on page 1 only — that is where the emitted page carries
        // hreflang (buildHtml gates them the same way). Declaring alternates
        // the page itself does not serve is its own SEO defect.
        if (page === 1) {
          for (const alt of LOCALES) {
            parts.push(
              `    <xhtml:link rel="alternate" hreflang="${alt}" href="${SITE}${archiveBase(section, alt)}" />`,
            );
          }
          parts.push(
            `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${archiveBase(section, 'it')}" />`,
          );
        }
        parts.push(`    <changefreq>daily</changefreq>`);
        parts.push(`    <priority>${page === 1 ? '0.6' : '0.4'}</priority>`);
        parts.push(`  </url>`);
        urls.push(parts.join('\n'));
      }
    }
  }
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
      `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
      urls.join('\n') +
      `\n</urlset>\n`,
    count: urls.length,
  };
}

sitemapCounts.archive = writeXml('sitemap-articles-archive.xml', buildArchiveSitemap());
// Two sections x four locales, so the count is 4 x (frontalierePages +
// svizzeraPages) — under 8 means a section resolved to a single empty page,
// which is the shape a broken registry parse takes.
if (sitemapCounts.archive < 8) {
  throw new Error(
    `sitemap-articles-archive.xml has only ${sitemapCounts.archive} urls — refusing to publish`,
  );
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
  // Il corpus e' il produttore REALE dei dieci feed: il sito chiama
  // buildAllRssFeeds solo dai test. Se questa riga manca, la riparazione della
  // coda resta inerte in produzione dietro una CI verde del sito — la stessa
  // forma dell'incidente SiteShellContract. L'engine attuale ignora il
  // parametro; quello che arriva col prossimo mirror lo pretende.
  repairSerpSnippet,
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
    // The feeds come out of engine/rssFeeds.mjs, which arrives by mirror and is
    // not ours to edit here (a change would be overwritten on the next mirror
    // run). Sanitising where this script writes them keeps the fix in the repo
    // that owns the write, and covers whatever the shared builder hands over.
    const clean = sanitizeXmlDocument(xml);
    reportStrippedControlChars(path.join(OUT, name), xml, clean);
    assertNoControlChars(clean, name);
    fs.writeFileSync(path.join(OUT, name), clean);
    written[name] = clean.length;
    rssFeedCount++;
    rssItemTotal += items;
    console.log(`[build-api] ${name}: ${items} items, ${clean.length} bytes`);
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

  const collect = (entries, sectionId, slugMap, meta, shadowed = new Set()) => {
    const paths = SECTION_PATHS[sectionId];
    for (const a of entries) {
      const slug = slugMap?.[a.id]?.it;
      if (!slug) continue;
      // Same self-canonical gate sitemap-blog.xml enforces (buildSitemap in
      // scripts/lib/build-sitemap.mjs): a canonical-shadowed article's own page
      // points elsewhere, so listing its <loc> here is the same defect this PR
      // fixes for the blog sitemap, just in the news-candidates feed instead.
      if (shadowed.has(slug)) continue;
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

  collect(ARTICLES, 'frontaliere', blogSlugs.BLOG_SLUGS, metaIt, frontaliereSitemapShadow);
  collect(SWISS_ARTICLES, 'svizzera', swissSlugs.SWISS_SLUGS, metaChIt, shadowedSwissSlugs);

  const candidatesXmlRaw =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
      `        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"\n` +
      `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"\n` +
      `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
      (candidateBlocks.length ? candidateBlocks.join('\n') + '\n' : '') +
      `</urlset>\n`;
  const candidatesXml = sanitizeXmlDocument(candidatesXmlRaw);
  reportStrippedControlChars(path.join(OUT, NEWS_CANDIDATES), candidatesXmlRaw, candidatesXml);
  assertNoControlChars(candidatesXml, NEWS_CANDIDATES);

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
    // Still verbatim in the normal case: sanitizeJsonText returns the original
    // text unless the document actually carries a control character.
    const clean = sanitizeJsonText(raw);
    reportStrippedControlChars(path.join(OUT, BORDER_RANKING), raw, clean);
    fs.writeFileSync(path.join(OUT, BORDER_RANKING), clean);
    written[BORDER_RANKING] = clean.length;
    borderRankingEntries = entries.length;
    console.log(`[build-api] ${BORDER_RANKING}: ${entries.length} crossings, ${clean.length} bytes`);
  } else {
    console.log(
      `[build-api] ${BORDER_RANKING}: not emitted — the ranking producer has not run here yet`,
    );
  }
}

// Daily-brief snapshot (Bollettino del Frontaliere): same contract as the
// border-wait ranking above — republished verbatim from the generator's
// output, absent until refresh-daily-brief-data.mjs has run here at least
// once. Consumers (the daily email digest) refuse a set they can't trust via
// `counts.availableBlocks` and `dateIso`, so the only thing worth refusing at
// build time is a payload that carries no blocks at all.
{
  const src = path.join(ROOT, 'public', 'data', 'daily-brief.json');
  if (fs.existsSync(src)) {
    const raw = fs.readFileSync(src, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`public/data/daily-brief.json is not valid JSON: ${err.message}`);
    }
    const available = Number(parsed?.counts?.availableBlocks);
    if (!Number.isFinite(available) || available < 1) {
      throw new Error('daily-brief.json carries no available blocks — refusing to publish');
    }
    const clean = sanitizeJsonText(raw);
    reportStrippedControlChars(path.join(OUT, DAILY_BRIEF), raw, clean);
    fs.writeFileSync(path.join(OUT, DAILY_BRIEF), clean);
    written[DAILY_BRIEF] = clean.length;
    dailyBriefBlocks = available;
    console.log(`[build-api] ${DAILY_BRIEF}: ${available}/4 blocks (${parsed?.dateIso}), ${clean.length} bytes`);
  } else {
    console.log(
      `[build-api] ${DAILY_BRIEF}: not emitted — the daily-brief producer has not run here yet`,
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
    dailyBriefBlocks,
  },
  files: written,
});

console.log(`[build-api] wrote ${Object.keys(written).length} files to dist/api`);

// ── Final gate: no control character leaves this process ──────────────────
//
// Deliberately a tautology over the writers above — its job is the writer that
// does NOT exist yet. Every artifact here went through a sanitiser, so this
// pass is silent today; the day someone adds an emitter and forgets, the build
// that adds it fails, instead of a crawler discovering three days later that
// sitemap-blog.xml is not well-formed. The scan is on the RAW BYTES of every
// text artifact, which is why it can only ever be the last word: JSON hides a
// control character behind an escape, so this catches the XML spelling and
// `sanitizeDeep` (at `write`) catches the JSON one.
{
  const textFiles = fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith('.xml') || f.endsWith('.json'));
  for (const f of textFiles) {
    assertNoControlChars(fs.readFileSync(path.join(OUT, f), 'utf-8'), `dist/api/${f}`);
  }
  console.log(`[build-api] control-character gate: ${textFiles.length} text artifacts clean`);
}
