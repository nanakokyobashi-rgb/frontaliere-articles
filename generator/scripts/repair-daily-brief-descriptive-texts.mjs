#!/usr/bin/env node
/**
 * One-off repair for daily Bollettino editions published BEFORE #83 split
 * excerpt/seoDescription/ogDescription apart (issue #85).
 *
 * `bollettino-frontaliere-2026-08-08` and `-09` registered with a single
 * collapsed string doing triple duty (#79/#80): `content/blog-meta-<locale>.ts`
 * never got a `seoDescription`/`ogDescription` key at all, and the short
 * excerpt is what a reader still sees on both cards today. #83 fixed the
 * TEMPLATE for every edition from 2026-08-10 onward, but a template fix
 * cannot reach back into `content/` — that tree is written only by the
 * generator (CLAUDE.md) — and `generate-daily-brief-article.mjs`'s `exists`
 * branch only ever refreshed body files, never these descriptive surfaces
 * (that gap is fixed separately, in the same PR, via `refreshMetaAndSeo`).
 *
 * Re-running the generator on a PAST day does not work — today's
 * `public/data/daily-brief.json` snapshot is for today, and a day that has
 * passed has no snapshot left to load. This script does not need one: per
 * `buildDescriptiveTexts` in `lib/daily-brief-content.mjs`, none of the three
 * descriptive texts depend on the day's actual numbers (border waits, fuel
 * prices, …) — only on the calendar date itself, via the interpolated
 * `dateLabel`. `title` and the body sections DO need the real numbers and are
 * deliberately left untouched here.
 *
 * Idempotent (delegates to `refreshDescriptiveTexts`, which compares against
 * the stored value before writing): running this twice on the same id writes
 * nothing the second time.
 *
 * Usage:
 *   node generator/scripts/repair-daily-brief-descriptive-texts.mjs 2026-08-08 2026-08-09
 *   DRY_RUN=1 node generator/scripts/repair-daily-brief-descriptive-texts.mjs 2026-08-08
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { corpusPath } from './lib/corpus-paths.mjs';
import { DAILY_EDITION_ID_RE, dailyBriefArticleId, buildDescriptiveTexts } from './lib/daily-brief-content.mjs';
import { refreshDescriptiveTexts } from './lib/article-meta-refresh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCALES = ['it', 'en', 'de', 'fr'];

/** True when `id` already has a `title` line in the IT meta file — the same
 * registration check `checkArticleIdExists` would make, without pulling in
 * create-article.mjs (and its jsdom dependency) for a one-off repair script. */
function isRegistered(id) {
  const file = path.join(REPO_ROOT, corpusPath('services/locales/blog-meta-it.ts'));
  const src = readFileSync(file, 'utf-8');
  return src.includes(`'blog.article.${id}.title':`);
}

function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const dates = process.argv.slice(2);
  if (dates.length === 0) {
    console.error('Usage: repair-daily-brief-descriptive-texts.mjs <dateIso> [dateIso...]');
    process.exit(1);
  }

  let anyFailed = false;
  for (const dateIso of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
      console.error(`❌ '${dateIso}' non e' una data YYYY-MM-DD`);
      anyFailed = true;
      continue;
    }
    const id = dailyBriefArticleId(dateIso);
    if (!DAILY_EDITION_ID_RE.test(id)) {
      console.error(`❌ id derivato '${id}' non rispetta il formato edizione`);
      anyFailed = true;
      continue;
    }
    if (!isRegistered(id)) {
      console.error(`❌ '${id}' non risulta registrato in content/blog-meta-it.ts — niente da riparare`);
      anyFailed = true;
      continue;
    }

    const localeTexts = {};
    for (const locale of LOCALES) localeTexts[locale] = buildDescriptiveTexts(dateIso, locale);

    if (dryRun) {
      console.log(`DRY_RUN — ${id}:`);
      for (const locale of LOCALES) {
        console.log(`  ${locale}.excerpt         : ${localeTexts[locale].excerpt.length} chars`);
        console.log(`  ${locale}.seoDescription  : ${localeTexts[locale].seoDescription.length} chars`);
        console.log(`  ${locale}.ogDescription   : ${localeTexts[locale].ogDescription.length} chars`);
      }
      continue;
    }

    const seoTexts = { description: localeTexts.it.seoDescription, ogDescription: localeTexts.it.ogDescription };
    const { changed, touched } = refreshDescriptiveTexts(id, localeTexts, seoTexts, { repoRoot: REPO_ROOT });
    if (changed) {
      console.log(`✅ ${id} — riscritti:`);
      for (const file of touched) console.log(`   ${path.relative(REPO_ROOT, file)}`);
    } else {
      console.log(`♻️  ${id} — gia' allineato al template corrente, nessuna scrittura.`);
    }
  }

  if (anyFailed) process.exit(1);
}

main();
