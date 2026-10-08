#!/usr/bin/env node
/**
 * Recover SEO entries for registry articles that already have corpus content.
 *
 * This is deliberately a data-driven recovery writer: it reads registry/meta
 * values, calls the recovery-only metadata derivation and the same SEO entry
 * builder used by the normal generator, resolves image provenance through the
 * licence engine, and performs an atomic replacement under a runner-local
 * lock. It never asks a model to invent copy and it has no hand-written
 * article payloads.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { articleRegistryObjectBodies, articleRegistryObjectFields } from '../../engine/shared/articleRegistryObjectBodies.mjs';
import { parseArticleUrlSlugs } from '../../engine/shared/articleReaderSource.mjs';
import { findSeoEntryMatches, removeSeoEntriesFromSource } from '../../engine/shared/seo-entry.mjs';
import { corpusCreditReader } from '../../scripts/lib/image-credit-records.mjs';
import { unescapeTsString, tsStringEscapesWithNewlineAs } from './lib/unescape-ts-string.mjs';
import { metaFieldRegex, unescapeTsValue } from './lib/meta-field-regex.mjs';
import { imageRecordForPath, STATIC_FALLBACK_IMAGE } from './lib/blog-image-registry.mjs';
import { buildSeoEntry, insertSeoEntriesAtHead, removeSeoEntriesWithSeparator, toIsoWithTz } from './lib/seo-entry-builder.mjs';
import { mergeQueueWithSnapshot } from './lib/seo-recovery-queue.mjs';
import { deriveSeoMetadata, normalizeSeoTitle } from './lib/seo-metadata-derivation.mjs';
import { queueArticleCoverRegeneration, resolveArticleCoverFallback } from './lib/article-cover-fallback.mjs';
import { updateArticleImageInRegistry } from './lib/article-registry-image.mjs';
import { readImageRegenerationQueue, writeImageRegenerationQueue } from './lib/image-regeneration-queue.mjs';
import { SEO_BACKFILL_LOCK_REL, beginSeoBackfillLock, endSeoBackfillLock } from './lib/seo-backfill-lock.mjs';
import { createWriteLedger, restoreWrittenFiles } from './lib/seo-recovery-rollback.mjs';
import { writeTextAtomic } from './lib/atomic-write-text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY_FILE = 'content/blog-articles-data.ts';
const ROUTER_FILE = 'content/routerBlogData.ts';
const SEO_FILE = 'content/seo/seo-blog-5.ts';
const SEO_CONST_NAME = 'BLOG_SEO_METADATA';
const HUB_SLUG = 'articoli-frontaliere';
const LOCALES = ['it', 'en', 'de', 'fr'];
const META_FIELDS = ['title', 'excerpt', 'imageAlt'];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function decodeRegistryString(value) {
  return unescapeTsString(value, tsStringEscapesWithNewlineAs(' '));
}

function parseRegistry() {
  const entries = [];
  for (const body of articleRegistryObjectBodies(read(REGISTRY_FILE))) {
    const fields = articleRegistryObjectFields(body);
    const id = fields.get('id');
    if (!id || !fields.get('category') || fields.get('date') === undefined || !fields.get('image')) continue;
    entries.push({
      id,
      category: decodeRegistryString(fields.get('category')),
      date: decodeRegistryString(fields.get('date')),
      updatedAt: fields.has('updatedAt') ? decodeRegistryString(fields.get('updatedAt')) : undefined,
      image: decodeRegistryString(fields.get('image')),
      authorSlug: fields.has('authorSlug') ? decodeRegistryString(fields.get('authorSlug')) : undefined,
      authorName: fields.has('authorName') ? decodeRegistryString(fields.get('authorName')) : undefined,
    });
  }
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function parseMetaByField(source, field) {
  const values = new Map();
  for (const match of source.matchAll(metaFieldRegex(field))) values.set(match[1], unescapeTsValue(match[2]));
  return values;
}

function parseMeta() {
  const byLocale = new Map();
  for (const locale of LOCALES) {
    const source = read(`content/blog-meta-${locale}.ts`);
    const fields = new Map(META_FIELDS.map((field) => [field, parseMetaByField(source, field)]));
    byLocale.set(locale, fields);
  }
  return byLocale;
}

function parseSlugs() {
  return parseArticleUrlSlugs(read(ROUTER_FILE), 'BLOG_SLUGS');
}

function valuesForArticle(meta, id) {
  const content = {};
  const imageAlt = {};
  for (const locale of LOCALES) {
    const fields = meta.get(locale);
    const values = Object.fromEntries(META_FIELDS.map((field) => [field, fields.get(field).get(id)]));
    const missing = META_FIELDS.filter((field) => typeof values[field] !== 'string' || values[field].trim() === '');
    if (missing.length > 0) {
      throw new Error(`${id}: meta ${locale} missing ${missing.join(', ')}`);
    }
    content[locale] = { title: values.title, excerpt: values.excerpt };
    imageAlt[locale] = values.imageAlt;
  }
  return { content, imageAlt };
}

function parseIds(file) {
  const ids = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error(`ids file vuoto: ${file}`);
  if (new Set(ids).size !== ids.length) throw new Error(`ids file contiene duplicati: ${file}`);
  return ids;
}

function existingTitleSet(titleById, currentId) {
  return new Set(
    [...titleById.entries()]
      .filter(([id, title]) => id !== currentId && title)
      .map(([, title]) => normalizeSeoTitle(title).toLowerCase()),
  );
}

function imageProvenance(registryEntry, credits) {
  const credit = credits.get(registryEntry.image);
  if (credit) return { kind: 'wikimedia-commons', record: credit, imagePath: registryEntry.image };
  const governed = imageRecordForPath(ROOT, registryEntry.image, { strict: true });
  if (governed) return { ...governed, imagePath: registryEntry.image };
  return null;
}

function buildArticle(registryEntry, meta, slugs, titleById, credits) {
  const localized = valuesForArticle(meta, registryEntry.id);
  const localizedSlugs = slugs[registryEntry.id];
  if (!localizedSlugs) throw new Error(`${registryEntry.id}: localized slugs missing from ${ROUTER_FILE}`);
  const declaredProvenance = imageProvenance(registryEntry, credits);
  const data = {
    id: registryEntry.id,
    category: registryEntry.category,
    date: registryEntry.date,
    updatedAt: registryEntry.updatedAt,
    image: registryEntry.image,
    author: {
      slug: registryEntry.authorSlug || 'redazione',
      name: registryEntry.authorName || 'Redazione Frontaliere Ticino',
    },
    content: localized.content,
    imageAlt: localized.imageAlt,
    slugs: localizedSlugs,
    seo: {},
    _generatedImagePath: registryEntry.image,
  };
  let provenance = declaredProvenance;
  let fallback = false;
  if (!provenance) {
    const resolution = resolveArticleCoverFallback(data, {
      root: ROOT,
      findCatalogImage: () => null,
      reason: 'declared cover has no governed provenance record',
    });
    if (resolution.source !== 'static' || resolution.path !== STATIC_FALLBACK_IMAGE) {
      throw new Error(`${registryEntry.id}: unexpected cover fallback ${resolution.path}`);
    }
    provenance = imageRecordForPath(ROOT, data._generatedImagePath, { strict: true });
    if (!provenance) throw new Error(`${registryEntry.id}: governed static fallback has no licence record`);
    fallback = true;
  }
  deriveSeoMetadata(data, {
    existingTitles: existingTitleSet(titleById, registryEntry.id),
    log: (message) => console.error(message),
  });
  const publishedAt = toIsoWithTz(registryEntry.date, { preserveExplicitOffset: false });
  const modifiedAt = toIsoWithTz(registryEntry.updatedAt || registryEntry.date, { preserveExplicitOffset: false });
  return {
    data,
    provenance,
    declaredImage: registryEntry.image,
    fallback,
    publishedAt,
    modifiedAt,
    entry: buildSeoEntry(data, {
      provenance,
      publishedAt,
      modifiedAt,
      hubSlug: HUB_SLUG,
    }),
  };
}

function run(idsFile, { dryRun = false } = {}) {
  const ids = parseIds(idsFile);
  const registry = parseRegistry();
  const meta = parseMeta();
  const slugs = parseSlugs();
  const titleById = parseMetaByField(read('content/blog-meta-it.ts'), 'title');
  const credits = corpusCreditReader(ROOT);
  const entries = ids.map((id) => {
    const registryEntry = registry.get(id);
    if (!registryEntry) throw new Error(`${id}: registry entry missing`);
    return buildArticle(registryEntry, meta, slugs, titleById, credits);
  });

  const provenanceCounts = {};
  for (const { provenance } of entries) provenanceCounts[provenance.kind] = (provenanceCounts[provenance.kind] || 0) + 1;
  const fallbackEntries = entries.filter((entry) => entry.fallback);
  const fallbackIds = fallbackEntries.map(({ data }) => data.id);
  const declaredImageCount = entries.length - fallbackEntries.length;
  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      ids: ids.length,
      seoEntriesBuilt: entries.length,
      seoFile: SEO_FILE,
      provenanceCounts,
      declaredImageCount,
      fallbackImageCount: fallbackEntries.length,
      fallbackImage: STATIC_FALLBACK_IMAGE,
      fallbackIds,
    }, null, 2));
    return;
  }

  const seoPath = path.join(ROOT, SEO_FILE);
  const registryPath = path.join(ROOT, REGISTRY_FILE);
  const queuePath = path.join(ROOT, 'data/image-regeneration-queue.json');
  // The marker first: the snapshots below are what a rollback puts back, so
  // they are read while no other recovery can be writing these files.
  beginSeoBackfillLock(ROOT, ids);
  const written = createWriteLedger();
  try {
    const before = fs.readFileSync(seoPath, 'utf8');
    const registryBefore = fs.readFileSync(registryPath, 'utf8');
    const queueBefore = fs.existsSync(queuePath) ? fs.readFileSync(queuePath, 'utf8') : null;
    const queueSnapshot = queueBefore === null ? { schema: 1, items: [] } : JSON.parse(queueBefore);
    const recordQueue = () => {
      if (fs.existsSync(queuePath)) written.record(queuePath, queueBefore, fs.readFileSync(queuePath, 'utf8'));
    };

    for (const { data } of fallbackEntries) {
      const update = updateArticleImageInRegistry(ROOT, data.id, STATIC_FALLBACK_IMAGE);
      if (update.nextText === undefined) throw new Error(`${data.id}: registry image update returned no text`);
      if (update.changed) written.record(registryPath, registryBefore, update.nextText);
    }

    let after = before;
    for (const id of ids) {
      const removal = removeSeoEntriesWithSeparator(after, id, {
        findSeoEntryMatches,
        removeSeoEntriesFromSource,
        fileLabel: SEO_FILE,
      });
      after = removal.src;
    }
    // At the head, not at the tail where the generator appends: see
    // insertSeoEntriesAtHead.
    after = insertSeoEntriesAtHead(after, entries.map(({ entry }) => entry), {
      seoConstName: SEO_CONST_NAME,
      fileLabel: SEO_FILE,
    });
    const missingAfterWrite = ids.filter((id) => findSeoEntryMatches(after, id, SEO_FILE).length !== 1);
    if (missingAfterWrite.length > 0) throw new Error(`SEO entry count after build is not one for: ${missingAfterWrite.join(', ')}`);
    writeTextAtomic(seoPath, after);
    written.record(seoPath, before, after);
    for (const { data } of fallbackEntries) {
      const queued = queueArticleCoverRegeneration(ROOT, data);
      recordQueue();
      if (!queued) throw new Error(`${data.id}: unable to queue declared-cover regeneration`);
    }
    const currentQueue = readImageRegenerationQueue(ROOT);
    // Same items, other order: nothing the drain removed meanwhile comes back.
    const queue = mergeQueueWithSnapshot(queueSnapshot, currentQueue);
    if (JSON.stringify(queue.items) !== JSON.stringify(currentQueue.items)) {
      writeImageRegenerationQueue(ROOT, queue);
      recordQueue();
    }
    const missingQueueItems = fallbackIds.filter((id) => !queue.items.some(
      (item) => item?.articleId === id && item.fallbackImage === STATIC_FALLBACK_IMAGE,
    ));
    if (missingQueueItems.length > 0) {
      throw new Error(`cover regeneration queue missing: ${missingQueueItems.join(', ')}`);
    }
    endSeoBackfillLock(ROOT);
  } catch (error) {
    try {
      // Only what this run wrote, and only where it is still what this run
      // left: a file changed since holds someone else's work.
      const { diverged } = restoreWrittenFiles(written.entries());
      if (diverged.length === 0) {
        endSeoBackfillLock(ROOT);
      } else {
        error.rollbackDiverged = diverged;
        console.error(`Rollback SEO parziale: ${diverged.map((file) => path.relative(ROOT, file)).join(', ')} `
          + 'è cambiato dopo la scrittura di questa run e non è stato ripristinato. '
          + `Il marker ${SEO_BACKFILL_LOCK_REL} resta al suo posto finché qualcuno non ha guardato.`);
      }
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
      console.error(`Rollback SEO incompleto: ${rollbackError.message}`);
    }
    throw error;
  }

  console.log(JSON.stringify({
    ids: ids.length,
    seoEntriesWritten: entries.length,
    seoFile: SEO_FILE,
    provenanceCounts,
    declaredImageCount,
    fallbackImageCount: fallbackEntries.length,
    fallbackImage: STATIC_FALLBACK_IMAGE,
    fallbackIds,
    queuedCoverRegenerations: fallbackIds.length,
    queueItemsAfterRecovery: readImageRegenerationQueue(ROOT).items.length,
  }, null, 2));
}

const args = process.argv.slice(2);
const idsFlag = args.indexOf('--ids-file');
const dryRun = args.includes('--dry-run');
const unexpected = args.filter((arg, index) => arg !== '--ids-file' && arg !== '--dry-run' && index !== idsFlag + 1);
if (idsFlag < 0 || !args[idsFlag + 1] || unexpected.length > 0) {
  console.error('Uso: node generator/scripts/recover-seo-orphans.mjs --ids-file /path/to/ids.txt [--dry-run]');
  process.exitCode = 2;
} else {
  run(path.resolve(args[idsFlag + 1]), { dryRun });
}
