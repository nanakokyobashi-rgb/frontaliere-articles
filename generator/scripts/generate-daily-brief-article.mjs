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
import { writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { registerArticleFiles, checkArticleIdExists, buildBodyFile } from './create-article.mjs';
import { bumpUpdatedAt, bumpDateModified } from './lib/evergreen-article-refresh.mjs';
import { corpusPath } from './lib/corpus-paths.mjs';
import { sanitizeText } from '../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './lib/control-char-write-report.mjs';
// loadSnapshot/buildData live in the lib (not here) so `node --test` can pin
// the refusal rules without importing create-article.mjs, whose static deps
// (jsdom) exist only where `npm ci` ran.
import { loadSnapshot, buildData } from './lib/daily-brief-content.mjs';
import { buildDailyBriefSvg, renderDailyBriefImage } from './lib/daily-brief-image.mjs';
import { refreshDescriptiveTexts } from './lib/article-meta-refresh.mjs';
import { sanitizePromptPlaceholders } from './lib/prompt-placeholder-guard.mjs';

// Scrittura ATOMICA del corpus: temp accanto al target + renameSync.
// Questi file riscrivono un `content/*.ts` GIA' ESISTENTE (rerun idempotente
// same-day) sotto `generate-daily-brief.yml`, che ha `timeout-minutes` e quindi uccide con
// SIGKILL: un `writeFileSync` diretto sul target puo' lasciarlo troncato a
// meta' scrittura. `renameSync` e' un singolo syscall POSIX, atomico sullo
// stesso filesystem — e il temp sta accanto al target proprio perche' il
// rename non attraversi mai un confine di filesystem. Stesso pattern di
// `writeCorpusFile()` in lib/evergreen-article-refresh.mjs e lib/
// article-meta-refresh.mjs, che questa PR ha gia' convertito: qui era
// rimasto scoperto il call-site che li CHIAMA.
let writeTmpSeq = 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCALES = ['it', 'en', 'de', 'fr'];
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'public', 'data', 'daily-brief.json');

/** Rewrite only the 4 body files (idempotent same-day refresh). */
export function refreshBodyFiles(data, repoRoot = REPO_ROOT, log = console.log) {
  // Il guard sui segnaposto sta QUI e non solo nel workflow (follow-up #315 a
  // #309). L'intestazione di `prompt-placeholder-guard.mjs` dice che gira
  // «dentro registerArticleFiles(), cioe' sul percorso di scrittura CONDIVISO»
  // — ma i percorsi di scrittura sono DUE: la prima registrazione passa dal
  // registrar, il rerun idempotente no, scrive con `writeFileSync` qui sotto.
  // Finche' la copertura era il solo step di workflow, una chiamata diretta a
  // questa funzione (o un `main()` che entra nel ramo `exists`) scriveva senza
  // controllo, e l'offender si vedeva solo dopo, a corpus gia' scritto.
  // Fail-closed come nel registrar: `sanitizePromptPlaceholders` ripara cio'
  // che e' riparabile e LANCIA sul primo campo che non lo e'.
  sanitizePromptPlaceholders(data);
  for (const locale of LOCALES) {
    const dir = path.join(repoRoot, corpusPath('services/locales/blog-body'), locale);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${data.id}.ts`);
    const body = buildBodyFile(data, locale);
    const clean = sanitizeText(body);
    // Non basta togliere il byte: toglierlo distrugge il MARKER che rende
    // esatta una riparazione futura (issue #95). Si registra prima, con il
    // contesto che conserva la coppia (byte, carattere seguente).
    reportStrippedControlChars(file, body, clean);
    const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
    try {
      writeFileSync(tmp, clean);
      renameSync(tmp, file);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw err;
    }
    log(`  ✅ ${path.relative(repoRoot, file)}`);
  }
}

/**
 * Rewrite excerpt/seoDescription/ogDescription (meta) and description/
 * ogDescription (SEO entry) in place, for a same-day rerun whose builder
 * output may disagree with what got registered earlier the same day — e.g.
 * a template change (#83) deployed between two cron runs.
 *
 * `refreshDescriptiveTexts` is itself idempotent (compares against the
 * stored value before writing anything), so calling this on every rerun —
 * several times a day, per the cron — is safe: a run where nothing changed
 * writes zero bytes and returns `changed: false` (issue #85 review note: this
 * is what keeps `bumpDateModified` from being asked to flicker over a rerun
 * that touched nothing).
 */
export function refreshMetaAndSeo(data, repoRoot = REPO_ROOT) {
  // Stessa ragione di `refreshBodyFiles` (follow-up #315): questa e' l'altra
  // meta' del rerun, e riscrive proprio i campi descrittivi — excerpt,
  // seoDescription, ogDescription, seo.description — che il guard tratta come
  // NON riparabili (lancia invece di ricostruire, per non propagare il leak).
  // Idempotente: su `data` gia' sanificato da `refreshBodyFiles` ritorna [].
  sanitizePromptPlaceholders(data);
  const localeTexts = {};
  for (const locale of LOCALES) {
    const c = data.content?.[locale];
    if (!c) continue;
    localeTexts[locale] = {
      excerpt: c.excerpt,
      seoDescription: c.seoDescription,
      ogDescription: c.ogDescription,
    };
  }
  return refreshDescriptiveTexts(
    data.id,
    localeTexts,
    { description: data.seo?.description, ogDescription: data.seo?.ogDescription },
    { repoRoot },
  );
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

  // Niente `inspectSlugForPromptPlaceholder` su `data.slugs`, e non e' una
  // dimenticanza (issue #382 item 4): `buildData` li prende da
  // `dailyBriefSlugs(dateIso)`, quattro template di sole stringhe letterali con
  // dentro la sola data ISO del giorno. Lo slug guard esiste perche' in
  // `create-article.mjs` lo slug lo propone il MODELLO, e un segnaposto del
  // prompt puo' finirci dentro; qui non c'e' nessun modello nella catena —
  // `wiring — i tre produttori senza slug guard` in
  // `generator/tests/prompt-placeholder-guard.test.mjs` lo verifica, e diventa
  // rosso il giorno in cui uno arriva.
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
  // Meta (excerpt/seoDescription/ogDescription) + SEO (description/
  // ogDescription) — issue #85: registerArticleFiles writes these ONCE, at
  // registration, so without this an `exists` rerun could refresh the body
  // text but never the descriptive surfaces it was published with.
  const { changed: metaChanged, touched: metaTouched } = refreshMetaAndSeo(data);
  if (metaChanged) {
    for (const file of metaTouched) console.log(`  ✅ ${path.relative(REPO_ROOT, file)}`);
  } else {
    console.log('  ♻️  meta/seo already current — nothing to rewrite.');
  }
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
