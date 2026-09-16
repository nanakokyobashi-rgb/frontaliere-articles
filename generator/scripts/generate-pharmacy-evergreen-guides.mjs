#!/usr/bin/env node
/**
 * Register or refresh the five evergreen pharmacy guides.
 *
 * The IDs are stable: a first run goes through registerArticleFiles(), while
 * later runs atomically refresh the five body files, descriptive meta/SEO and
 * freshness markers.  The content is sourced only from the validated compact
 * snapshots in generator/data; no weekly dated article is created here.
 *
 * Usage:
 *   node generator/scripts/generate-pharmacy-evergreen-guides.mjs --section=svizzera
 *   DRY_RUN=1 node generator/scripts/generate-pharmacy-evergreen-guides.mjs --section=svizzera
 *
 * `--section=svizzera` is mandatory.  The Swiss section has loose article IDs,
 * so this producer does not touch the frontaliere article-id union/P0 type
 * surface while still publishing the localized guides through the shared
 * registrar.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import {
  buildPharmacyEvergreenGuides,
  loadPharmacySnapshots,
  PHARMACY_LOCALES,
} from './lib/pharmacy-evergreen-guides-content.mjs';
import {
  registerArticleFiles,
  checkArticleIdExists,
  assertArticlePassesFactualityGates,
  assertGeneratedArticleQuality,
  resolveRegisterLockAtStartup,
  buildBodyFile,
} from './create-article.mjs';
import { bumpUpdatedAt, bumpDateModified, bumpSitemapLastmod } from './lib/evergreen-article-refresh.mjs';
import { corpusPath } from './lib/corpus-paths.mjs';
import { sanitizeText } from '../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './lib/control-char-write-report.mjs';
import { refreshDescriptiveTexts } from './lib/article-meta-refresh.mjs';
import { sanitizePromptPlaceholders } from './lib/prompt-placeholder-guard.mjs';
import { acquirePharmacyEvergreenRefresh } from './lib/pharmacy-evergreen-refresh-transaction.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECTION_NAME = 'svizzera';
const SECTION_FILES = Object.freeze({
  registryFile: 'data/swiss-articles-data.ts',
  metaPrefix: 'blog-meta-ch',
  bodyDir: 'blog-body-ch',
  seoFile: 'services/seo/seo-blog-ch.ts',
  sitemapFile: 'public/sitemap-blog-ch.xml',
});

let writeTmpSeq = 0;

function requestedSection() {
  let section = process.env.ARTICLE_SECTION || 'frontaliere';
  for (const arg of process.argv.slice(2)) {
    const match = /^--section=(.+)$/.exec(arg);
    if (match) section = match[1];
  }
  return section;
}

function assertSvizzeraSection() {
  const section = requestedSection();
  if (section !== SECTION_NAME) {
    throw new Error(
      `pharmacy evergreen: sezione "${SECTION_NAME}" obbligatoria; `
      + `eseguire con --section=${SECTION_NAME} (ricevuto "${section}")`,
    );
  }
}

function snapshotOptionsFromEnv() {
  const options = {};
  if (process.env.PHARMACY_CATALOG_SNAPSHOT_PATH) {
    options.catalogPath = process.env.PHARMACY_CATALOG_SNAPSHOT_PATH;
  }
  if (process.env.PHARMACY_DUTY_SNAPSHOT_PATH) {
    options.dutyPath = process.env.PHARMACY_DUTY_SNAPSHOT_PATH;
  }
  return options;
}

function resolveInput(input) {
  if (input?.catalog && input?.duty) return input;
  return loadPharmacySnapshots(input || snapshotOptionsFromEnv());
}

/** Build deterministic data from the validated pharmacy snapshots. */
export function buildData(input = null) {
  return buildPharmacyEvergreenGuides(resolveInput(input));
}

function writeBodyFile(file, body) {
  const clean = sanitizeText(body);
  reportStrippedControlChars(file, body, clean);
  const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    writeFileSync(tmp, clean, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function stageCorpusFile(transaction, file, content) {
  const clean = sanitizeText(content);
  reportStrippedControlChars(file, content, clean);
  transaction.stage(file, clean);
}

/** Rewrite the five localized body chunks without re-registering the article. */
export function refreshBodyFiles(data, repoRoot = REPO_ROOT, log = console.log, writeFile = writeBodyFile) {
  sanitizePromptPlaceholders(data);
  assertGeneratedArticleQuality(data);
  assertArticlePassesFactualityGates(data);
  for (const locale of PHARMACY_LOCALES) {
    const dir = path.join(repoRoot, corpusPath(`services/locales/${SECTION_FILES.bodyDir}`), locale);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${data.id}.ts`);
    writeFile(file, buildBodyFile(data, locale));
    log(`  ✅ ${path.relative(repoRoot, file)}`);
  }
}

/** Refresh localized meta and the Swiss SEO entry for an existing stable ID. */
export function refreshMetaAndSeo(data, repoRoot = REPO_ROOT, writeFile = null, readFile = null) {
  sanitizePromptPlaceholders(data);
  assertArticlePassesFactualityGates(data);
  const localeTexts = Object.fromEntries(PHARMACY_LOCALES.map((locale) => {
    const content = data.content?.[locale] || {};
    return [locale, {
      excerpt: content.excerpt,
      seoDescription: content.seoDescription,
      ogDescription: content.ogDescription,
    }];
  }));
  const io = {
    repoRoot,
    metaPrefix: SECTION_FILES.metaPrefix,
    seoFile: SECTION_FILES.seoFile,
  };
  if (writeFile) io.writeFile = writeFile;
  if (readFile) io.readFile = readFile;
  return refreshDescriptiveTexts(
    data.id,
    localeTexts,
    { description: data.seo?.description, ogDescription: data.seo?.ogDescription },
    io,
  );
}

function dateModifiedWithExplicitUtcOffset(isoTimestamp) {
  return isoTimestamp.replace(/Z$/, '+00:00');
}

function preflight(data) {
  sanitizePromptPlaceholders(data);
  assertGeneratedArticleQuality(data);
  assertArticlePassesFactualityGates(data);
}

function refreshExistingGuides(states) {
  const transaction = acquirePharmacyEvergreenRefresh(REPO_ROOT, { log: console.log });
  const writeFile = (file, content) => stageCorpusFile(transaction, file, content);
  const readFile = (file) => transaction.read(file);
  try {
    for (const { guide } of states) {
      console.log(`♻️  refreshing ${guide.id}…`);
      refreshBodyFiles(guide, REPO_ROOT, console.log, writeFile);
      const meta = refreshMetaAndSeo(guide, REPO_ROOT, writeFile, readFile);
      if (meta.changed) {
        for (const file of meta.touched) console.log(`  ✅ staged ${path.relative(REPO_ROOT, file)}`);
      } else {
        console.log('  ♻️  meta/seo already current — nothing to rewrite.');
      }

      const refreshDate = guide._snapshotUpdatedAt.slice(0, 10);
      if (!bumpUpdatedAt(
        guide.id,
        refreshDate,
        REPO_ROOT,
        SECTION_FILES.registryFile,
        writeFile,
        readFile,
      )) {
        throw new Error(`pharmacy evergreen: updatedAt non aggiornato per ${guide.id}`);
      }
      if (!bumpDateModified(
        guide.id,
        dateModifiedWithExplicitUtcOffset(guide._snapshotUpdatedAt),
        REPO_ROOT,
        SECTION_FILES.seoFile,
        writeFile,
        readFile,
      )) {
        throw new Error(`pharmacy evergreen: dateModified non aggiornato per ${guide.id}`);
      }
      if (!bumpSitemapLastmod(guide.slugs.it, refreshDate, REPO_ROOT, SECTION_FILES.sitemapFile)) {
        throw new Error(`pharmacy evergreen: sitemap non aggiornato per ${guide.id}`);
      }
      console.log(`✅ staged ${guide.id}.`);
    }
    transaction.commit();
    console.log('✅ pharmacy evergreen refresh transaction committed.');
  } catch (error) {
    try {
      transaction.rollback();
    } catch (rollbackError) {
      throw new Error(`${error.message}; ${rollbackError.message}`);
    }
    throw error;
  }
}

async function main() {
  assertSvizzeraSection();
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const snapshots = loadPharmacySnapshots(snapshotOptionsFromEnv());
  const guides = buildPharmacyEvergreenGuides(snapshots);

  // Validate every guide before the first write, so a bad localized payload
  // cannot leave a partially registered five-guide batch behind.
  for (const guide of guides) preflight(guide);
  if (!dryRun) resolveRegisterLockAtStartup();

  const states = guides.map((guide) => ({ guide, exists: checkArticleIdExists(guide.id) }));
  console.log(
    `💊 pharmacy evergreen — section=${SECTION_NAME} `
    + `guides=${guides.length} snapshot=${guides[0]._snapshotUpdatedAt} `
    + `existing=${states.filter((state) => state.exists).length} dry=${dryRun}`,
  );

  if (dryRun) {
    console.log('DRY_RUN — no files written.');
    for (const { guide, exists } of states) {
      console.log(`  ${exists ? '♻️' : '📂'} ${guide.id} — ${guide.content.it.title}`);
    }
    return;
  }

  const existing = states.filter((state) => state.exists);
  for (const { guide, exists } of states) {
    if (exists) continue;
    console.log(`📂 first run — registering ${guide.id}…`);
    await registerArticleFiles(guide, { skipNews: true });
    console.log(`✅ registered ${guide.id}.`);
  }
  if (existing.length > 0) refreshExistingGuides(existing);
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error('❌', error.message);
    process.exit(1);
  });
}
