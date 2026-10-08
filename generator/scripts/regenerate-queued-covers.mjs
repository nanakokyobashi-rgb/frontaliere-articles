#!/usr/bin/env node

import '../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { appendGeneratedImageRecord, imageRecordForPath, readGeneratedImageRecords } from './lib/blog-image-registry.mjs';
import { articleHeroImagePath, articleImageAssetId } from './lib/article-cover-identity.mjs';
import { webpDimensions } from './lib/commons-credit.mjs';
import {
  locateArticleRegistry,
  locateArticleSeoImage,
  updateArticleImageInRegistry,
  updateArticleImageInSeo,
} from './lib/article-registry-image.mjs';
import {
  appendImageRegenerationPublishOutbox,
  IMAGE_REGENERATION_PUBLISH_OUTBOX_REL,
} from './lib/image-regeneration-publish-outbox.mjs';
import {
  readImageRegenerationQueue,
  writeImageRegenerationQueue,
} from './lib/image-regeneration-queue.mjs';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;
export const IMAGE_BUDGET_MS = 120_000;
export const NO_TEXT_IMAGE_RETRY_HINT = 'Safety retry: absolutely no signs, lettering, words, numbers, logos, labels, banners, watermarks, or signature-like marks anywhere in the image.';

const GENERATED_REGISTRY_REL = 'data/generated-image-registry.json';
let writeTmpSeq = 0;

function absolute(root, relativePath) {
  return path.join(root, relativePath);
}

function snapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

function restoreFile(filePath, snapshot) {
  if (snapshot === null) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, snapshot);
}

function writeTextAtomic(filePath, text) {
  const target = path.resolve(filePath);
  const tmp = `${target}.${process.pid}.${writeTmpSeq++}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function trackFile(snapshots, filePath) {
  if (!snapshots.has(filePath)) snapshots.set(filePath, snapshotFile(filePath));
}

function restoreTransaction(snapshots) {
  for (const [filePath, snapshot] of snapshots) restoreFile(filePath, snapshot);
}

function removeStagingFile(filePath, destination) {
  if (!filePath || path.resolve(filePath) === path.resolve(destination)) return;
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
}

function normalizeReason(value) {
  const reason = String(value?.message || value || 'engine-failed')
    .replace(/(?:AIza|ghp_|github_pat_|GOCSPX-|sk-ant-|xox[baprs]-|AKIA)[^\s'"`]+/gi, '[redacted-secret]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return reason || 'engine-failed';
}

export function isVisualTextFailure(reason) {
  const normalized = String(reason || '');
  return /vision gate rejected image/i.test(normalized)
    && /(?:text|letter(?:ing)?|sign(?:age)?|watermark|signature|writing|logo|emblem|markings|cartell|scritte?)/i.test(normalized);
}

function parseLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function requestedAtSort(a, b) {
  const left = Date.parse(String(a.item.requestedAt || ''));
  const right = Date.parse(String(b.item.requestedAt || ''));
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (leftValid && rightValid && left !== right) return left - right;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return a.index - b.index;
}

function failureCountOf(item) {
  if (Number.isInteger(item?.failureCount) && item.failureCount >= 0) return item.failureCount;
  // Older queue entries predate failureCount. Their initial lastFailureAt is
  // copied from requestedAt; a later timestamp proves that they were already
  // attempted, so they must not masquerade as never-attempted work.
  const requestedAt = Date.parse(String(item?.requestedAt || ''));
  const lastFailureAt = Date.parse(String(item?.lastFailureAt || ''));
  return Number.isFinite(requestedAt) && Number.isFinite(lastFailureAt) && lastFailureAt > requestedAt ? 1 : 0;
}

function queueAttemptSort(a, b) {
  const failureDelta = failureCountOf(a.item) - failureCountOf(b.item);
  return failureDelta || requestedAtSort(a, b);
}

function sectionForRegistry(location) {
  if (location.section) return location.section;
  const cantonPath = /^content\/cantons\/([^/]+)\//.exec(String(location.path || ''));
  if (cantonPath) return cantonPath[1];
  if (String(location.path || '').includes('swiss-articles-data')) return 'svizzera';
  return 'frontaliere';
}

function imageArea(section) {
  if (section === 'frontaliere') return 'Ticino e pendolarismo transfrontaliero';
  if (section === 'svizzera') return 'Svizzera';
  const core = ARTICLE_SECTION_CORE_ALL[section];
  return core?.canton
    ? `Canton ${core.canton}`
    : 'Svizzera';
}

function imageFileForRecord(root, record) {
  const imageUrl = articleHeroImagePath(record?.imageUrl);
  return absolute(root, path.join('public', imageUrl.slice(1)));
}

function thumbnailFileForRecord(root, record) {
  const imageFile = imageFileForRecord(root, record);
  const stem = path.basename(imageFile, path.extname(imageFile));
  return path.join(path.dirname(imageFile), 'thumbnails', `${stem}-480w.webp`);
}

function hasValidThumbnail(root, record) {
  const thumbnail = thumbnailFileForRecord(root, record);
  try {
    const stat = fs.lstatSync(thumbnail);
    if (!stat.isFile()) return false;
    const dimensions = webpDimensions(fs.readFileSync(thumbnail));
    return dimensions?.width === 480
      && dimensions.height > 0
      && dimensions.height <= 480;
  } catch {
    return false;
  }
}

function existingRecordForArticle(root, articleId) {
  const assetId = articleImageAssetId(articleId);
  let records;
  try {
    records = readGeneratedImageRecords(root, { strict: false });
  } catch {
    return null;
  }
  const record = records.find((candidate) => candidate.assetId === assetId && candidate.scope === 'article-hero');
  if (!record) return null;
  try {
    return imageRecordForPath(root, record.imageUrl)?.record || null;
  } catch {
    return null;
  }
}

function alreadySatisfiedCover(root, item, registryFiles) {
  try {
    const location = locateArticleRegistry(root, item.articleId, { registryFiles });
    const record = existingRecordForArticle(root, item.articleId);
    if (!record || location.previousImage !== record.imageUrl) return false;
    if (!hasValidThumbnail(root, record)) return false;
    const section = sectionForRegistry(location);
    const seo = locateArticleSeoImage(root, item.articleId, { section });
    return seo.previousImage === record.imageUrl;
  } catch {
    return false;
  }
}

async function defaultGenerateCover(item, context) {
  const { generateGovernedArticleHero } = await import('./lib/article-cover-engine.mjs');
  return generateGovernedArticleHero({
    root: context.root,
    articleId: item.articleId,
    title: item.title,
    area: context.area,
    safetyHint: isVisualTextFailure(item.reason) ? NO_TEXT_IMAGE_RETRY_HINT : '',
    deadlineAt: Date.now() + IMAGE_BUDGET_MS,
    onProviderAttempt: ({ provider, attempt }) => {
      console.error(`  🎨 Copertina ${item.articleId}: ${provider}, tentativo ${attempt}`);
    },
  });
}

async function defaultGenerateThumbnail(sourcePath, { root, record } = {}) {
  const stagingName = String(record?.assetId || path.basename(sourcePath))
    .replace(/[^a-z0-9._-]+/gi, '-')
    .slice(0, 140);
  const stagingRoot = path.join(
    root,
    '.cache',
    'queued-cover-thumbnails',
    `${stagingName}-${process.pid}-${Date.now()}`,
  );
  const stagedSource = path.join(stagingRoot, path.basename(sourcePath));
  const stagedThumbnail = path.join(
    stagingRoot,
    'thumbnails',
    `${path.basename(sourcePath, path.extname(sourcePath))}-480w.webp`,
  );
  const targetThumbnail = thumbnailFileForRecord(root, record);
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.copyFileSync(sourcePath, stagedSource);
  try {
    execFileSync(process.execPath, [
      path.join(root, 'scripts', 'generate-image-thumbnails.mjs'),
      '--source-dir',
      stagingRoot,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!fs.existsSync(stagedThumbnail)) throw new Error(`thumbnail script produced no ${stagedThumbnail}`);
    fs.mkdirSync(path.dirname(targetThumbnail), { recursive: true });
    fs.copyFileSync(stagedThumbnail, targetThumbnail);
    return targetThumbnail;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function finalizeCover({ root, item, record, location, snapshots, generateThumbnail, registryFiles }) {
  const destination = imageFileForRecord(root, record);
  if (!fs.existsSync(destination)) throw new Error(`generated cover is not materialized: ${record.imageUrl}`);
  trackFile(snapshots, destination);
  const thumbnail = thumbnailFileForRecord(root, record);
  trackFile(snapshots, thumbnail);
  const section = sectionForRegistry(location);
  const seoLocation = locateArticleSeoImage(root, item.articleId, { section });
  trackFile(snapshots, absolute(root, seoLocation.path));

  if (!hasValidThumbnail(root, record)) await generateThumbnail(destination, { root, item, record });
  if (!hasValidThumbnail(root, record)) throw new Error(`thumbnail is not materialized: ${thumbnail}`);

  const currentImage = location.previousImage;
  if (currentImage !== record.imageUrl) {
    updateArticleImageInRegistry(root, item.articleId, record.imageUrl, { registryFiles });
  }
  updateArticleImageInSeo(root, item.articleId, record.imageUrl, { section });

  return {
    destination,
    thumbnail,
    changed: currentImage !== record.imageUrl,
  };
}

async function processItem({ root, item, generateCover, generateThumbnail, registryFiles }) {
  const location = locateArticleRegistry(root, item.articleId, { registryFiles });
  const section = sectionForRegistry(location);
  const snapshots = new Map();
  trackFile(snapshots, absolute(root, GENERATED_REGISTRY_REL));
  trackFile(snapshots, absolute(root, location.path));
  trackFile(snapshots, absolute(root, IMAGE_REGENERATION_PUBLISH_OUTBOX_REL));

  const existing = existingRecordForArticle(root, item.articleId);
  if (existing) {
    try {
      const result = await finalizeCover({ root, item, record: existing, location, snapshots, generateThumbnail, registryFiles });
      appendImageRegenerationPublishOutbox(root, { articleId: item.articleId, section });
      return { record: existing, ...result, reused: true, section, snapshots };
    } catch (error) {
      restoreTransaction(snapshots);
      throw error;
    }
  }

  let generated;
  try {
    generated = await generateCover(item, {
      root,
      section: sectionForRegistry(location),
      area: imageArea(sectionForRegistry(location)),
    });
    const record = generated?.record;
    const imageFile = imageFileForRecord(root, record);
    trackFile(snapshots, imageFile);
    trackFile(snapshots, thumbnailFileForRecord(root, record));

    if (!generated?.filePath || !fs.existsSync(generated.filePath)) {
      throw new Error(`governed engine returned no materialized image for ${record?.imageUrl || '<empty>'}`);
    }
    articleHeroImagePath(record.imageUrl);
    fs.mkdirSync(path.dirname(imageFile), { recursive: true });
    if (path.resolve(generated.filePath) !== path.resolve(imageFile)) {
      fs.renameSync(generated.filePath, imageFile);
    }
    appendGeneratedImageRecord(root, record);
    const result = await finalizeCover({ root, item, record, location, snapshots, generateThumbnail, registryFiles });
    appendImageRegenerationPublishOutbox(root, { articleId: item.articleId, section });
    removeStagingFile(generated.filePath, imageFile);
    return { record, ...result, reused: false, section, snapshots };
  } catch (error) {
    restoreTransaction(snapshots);
    if (generated?.filePath && fs.existsSync(generated.filePath)) {
      fs.rmSync(path.dirname(generated.filePath), { recursive: true, force: true });
    }
    throw error;
  }
}

function summaryFor(queue, result) {
  return {
    drained: result.drained,
    residual: queue.items.length,
    failed: result.failed,
    marked: queue.items.filter((item) => Number(item.failureCount || 0) >= 3).map((item) => item.articleId),
    failedIds: result.failedIds,
    reused: result.reused,
    alreadySatisfied: result.alreadySatisfiedIds.length,
    alreadySatisfiedIds: result.alreadySatisfiedIds,
    requeued: result.requeued,
    sections: result.sections,
  };
}

/**
 * Drain the least-failed eligible queue entries, after reconciling covers that
 * are already complete. The callbacks are injectable so the queue, rollback,
 * and registry-selection contract can be tested without a provider or image
 * codec.
 */
export async function drainQueuedCovers({
  root,
  limit = DEFAULT_LIMIT,
  now = () => new Date().toISOString(),
  generateCover = defaultGenerateCover,
  generateThumbnail = defaultGenerateThumbnail,
  registryFiles,
  retryFailed = false,
} = {}) {
  const boundedLimit = parseLimit(limit);
  const queue = readImageRegenerationQueue(root);
  const alreadySatisfiedIds = [];
  const unsatisfiedItems = [];
  for (const item of queue.items) {
    if (alreadySatisfiedCover(root, item, registryFiles)) alreadySatisfiedIds.push(item.articleId);
    else unsatisfiedItems.push(item);
  }
  if (alreadySatisfiedIds.length > 0) {
    queue.items = unsatisfiedItems;
    writeImageRegenerationQueue(root, queue);
  }
  const requeued = [];
  if (retryFailed) {
    for (const item of queue.items) {
      if (item.status !== 'failed') continue;
      item.status = 'queued';
      item.failureCount = 0;
      requeued.push(item.articleId);
    }
    if (requeued.length > 0) writeImageRegenerationQueue(root, queue);
  }
  const selected = queue.items
    .filter((item) => retryFailed || item.status !== 'failed')
    .map((item, index) => ({ item, index }))
    .sort(queueAttemptSort)
    .slice(0, boundedLimit)
    .map(({ item }) => item);
  const result = {
    drained: 0,
    failed: 0,
    failedIds: [],
    reused: 0,
    alreadySatisfiedIds,
    requeued,
    sections: {},
  };

  for (const item of selected) {
    let outcome = null;
    try {
      outcome = await processItem({ root, item, generateCover, generateThumbnail, registryFiles });
      const index = queue.items.indexOf(item);
      if (index < 0) throw new Error(`queue item disappeared before success: ${item.articleId}`);
      queue.items.splice(index, 1);
      try {
        writeImageRegenerationQueue(root, queue);
      } catch (error) {
        // A failed persistence must not turn an in-memory splice into a lost
        // queue item when the catch below records the failed attempt.
        queue.items.splice(index, 0, item);
        throw error;
      }
      result.drained += 1;
      if (outcome.reused) result.reused += 1;
      const section = outcome.section;
      if (!result.sections[section]) result.sections[section] = [];
      result.sections[section].push(item.articleId);
    } catch (error) {
      if (outcome?.snapshots) restoreTransaction(outcome.snapshots);
      const failureCount = Number.isInteger(item.failureCount) && item.failureCount >= 0 ? item.failureCount + 1 : 1;
      item.failureCount = failureCount;
      item.status = failureCount >= 3 ? 'failed' : 'queued';
      item.lastFailureAt = typeof now === 'function' ? now() : String(now);
      item.reason = normalizeReason(error);
      writeImageRegenerationQueue(root, queue);
      result.failed += 1;
      result.failedIds.push(item.articleId);
      console.error(`  ⚠️  Copertina ${item.articleId} non smaltita (${failureCount}° tentativo): ${item.reason}`);
    }
  }

  return summaryFor(queue, result);
}

function parseArgs(argv) {
  const options = {
    limit: DEFAULT_LIMIT,
    summary: null,
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    retryFailed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--limit') options.limit = parseLimit(argv[++index]);
    else if (arg === '--summary') options.summary = argv[++index];
    else if (arg === '--root') options.root = path.resolve(argv[++index]);
    else if (arg === '--retry-failed') options.retryFailed = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.summary === '') throw new Error('--summary requires a file path');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await drainQueuedCovers(options);
  if (options.summary) {
    writeTextAtomic(options.summary, `${JSON.stringify(summary, null, 2)}\n`);
  }
  console.log(JSON.stringify(summary));
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`❌ Queue drain failed: ${error.message || error}`);
    process.exit(1);
  });
}
