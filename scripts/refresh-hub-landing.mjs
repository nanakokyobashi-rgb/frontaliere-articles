#!/usr/bin/env node
/**
 * Put the `ssg-article-grid` on the article-hub LANDING pages — refreshing it
 * where it exists, CREATING it where it does not.
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
 * grid depends on the corpus, so only the grid is written — through the same
 * renderer the site uses (`engine/articlesHubCards.ts`), so the two emitters
 * cannot drift into different markup.
 *
 * ─── Refresh was not enough ──────────────────────────────────────────────
 * Until now this script could only SWAP a grid that was already on the page,
 * and `/articoli-svizzera/` (x4 locales) never had one: its live bytes come
 * from staticPagesPlugin's generic fallback branch, emitted before the hub
 * branch existed, so there was no marker to swap. It logged "nothing to
 * refresh" and exited 0, every run, for a week — while 617 articles sat behind
 * 9 KB of copy with no way in.
 *
 * And the site could not fix it either: `deploy-shard-sections.sh` there
 * excludes both article sections from the shard push loop unconditionally, so
 * whatever that build emits for these prefixes never reaches the shard the
 * Worker serves. Two writers, neither of them writing, nothing red anywhere.
 * `ensureArticleHubCards` creates the grid at the site template's own anchor
 * when it is absent, which makes that state unreachable: the side that IS on
 * the serving path can now produce the marker it needs.
 *
 * ─── Fail-closed ─────────────────────────────────────────────────────────
 * A page whose current HTML cannot be fetched, whose grid marker is present
 * but unbalanced, or which has no shell nav to anchor a new grid against, is
 * SKIPPED — never written half-formed. A truncated hub still answers 200, so
 * "write something" is the wrong default. The run exits non-zero when a
 * section it was told to write produced nothing, which is the case that means
 * the mechanism itself is broken rather than one shard being slow.
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
// The third article surface this repo writes, and the third that interpolates
// an article TITLE into markup — so the same output-boundary guard applies.
// See scripts/lib/sanitize-control-chars.mjs for the incident.
import { sanitizeHtmlDocument } from './lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from '../generator/scripts/lib/control-char-write-report.mjs';

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
 * Sanity floor for a fetched landing. The smallest real one was the svizzera
 * hub at ~9 KB, back when it carried copy and a CTA and no grid; anything
 * under 4 KB is an error page or a truncated body, not a page worth patching.
 * Deliberately left well below the ~90 KB a landing weighs once its grid is
 * there — this floor exists to reject an error page, not to ratchet size.
 */
const MIN_LANDING_BYTES = 4096;

/**
 * Sections whose landing this run MUST end up writing. If one of these
 * refreshes nothing, the mechanism is broken and the run must say so —
 * reporting "nothing to refresh" and exiting 0 is precisely the
 * silent-staleness shape that let the hub sit a week behind in the first
 * place.
 *
 * BOTH sections now, not just frontaliere. Svizzera was excused here because
 * its landing genuinely had no grid to swap — and that exemption is exactly
 * what kept the failure quiet: 617 articles behind 9 KB of copy, four locales,
 * a full run of green logs every time. `ensureArticleHubCards` removes the
 * reason for the exemption (it CREATES the grid when the page has none), so
 * the exemption goes with it. There is no longer any section this script may
 * legitimately leave untouched.
 */
const EXPECT_GRID = new Set(
  argOf('--expect-grid', 'frontaliere,svizzera').split(',').map((s) => s.trim()).filter(Boolean),
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

// GRID_OPEN comes from the engine rather than being restated here: it is the
// literal both emitters agree on, and a second copy is how they stop agreeing.
const { renderArticleHubCards, ensureArticleHubCards, ARTICLE_HUB_GRID_OPEN: GRID_OPEN } =
  await import('../engine/articlesHubCards.ts');
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

    // A landing with no marker used to end the story here: log "nothing to
    // refresh", count it as absent, exit 0. That was the whole failure. The
    // site is NOT on the serving path for these prefixes — its
    // `deploy-shard-sections.sh` excludes both article sections from the shard
    // push loop — so a page this script declines to write is a page nobody
    // writes. `ensureArticleHubCards` CREATES the grid at the site template's
    // own anchor instead, and every later run finds the marker and takes the
    // ordinary swap path.
    //
    // Fail-closed is unchanged, and still distinguishes the two real refusals:
    // a marker present but unbalanced means the page is malformed and someone
    // should look; a page with no shell nav has no defensible place to put a
    // grid.
    const created = !html.includes(GRID_OPEN);
    const patched = ensureArticleHubCards(html, cards, locale);
    if (patched === null) {
      console.error(
        `[hub-landing] ${section.name}/${locale}: ${created
          ? 'no grid marker and no shell nav to anchor one'
          : 'grid present but unbalanced'} — left alone`,
      );
      skipped++;
      continue;
    }
    if (created) {
      console.log(`[hub-landing] ${section.name}/${locale}: no grid on this page — CREATED one`);
      absent++;
    }

    const abs = path.join(OUT, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const cleanPage = sanitizeHtmlDocument(patched);
    reportStrippedControlChars(abs, patched, cleanPage);
    fs.writeFileSync(abs, cleanPage, 'utf-8');

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

console.log(`[hub-landing] refreshed ${refreshed} (${absent} of them newly created), skipped ${skipped}`);

// Per-section, not global: one section refreshing must not mask another that
// should have and did not. No section is exempt any more — see EXPECT_GRID.
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
