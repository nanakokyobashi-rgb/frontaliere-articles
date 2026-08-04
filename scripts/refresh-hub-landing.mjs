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
  return res.text();
}

/** Must match the marker `replaceArticleHubCards` scans for. */
const GRID_OPEN = '<div class="ssg-article-grid">';

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
    let cards = renderArticleHubCards({
      articles: sorted,
      locale,
      sectionSlug: slug,
      localePrefix: locale === 'it' ? '' : locale,
      resolveSlug: (id) => slugMap[id]?.[locale],
      resolveMeta: (id) => meta.get(id) ?? null,
    });
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
if (refreshed === 0 && absent === 0) {
  console.error('[hub-landing] nothing was refreshed — the mechanism is broken, not just one shard');
  process.exit(1);
}
