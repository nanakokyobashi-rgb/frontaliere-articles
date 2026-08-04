#!/usr/bin/env node
/**
 * Refresh the `ssg-article-grid` on the article-hub LANDING pages.
 *
 * ─── The gap this closes ─────────────────────────────────────────────────
 * Three article surfaces exist per section, and until now this repo owned
 * only two of them:
 *
 *   /articoli-frontaliere/<slug>/   the article        — fast-publish ✅
 *   /articoli-frontaliere/tutti/    the archive        — fast-publish ✅
 *   /articoli-frontaliere/          the LANDING        — site build only ❌
 *
 * The landing was written by the site's full build and pushed to the shard
 * from there. When `ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP` was turned on
 * (2026-07-29 19:28) the site stopped writing it and nothing took over. Every
 * article published since is live at its own URL, listed in `/tutti/`, and in
 * the sitemap — but the page a reader actually lands on kept showing the set
 * frozen that evening. Nothing failed; that is why it lasted a week.
 *
 * ─── Why a patch and not a re-render ─────────────────────────────────────
 * The landing is mostly editorial copy, an FAQ block, nav and head — the site
 * build's output, none of it a function of the corpus. Re-rendering the whole
 * page here would mean porting ~5000 lines of staticPagesPlugin and would put
 * this repo in the business of owning prose it has no source for. Only the
 * grid depends on the corpus, so only the grid is replaced — through the same
 * renderer the site uses (`engine/articlesHubCards.ts`), so the two emitters
 * cannot drift into different markup.
 *
 * ─── Fail-closed ─────────────────────────────────────────────────────────
 * A page whose current HTML cannot be fetched, or whose grid marker is
 * missing or unbalanced, is SKIPPED — never written half-formed. A truncated
 * hub still answers 200, so "write something" is the wrong default. The run
 * exits non-zero only when it refreshed nothing at all, which is the case
 * that means the mechanism itself is broken rather than one shard being slow.
 *
 * Usage:
 *   npx -y tsx@4 scripts/refresh-hub-landing.mjs --out <dir> [--section frontaliere|svizzera]
 *
 * Emits: <out>/articoli-frontaliere/index.html          (it)
 *        <out>/<loc>/<localized-slug>/index.html        (en, de, fr)
 * plus a JSON line per page so the workflow log carries what moved.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = path.resolve(argOf('--out', path.join(ROOT, 'dist', 'hub-landing')));
const SUMMARY = argOf('--summary', '');
const ONLY_SECTION = argOf('--section', '');
const LOCALES = argOf('--locales', 'it,en,de,fr').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Sanity floor for a fetched landing. The smallest real one is the svizzera
 * hub at ~9 KB (copy + a CTA, no grid); anything under 4 KB is an error page
 * or a truncated body, not a page worth patching.
 */
const MIN_LANDING_BYTES = 4096;

/**
 * Sections that demonstrably HAVE a grid today. If one of these refreshes
 * nothing, the mechanism is broken and the run must say so — reporting
 * "nothing to refresh" and exiting 0 is precisely the silent-staleness shape
 * that let the hub sit a week behind in the first place.
 */
const EXPECT_GRID = new Set(
  argOf('--expect-grid', 'frontaliere').split(',').map((s) => s.trim()).filter(Boolean),
);

const SECTIONS = [
  {
    name: 'frontaliere',
    shardKey: 'articolifrontaliere',
    registry: 'content/blog-articles-data.ts',
    registryExport: 'ARTICLES',
    slugFile: 'content/routerBlogData.ts',
    slugExport: 'BLOG_SLUGS',
    metaPrefix: 'blog-meta',
  },
  {
    name: 'svizzera',
    shardKey: 'articolisvizzera',
    registry: 'content/swiss-articles-data.ts',
    registryExport: 'SWISS_ARTICLES',
    slugFile: 'content/routerSwissData.ts',
    slugExport: 'SWISS_SLUGS',
    metaPrefix: 'blog-meta-ch',
  },
].filter((s) => !ONLY_SECTION || s.name === ONLY_SECTION);

const shardSlugs = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/lib/section-shard-slugs.json'), 'utf-8'));
const shardOwners = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/lib/section-shard-owners.json'), 'utf-8'));

const { renderArticleHubCards, replaceArticleHubCards } = await import('../engine/articlesHubCards.ts');
const { rewriteBlogImageRefs, hasBlogImageLeak } = await import('../engine/blogImageCdnFinalize.ts');

/** Trailing-slash key form, identical to staticPagesPlugin's `seoKey`. */
const seoKey = (p) => {
  const clean = String(p).replace(/\/+$/, '');
  return clean ? `${clean}/` : '/';
};

/** Balanced `{...}` starting at `open`, or null. Mirrors the site's extractor. */
function extractBalanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

/**
 * `canonicalPath → { title, desc }` out of `content/seo/*.ts`.
 *
 * THE point of this reader: the site renders its cards from this same map
 * (`staticPagesPlugin.ts`, `seoMap.ogT` / `seoMap.desc`), while this repo's
 * meta chunks carry a DIFFERENT, un-tuned string. Reading the corpus's own
 * `blog-meta-*` here instead produced 59 differing titles out of 63 cards
 * compared against what production serves — every fast-publish would have
 * rewritten the hub's SEO titles and the next full build would have put them
 * back. Same map, same field precedence (`ogTitle || title`), same unescaping,
 * so the two emitters agree by construction rather than by luck.
 *
 * Only IT paths exist in these files (4617 entries, zero under /en|/de|/fr),
 * so non-IT cards still come from the meta chunks — and the fail-closed gate
 * below is what keeps that from silently degrading those pages.
 */
function readSeoMap() {
  const dir = path.join(ROOT, 'content', 'seo');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;

  const matchStr = (block, key) => {
    const rxSingle = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`);
    const rxDouble = new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = block.match(rxSingle) || block.match(rxDouble);
    return m?.[1]?.replace(/\\(.)/g, (_, c) => (c === 'n' ? ' ' : c === 'r' ? '' : c === 't' ? ' ' : c)) ?? '';
  };

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf-8');
    const entryStartRx = /['"][^'"]+['"]\s*:\s*\{/g;
    let claimedUntil = 0;
    let m;
    while ((m = entryStartRx.exec(src)) !== null) {
      if (m.index < claimedUntil) continue;
      const bracePos = m.index + m[0].length - 1;
      const block = extractBalanced(src, bracePos);
      if (!block) continue;
      claimedUntil = bracePos + block.length;
      const cp = block.match(/canonicalPath:\s*["']([^"']+)["']/)?.[1];
      if (!cp) continue;
      const title = matchStr(block, 'title');
      out.set(seoKey(cp), {
        title: matchStr(block, 'ogTitle') || title,
        desc: matchStr(block, 'description'),
      });
    }
  }
  return out;
}

/**
 * `'blog.article.<id>.<field>': '<value>'` pairs out of a meta chunk. Regex and
 * not an import for the same reason build-blog-index.mjs uses one: these files
 * are ours, and parsing them must not drag the corpus's TS module graph in.
 */
function readMeta(metaPrefix, locale) {
  const abs = path.join(ROOT, 'content', `${metaPrefix}-${locale}.ts`);
  const out = new Map();
  if (!fs.existsSync(abs)) return out;
  const src = fs.readFileSync(abs, 'utf-8');
  const rx = /'blog\.article\.([^']+?)\.(title|excerpt)':\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const [, id, field, raw] = m;
    const value = raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const entry = out.get(id) ?? { title: '', desc: '' };
    if (field === 'title') entry.title = value;
    else entry.desc = value;
    out.set(id, entry);
  }
  return out;
}

async function currentLandingHtml(owner, repo, relPath) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${relPath}`;
  const headers = { 'User-Agent': 'refresh-hub-landing' };
  // Public repos, so the token is only about rate limits — absent is fine.
  if (process.env.GITHUB_PAT) headers.Authorization = `Bearer ${process.env.GITHUB_PAT}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${relPath} → HTTP ${res.status}`);
  const html = await res.text();

  // A truncated download is the failure worth engineering against: the grid
  // sits mid-document, so a body cut anywhere after it still balances, still
  // patches, and still publishes — with the nav, the FAQ and </html> gone. The
  // result answers 200 and looks fine to every check downstream. `</html>` is
  // the cheap proof the document arrived whole; the size floor catches an
  // error page that happens to be well-formed.
  if (!/<\/html>\s*$/i.test(html.trimEnd())) {
    throw new Error(`${relPath} did not end at </html> (${html.length} B) — truncated?`);
  }
  if (html.length < MIN_LANDING_BYTES) {
    throw new Error(`${relPath} is ${html.length} B, under the ${MIN_LANDING_BYTES} B floor`);
  }
  return html;
}

/** Must match the marker `replaceArticleHubCards` scans for. */
const GRID_OPEN = '<div class="ssg-article-grid">';

const seoMap = readSeoMap();
console.log(`[hub-landing] SEO map: ${seoMap.size} entries`);

let refreshed = 0;
let skipped = 0;
let absent = 0;
/** What the workflow pushes and purges: one entry per page actually rewritten. */
const pages = [];

for (const section of SECTIONS) {
  const mod = await import(path.join(ROOT, section.registry));
  const articles = mod[section.registryExport];
  if (!Array.isArray(articles) || articles.length === 0) {
    throw new Error(`${section.registry}: ${section.registryExport} is empty — refusing to render an empty hub`);
  }
  const slugMod = await import(path.join(ROOT, section.slugFile));
  const slugMap = slugMod[section.slugExport] ?? {};

  // Newest first — the grid is "Ultimi Articoli", and the site sorts the same
  // way before slicing. Sorting here rather than trusting registry order is
  // the whole point: articles are APPENDED to the registry, so its own order
  // puts the newest last.
  const sorted = [...articles].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  for (const locale of LOCALES) {
    const slug = shardSlugs[section.shardKey]?.[locale];
    if (!slug) { console.error(`[hub-landing] no slug for ${section.shardKey}/${locale}`); skipped++; continue; }

    const owner = shardOwners[section.shardKey] ?? 'valerielinc-ops';
    const repo = `frontaliere-${section.shardKey}-${locale}`;
    const relPath = locale === 'it' ? `${slug}/index.html` : `${locale}/${slug}/index.html`;

    let html;
    try {
      html = await currentLandingHtml(owner, repo, relPath);
    } catch (err) {
      console.error(`[hub-landing] ${section.name}/${locale}: ${err.message} — left alone`);
      skipped++;
      continue;
    }

    const meta = readMeta(section.metaPrefix, locale);
    // Fail-closed on meta coverage. A card with neither source resolves to a
    // de-slugified id — "Fondo Liberta Svizzera Multe" — in the href label,
    // the aria-label, the img alt and the h3. The site's own build has the SEO
    // map for those ids and renders them properly, so publishing a degraded
    // grid would replace good titles with bad ones on every article, and the
    // next full deploy would put them back: a flip-flop nobody asked for.
    // Measured before this gate: 10 IT and 16 FR of the newest 100 had no
    // corpus meta. Better to leave the page as it is and say so.
    let missing = 0;
    const resolveMeta = (id, artPath) => {
      const fromSeo = seoMap.get(seoKey(artPath));
      if (fromSeo?.title) return fromSeo;
      const fromChunk = meta.get(id);
      if (fromChunk?.title) return fromChunk;
      missing++;
      return null;
    };

    let cards = renderArticleHubCards({
      articles: sorted,
      locale,
      sectionSlug: slug,
      localePrefix: locale === 'it' ? '' : locale,
      resolveSlug: (id) => slugMap[id]?.[locale],
      resolveMeta,
    });
    if (missing > 0) {
      console.error(`[hub-landing] ${section.name}/${locale}: ${missing} of the top 100 have no title in either source — refusing to publish a degraded grid`);
      skipped++;
      continue;
    }
    // Same rewrite the article path applies: the registry stores same-origin
    // image paths, and the shard origin does not serve /images/blog.
    cards = rewriteBlogImageRefs(cards);
    if (hasBlogImageLeak(cards)) {
      console.error(`[hub-landing] ${section.name}/${locale}: same-origin image ref survived the CDN rewrite — left alone`);
      skipped++;
      continue;
    }

    // Two very different reasons the swap can decline, and collapsing them
    // would hide a real break behind an expected one: the svizzera landing has
    // no grid at all (its staticPagesPlugin branch emits copy + a CTA to
    // /tutti/ and nothing else), whereas a grid that is present but unbalanced
    // means the page is malformed and someone should look.
    if (!html.includes(GRID_OPEN)) {
      console.log(`[hub-landing] ${section.name}/${locale}: no article grid on this page — nothing to refresh`);
      absent++;
      continue;
    }
    const patched = replaceArticleHubCards(html, cards);
    if (patched === null) {
      console.error(`[hub-landing] ${section.name}/${locale}: grid present but unbalanced — left alone`);
      skipped++;
      continue;
    }

    const abs = path.join(OUT, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, patched, 'utf-8');

    const newest = sorted[0]?.date ?? '?';
    const cardCount = (cards.match(/class="ssg-art-card"/g) ?? []).length;
    console.log(`[hub-landing] ${relPath} — ${cardCount} cards, newest ${newest}, ${Math.round(patched.length / 1024)} KB`);
    pages.push({
      section: section.name,
      shard: section.shardKey,
      locale,
      path: relPath,
      url: `https://frontaliereticino.ch/${locale === 'it' ? '' : `${locale}/`}${slug}/`,
      cards: cardCount,
    });
    refreshed++;
  }
}

if (SUMMARY) {
  fs.mkdirSync(path.dirname(path.resolve(SUMMARY)), { recursive: true });
  fs.writeFileSync(path.resolve(SUMMARY), JSON.stringify({ schema: 1, pages }, null, 2) + '\n');
}

console.log(`[hub-landing] refreshed ${refreshed}, no-grid ${absent}, skipped ${skipped}`);

// Per-section, not global: a section that is legitimately grid-less (svizzera,
// until the site build ships its new branch) must not mask a section that
// should have refreshed and did not.
let broken = false;
for (const section of SECTIONS) {
  if (!EXPECT_GRID.has(section.name)) continue;
  const got = pages.filter((p) => p.section === section.name).length;
  if (got === 0) {
    console.error(`[hub-landing] ${section.name} refreshed 0 pages but is expected to have a grid — this is the silent-staleness failure, not a no-op`);
    broken = true;
  }
}
if (broken) process.exit(1);
