#!/usr/bin/env node
/**
 * Local, non-AI image catalog for the redazione cover-image picker
 * (components/pages/JournalistDashboardPage.tsx / services/journalistImageCatalog.ts).
 *
 * No network calls, no external service: the catalog is every real photo
 * already used by a published article (public/images/blog/*.webp — the
 * filename IS the article slug, e.g. "a2-melide-chiusure-notturne-lavori.webp"),
 * searched client-side by simple keyword overlap against the draft's own
 * title + body. Mirrors the same "filename keyword overlap" strategy already
 * used server-side by scripts/create-article.mjs's findBestFallbackImage(),
 * just exposed as a ranked multi-candidate list instead of a single silent pick.
 *
 * Run directly to do a full rescan (`node scripts/generate-journalist-image-catalog.mjs`).
 * appendCatalogEntry() is called incrementally by the two places that ever
 * write a new file into public/images/blog: create-article.mjs's automated
 * pipeline and publish-journalist-article.mjs's resolveHeroImage() upload path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `../..`: the transport moved this from `scripts/` to `generator/scripts/`,
// so one level up is now the generator directory, not the repo root.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOG_DIR = path.join(PROJECT_ROOT, 'public', 'images', 'blog');
const OUT_PATH = path.join(PROJECT_ROOT, 'public', 'data', 'journalist-image-catalog.json');

/** Meaningful (4+ char) lowercase word tokens from a blog image filename. */
export function wordsFromFilename(file) {
  return file
    .replace(/\.(webp|jpg|jpeg|png)$/i, '')
    .toLowerCase()
    .split(/[^a-zà-ÿ0-9]+/)
    .filter((w) => w.length >= 4);
}

/** Full rescan of public/images/blog — used for the initial/manual seed. */
export function buildCatalog() {
  const files = fs.existsSync(BLOG_DIR)
    ? fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith('.webp'))
    : [];
  return files
    .map((f) => ({ path: `/images/blog/${f}`, words: wordsFromFilename(f) }))
    .filter((entry) => entry.words.length > 0);
}

function readExistingCatalog() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch {
    return [];
  }
}

// Atomico, e qui il troncamento e' PIU' insidioso che altrove: `appendCatalogEntry`
// riscrive il catalogo in place da `publish-journalist-article.mjs`, sotto
// `generate-article.yml` (timeout-minutes → SIGKILL), e la lettura poco sopra
// ha un `catch { return []; }`. Un file troncato non lancia: torna un catalogo
// VUOTO, e il run successivo lo riscrive perdendo tutte le voci senza un solo
// errore. Temp accanto al target + renameSync: o resta il catalogo vecchio
// intero, o c'e' quello nuovo intero.
let writeTmpSeq = 0;
function writeCatalog(catalog) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const tmp = `${OUT_PATH}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(catalog));
    fs.renameSync(tmp, OUT_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Appends a single newly-written blog image to the committed catalog
 * manifest without a full directory rescan. No-op (never throws) if the
 * entry is already present — safe to call unconditionally after any write
 * to public/images/blog/*.webp.
 */
export function appendCatalogEntry(blogImagePath) {
  try {
    const file = blogImagePath.replace(/^\/images\/blog\//, '');
    const words = wordsFromFilename(file);
    if (words.length === 0) return;
    const catalog = readExistingCatalog();
    if (catalog.some((entry) => entry.path === blogImagePath)) return;
    catalog.push({ path: blogImagePath, words });
    writeCatalog(catalog);
  } catch (err) {
    console.warn(`  ⚠️  appendCatalogEntry(${blogImagePath}) failed (non-fatal): ${err.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // DRY_RUN=1 is the convention the other generator entry points already use
  // ("plan only, no writes" — see generate-events-digest-article.mjs and
  // generate-border-wait-ranking-article.mjs). This script had no dry-run
  // branch, so a CI smoke run that merely wanted to prove it LOADS ended up
  // creating public/data/ and writing the catalog. Added so the whole set can
  // be exercised uniformly with writes off.
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const catalog = buildCatalog();

  // Shrink guard, same spirit as refresh-border-wait-averages.mjs: this full
  // rescan is wired into a weekly cron (rescan-journalist-image-catalog.yml)
  // that commits and pushes to main with no human review. A bad checkout —
  // wrong path, a delete racing the scan, a future directory move — leaves
  // public/images/blog/ empty or partial, and buildCatalog() would otherwise
  // silently overwrite a good catalog with a truncated one. The image set is
  // append-only in normal operation, so a sharp drop means a bad rescan, not
  // that half the cover images vanished.
  const existing = readExistingCatalog();
  if (existing.length > 0 && catalog.length < existing.length / 2) {
    console.error(
      `::error::rescan would shrink journalist-image-catalog.json from ${existing.length} to ${catalog.length} entries — refusing to write`,
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log(
      `DRY_RUN — would write ${catalog.length} entries to ${path.relative(PROJECT_ROOT, OUT_PATH)}; no files written.`,
    );
  } else {
    writeCatalog(catalog);
    console.log(`✅ Wrote ${catalog.length} entries to ${path.relative(PROJECT_ROOT, OUT_PATH)}`);
  }
}
