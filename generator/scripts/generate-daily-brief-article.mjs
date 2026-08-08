#!/usr/bin/env node
/**
 * Register the DAILY "Bollettino del Frontaliere" edition — one dated article
 * per day (`bollettino-frontaliere-YYYY-MM-DD`), 4 locales, built from the
 * `public/data/daily-brief.json` snapshot that refresh-daily-brief-data.mjs
 * wrote just before (the cron runs the two back to back).
 *
 * DELIBERATELY DATED, unlike the two evergreen digests this imitates
 * (border-wait ranking, events): a bumped `updatedAt` on a stable id is not a
 * new story for Google Discover, and Discover is the whole point. Flooding is
 * bounded by the sitemap retention in scripts/build-api.mjs (latest 90 listed).
 *
 * Registration goes ONLY through create-article.mjs's registrar
 * (registerArticleFiles / checkArticleIdExists / buildBodyFile — AGENTS.md §6:
 * reuse, don't reimplement). Idempotent per day: if today's id exists the body
 * files are refreshed in place instead of duplicating.
 *
 * The hero is generated from the day's numbers (sharp, 1200×675 webp + 480w
 * thumbnail) — Discover requires a unique ≥1200px image per edition, which is
 * exactly what the evergreen catalog photos cannot provide. No image → no
 * edition (hard fail): publishing without it would defeat the goal.
 *
 * Refusals (all exit 0 — a day without data must not break the cron):
 *   - snapshot missing, or its dateIso ≠ today  → stale, refuse
 *   - fewer than 2 available blocks             → too thin to be an edition
 *
 * Usage:
 *   node generator/scripts/generate-daily-brief-article.mjs
 *   DRY_RUN=1 …    # plan only, no writes
 *   TODAY_ISO=2026-08-08 …   # pin "today" (tests/CI)
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { registerArticleFiles, checkArticleIdExists, buildBodyFile } from './create-article.mjs';
import { bumpUpdatedAt, bumpDateModified } from './lib/evergreen-article-refresh.mjs';
import { corpusPath } from './lib/corpus-paths.mjs';
// loadSnapshot/buildData live in the lib (not here) so `node --test` can pin
// the refusal rules without importing create-article.mjs, whose static deps
// (jsdom) exist only where `npm ci` ran.
import { loadSnapshot, buildData } from './lib/daily-brief-content.mjs';
import { buildDailyBriefSvg, renderDailyBriefImage } from './lib/daily-brief-image.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCALES = ['it', 'en', 'de', 'fr'];
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'public', 'data', 'daily-brief.json');

/** Rewrite only the 4 body files (idempotent same-day refresh). */
export function refreshBodyFiles(data, repoRoot = REPO_ROOT, log = console.log) {
  for (const locale of LOCALES) {
    const dir = path.join(repoRoot, corpusPath('services/locales/blog-body'), locale);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${data.id}.ts`);
    writeFileSync(file, buildBodyFile(data, locale));
    log(`  ✅ ${path.relative(repoRoot, file)}`);
  }
}

export function heroPaths(id, repoRoot = REPO_ROOT) {
  return {
    hero: path.join(repoRoot, 'public', 'images', 'blog', `${id}.webp`),
    thumb: path.join(repoRoot, 'public', 'images', 'blog', 'thumbnails', `${id}-480w.webp`),
  };
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const todayIso = process.env.TODAY_ISO || new Date().toISOString().slice(0, 10);

  const { brief, reason } = loadSnapshot(todayIso, SNAPSHOT_PATH);
  if (!brief) {
    console.log(`🚫 no edition today: ${reason}`);
    return; // exit 0 — a day without data must not break the cron
  }

  const data = buildData(brief);
  const exists = checkArticleIdExists(data.id);
  const h = data._headline;
  console.log(
    `🗞️  daily brief edition — id=${data.id} blocks=${brief.counts.availableBlocks}/4 headline=${h.kind} author=${data.author.slug} exists=${exists} dry=${dryRun}`,
  );

  if (dryRun) {
    console.log('DRY_RUN — no files written.');
    console.log('  IT title :', data.content.it.title);
    console.log('  IT body1 :', data.content.it.body1.slice(0, 180).replace(/\n/g, ' '));
    const svg = buildDailyBriefSvg(brief, { locale: 'it' });
    console.log(`  hero SVG : ${svg.length} bytes (would render 1200×675 webp + 480w thumb)`);
    return;
  }

  // Image FIRST, and fatally: a registered edition without its unique hero
  // would ship exactly the recycled-image profile this project is escaping.
  const { hero, thumb } = heroPaths(data.id);
  const svg = buildDailyBriefSvg(brief, { locale: 'it' });
  const { heroBytes, thumbBytes } = await renderDailyBriefImage(svg, hero, thumb);
  console.log(`🖼️  hero ${path.relative(REPO_ROOT, hero)} (${heroBytes} B), thumb (${thumbBytes} B)`);

  if (!exists) {
    console.log('📂 registering today’s edition across the blog system…');
    await registerArticleFiles(data); // NOT skipNews: a dated edition IS news
    console.log('✅ registered.');
    return;
  }

  console.log('♻️  same-day rerun — refreshing body files in place…');
  refreshBodyFiles(data);
  if (!bumpUpdatedAt(data.id, todayIso)) console.warn('⚠️  updatedAt not bumped (entry not matched).');
  if (!bumpDateModified(data.id, `${todayIso}T00:00:00+02:00`)) {
    console.warn('⚠️  dateModified not bumped — freshness signal may be stale.');
  }
  console.log('✅ refreshed.');
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}
