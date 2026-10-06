#!/usr/bin/env -S npx -y tsx
// publish-article-fast.mjs (#4837 stream A — near-instant article publish)
//
// Renders one or more blog articles' static HTML for all 4 locales WITHOUT running the
// full `vite build` (~25-34 min, OOM-prone). Reuses the EXACT same functions
// the full build's closeBundle hooks call, in the same order, so the output is
// byte-identical to what a full build would emit for these articles (see
// scripts/check-article-byte-identity.mjs). Do NOT reimplement any transform
// here — import + call the shared function; a fork would silently drift the
// fast path and the full build apart.
//
// CLI:
//   npx -y tsx scripts/publish-article-fast.mjs (--id <articleId> | --ids <jsonArray>) --section <active section with a Pages shard: frontaliere|svizzera today> --out <scratchDistDir> --summary <summaryJsonPath>
//
// Pipeline (mirrors postWalkCoordinatorPlugin.ts's real per-file order —
// see build-plugins/postWalkWorker.mjs for the production analogue):
//   1. renderArticlePages({onlyArticleIds}) — 4 locale index.html (+ a
//      placeholder flat .html sibling, immediately replaced by step 2).
//   2. flat-redirect transform — buildFlatBridgeFromSibling() derives the
//      redirect-bridge sibling from the JUST-rendered index.html. Built from
//      the pre-postprocess content, exactly like ogPagesPlugin's own
//      full-build write loop and the doc-comment-endorsed direct-call use of
//      buildFlatBridgeFromSibling. This is provably byte-identical to
//      building it post-steps-3/4: the bridge only extracts <title> + OG/
//      description meta tags, neither of which steps 3 or 4 ever touch.
//   3. contextual links (index.html only) — injectContextualLinks(). Pure
//      function of (html, locale); no cross-article state, so a single
//      article renders identically whether run standalone or in the full
//      walk. Never applied to the flat bridge (matches
//      blogContextualLinksPlugin's own "persist only to the directory form"
//      contract).
//   4. hreflang postprocess — transformHreflang() strips any alternate whose
//      target file does not exist in distDir. All 4 locale index.html for
//      THIS article are already on disk by this point, so self-referencing
//      hreflang (the only kind an article page emits) always resolves.
//   5. hero-image CDN rewrite — rewriteBlogImageRefs() rewrites same-origin
//      `/images/blog/<file>` refs to the CDN URL. Applied to every written
//      file (index + bridge), matching blogImageCdnFinalizePlugin's
//      unconditional whole-dist walk in the full build.
//   6. renderArticleHubPages({section}) (issue #4881 Fase 1) — re-renders the
//      section's `/tutti/` archive + pagination for all 4 locales so the
//      just-published article is immediately LISTED, not merely reachable by
//      direct URL. Calls the SAME renderArticleHubPagesCore the full build's
//      emitSeoHubs uses (engine/articleHubPagesPlugin.ts) — byte-identical by
//      construction. Not run through steps 2-5: those are article-body
//      specific (flat bridge, this article's own related-picks, hero image)
//      and don't apply to an archive listing page.
//   7. scripts/offload-generated-images-cdn.mjs, unmodified, as a subprocess
//      (CDN_BASE=https://cdn.frontaliereticino.ch — the same value deploy.yml
//      exports for the en/de/fr shard runners, which process an analogously
//      pruned single-locale dist). Converts the hardcoded `/assets/...`
//      strings ogPagesPlugin's html() closure emits to CDN URLs (Rollup's
//      renderBuiltUrl never sees these — they are plain text, not asset
//      references) and injects window.__CDN_DATA_BASE__ for client-side
//      data/image fetches. The script's own TARGETS-existence gating makes it
//      safe to run against a near-empty scratch dist (confirmed: only the
//      guarded *delete* step is gated on a target dir physically existing —
//      the rewrite regexes run unconditionally, exactly the shard-dist case
//      the script's own comments already document).
//
//      RUNS LAST, AFTER the archive render (issue #5270). It used to run
//      before it, so archive pages were written past the only pass that
//      rewrites `/assets/...` to the CDN — and since nothing hosts `/assets`
//      at the apex any more, every archive page shipped 5 same-origin asset
//      refs that are guaranteed 404s (no CSS, no SPA bundle, no AdSense
//      loader).
//
//      This repo is a SEPARATE COPY of the site's scripts/publish-article-fast.mjs
//      — no mirror carries scripts/ (mirror-articles-engine.yml carries
//      engine/ + index.ts + articleSections.ts, and the retired corpus mirror
//      carried content/ + engine/). valerielinc-ops/frontaliere-si-o-no#5271
//      fixed this same ordering on the site's copy on 2026-08-06; this copy
//      kept shipping the broken order, and since BOTH repos push the article
//      shards the live archive alternated healthy/broken by publisher.
//      Measured on the shard repo (frontaliere-articolifrontaliere-it,
//      articoli-frontaliere/tutti/index.html):
//
//        07:07:18Z  corpus push  10 same-origin /assets refs,  0 CDN
//        05:53:17Z  corpus push  10 same-origin /assets refs,  0 CDN
//        05:13:17Z  site   push   1 same-origin /assets ref,   9 CDN
//        03:55:58Z  corpus push  10 same-origin /assets refs,  0 CDN
//        03:42:32Z  site   push   1 same-origin /assets ref,   9 CDN
//
//      If either copy is touched, touch both.
//
//      De-dup status: blocked, not actionable from this repo. Both remedies
//      (teach mirror-articles-engine.yml to also carry scripts/, or move this
//      ordering under engine/ so the mirror already ships it) require editing
//      files that live in the SITE repo (valerielinc-ops/frontaliere-si-o-no),
//      which owns both that workflow and engine/ (this repo only ever
//      receives a mirrored copy of engine/, per AGENTS.md #3). Recommended
//      path: move the render-then-offload order under engine/ on the site
//      side so the mirror carries it here automatically.
//
// Writes a summary JSON describing what was rendered, for stream B
// (incremental shard push) and stream C (fast-publish workflow) to consume:
//   { id, section, shards: [{locale, subtree, paths, url}, ...], cdnUploads: [{local, key}, ...] }
//   `paths` per shard = [article index.html, article flat bridge, ...that
//   locale's hub-archive pages from step 6].
//
// Known gap fixed here, not in the shared renderer: ogPagesPlugin's
// resolveImagePath() verifies a candidate hero image exists by checking
// fs.existsSync(distDir/<publicPath>) — true in a full build (Vite copies
// public/ into dist/ before closeBundle runs) but never true in a bare
// scratch --out dir. Without the images/ symlink below, EVERY article would
// silently resolve to DEFAULT_IMG here. See step 0.
//
// DANGER (learned the hard way while building this script — see git history
// for the incident): the images/ symlink is torn down again immediately
// after step 1, BEFORE step 7 runs. offload-generated-images-cdn.mjs deletes
// files under its TARGETS dirs (thumbnails/brands/insurers/…), and a symlink
// as an INTERMEDIATE path component is transparent to that delete — it
// deleted through distDir/images straight into the real public/images/*,
// wiping ~850MB of tracked files in this worktree (recovered via
// `git checkout -- public/images`, zero permanent loss, but never again:
// the symlink must not be alive while any subprocess may write/delete
// through distDir). Nothing after step 1 needs distDir/images to exist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Output-boundary sanitisation (see scripts/lib/sanitize-control-chars.mjs).
// The renderer is engine/ogPagesPlugin.ts, which arrives by mirror and is not
// editable from this repo, so the guard sits where THIS script writes the
// bytes. Measured on the live apex page for `trump-intesa-o-inferno`: 0x17 and
// 0x08 raw in <title>, og:title, og:image:alt, <h1> and the hero alt, and the
// same two escaped inside the NewsArticle `headline`/`caption` and the
// BreadcrumbList `name` — structured data served to crawlers, not to a browser
// that would swallow them.
import { heroCdnUploads, renderSectionArticlePipeline } from './lib/article-render-pipeline.mjs';
// Sezioni valide e shard Pages vengono dal core (lista ATTIVA), come in
// fast-publish-article.yml: niente coppia frontaliere/svizzera scritta a mano.
import { shardOf } from './ci/fast-publish-section.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') out.ids.push(argv[++i]);
    else if (a === '--ids') {
      try {
        const ids = JSON.parse(argv[++i]);
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) {
          throw new Error('expected a non-empty-string array');
        }
        out.ids.push(...ids);
      } catch (err) {
        console.error(`[publish-article-fast] --ids must be a JSON array of article ids: ${err.message}`);
        process.exit(1);
      }
    } else if (a === '--section') out.section = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--summary') out.summary = argv[++i];
  }
  out.ids = [...new Set(out.ids)];
  if (out.ids.some((id) => typeof id !== 'string' || !id)) {
    console.error('[publish-article-fast] article ids must be non-empty strings');
    process.exit(1);
  }
  const missing = [
    ...(out.ids.length ? [] : ['id or ids']),
    ...['section', 'out', 'summary'].filter((k) => !out[k]),
  ];
  if (missing.length > 0) {
    console.error(`[publish-article-fast] missing required flag(s): ${missing.map((k) => `--${k}`).join(', ')}`);
    console.error('Usage: npx -y tsx scripts/publish-article-fast.mjs (--id <articleId> | --ids <jsonArray>) --section <active section with a Pages shard> --out <scratchDistDir> --summary <summaryJsonPath>');
    process.exit(1);
  }
  // Prima di qualunque render: la sezione deve essere ATTIVA nel core e avere
  // uno shard Pages. Una sezione servita da R2 (`shardKey: null`, le
  // cantonali) e' un errore esplicito, mai un ripiego sullo shard di un'altra.
  try {
    out.shardKey = shardOf(out.section);
  } catch (err) {
    console.error(`[publish-article-fast] --section "${out.section}": ${err.message}`);
    process.exit(1);
  }
  out.id = out.ids[0];
  return out;
}

async function main() {
  const t0 = Date.now();

  const args = parseArgs(process.argv.slice(2));
  const distDir = path.resolve(args.out);
  fs.mkdirSync(distDir, { recursive: true });

  // La catena di render (passi 0-7b, nell'ordine che conta) vive in
  // scripts/lib/article-render-pipeline.mjs, condivisa col publisher R2 delle
  // sezioni cantonali: vedi il suo header e i commenti passo per passo.
  let pipeline;
  try {
    pipeline = await renderSectionArticlePipeline({
      rootDir: ROOT_DIR,
      distDir,
      section: args.section,
      ids: args.ids,
      logPrefix: 'publish-article-fast',
    });
  } catch (err) {
    console.error(`[publish-article-fast] ${err.message}`);
    process.exit(1);
  }
  const { written, entries, hubResult, locales } = pipeline;

  // ── Summary JSON for stream B (shard push) / stream C (workflow) ──
  const sectionShardKey = args.shardKey;
  const shardSlugs = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'lib', 'section-shard-slugs.json'), 'utf-8'),
  );
  const slugMap = shardSlugs[sectionShardKey];

  // subtree convention matches scripts/lib/section-shard-slugs.json's own
  // documented formula: it -> <slug>, en/de/fr -> <loc>/<slug>.
  // All article pages, redirect bridges, and hub-archive paths for this locale
  // are sent together — push-article-shard-incremental.sh takes an arbitrary
  // list of relpaths per locale/section invocation, so no separate push call or
  // workflow change is needed (.github/workflows/fast-publish-article.yml
  // already forwards every entry in `paths[]`).
  const shards = locales.map((locale) => {
    const articleIds = entries.filter((entry) => entry.paths[locale]).map((entry) => entry.articleId);
    const bridgeIds = entries.filter((entry) => entry.flatPaths[locale]).map((entry) => entry.articleId);
    const articlePaths = entries.map((entry) => entry.paths[locale]).filter(Boolean);
    const bridgePaths = entries.map((entry) => entry.flatPaths[locale]).filter(Boolean);
    const hubPaths = hubResult.pathsByLocale[locale] ?? [];
    const urls = entries.map((entry) => entry.urls[locale]).filter(Boolean);
    return {
      locale,
      subtree: locale === 'it' ? slugMap.it : `${locale}/${slugMap[locale]}`,
      articleIds,
      bridgeIds,
      articlePaths,
      bridgePaths,
      hubPaths,
      paths: [...articlePaths, ...bridgePaths, ...hubPaths],
      url: urls[0],
      urls,
    };
  });

  // Hero e thumbnail di ogni articolo reso, dalla directory REALE in cui
  // l'engine li ha risolti (images/blog o images/places): vedi heroCdnUploads.
  const cdnUploads = heroCdnUploads({ rootDir: ROOT_DIR, entries, logPrefix: 'publish-article-fast' });

  const summary = { id: args.ids.length === 1 ? args.id : null, ids: args.ids, section: args.section, shards, cdnUploads };
  const summaryPath = path.resolve(args.summary);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');

  const wallMs = Date.now() - t0;
  console.log(
    `[publish-article-fast] done — ids=${args.ids.join(',')} section=${args.section} wrote=${written} article files + ${hubResult.written} hub pages, wall=${(wallMs / 1000).toFixed(1)}s`,
  );
  console.log(`[publish-article-fast] summary written to ${summaryPath}`);
}

main().catch((err) => {
  console.error('[publish-article-fast] fatal error:', err);
  process.exit(1);
});
