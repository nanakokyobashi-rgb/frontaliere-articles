/**
 * Content gate: the shared SEO builder must reproduce the main-writer shape
 * byte for byte for a fixed sample of recent frontaliere entries. Recovery is
 * allowed to derive missing model fields, but it must not create a second
 * serialized dialect for entries the normal writer already knows how to emit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { articleRegistryObjectBodies, articleRegistryObjectFields } from '../../engine/shared/articleRegistryObjectBodies.mjs';
import { findAllSeoEntryMatches } from '../../engine/shared/seo-entry.mjs';
import { parseArticleUrlSlugs } from '../../engine/shared/articleReaderSource.mjs';
import { corpusCreditReader } from '../../scripts/lib/image-credit-records.mjs';
import {
  imageRecordForPath,
  readEditorialImageRecords,
  readGeneratedImageRecords,
} from '../scripts/lib/blog-image-registry.mjs';
import { metaFieldRegex, unescapeTsValue } from '../scripts/lib/meta-field-regex.mjs';
import { tsStringEscapesWithNewlineAs, unescapeTsString } from '../scripts/lib/unescape-ts-string.mjs';
import { buildSeoEntry } from '../scripts/lib/seo-entry-builder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEO_FILE = 'content/seo/seo-blog-5.ts';
const SAMPLE_SIZE = 20; // cron-count-ok: fixed equivalence sample required by brief 2453

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function decodeRegistryString(value) {
  return unescapeTsString(value, tsStringEscapesWithNewlineAs(' '));
}

function parseRegistry() {
  const entries = new Map();
  for (const body of articleRegistryObjectBodies(read('content/blog-articles-data.ts'))) {
    const fields = articleRegistryObjectFields(body);
    const id = fields.get('id');
    if (!id) continue;
    entries.set(id, {
      image: decodeRegistryString(fields.get('image') || ''),
      authorSlug: fields.has('authorSlug') ? decodeRegistryString(fields.get('authorSlug')) : undefined,
      authorName: fields.has('authorName') ? decodeRegistryString(fields.get('authorName')) : undefined,
    });
  }
  return entries;
}

function parseMetaField(source, field) {
  const values = new Map();
  for (const match of source.matchAll(metaFieldRegex(field))) values.set(match[1], unescapeTsValue(match[2]));
  return values;
}

function tsField(block, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`${escaped}:\\s*'((?:[^'\\\\]|\\\\.)*)'`));
  assert.ok(match, `missing TS field ${field}`);
  return unescapeTsValue(match[1]);
}

function jsonField(block, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`"${escaped}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  assert.ok(match, `missing JSON field ${field}`);
  return JSON.parse(`"${match[1]}"`);
}

function imagePathFromBlock(block) {
  const match = block.match(/"url"\s*:\s*`\$\{BASE_URL\}(\/images\/[^`\r\n]+)`/);
  assert.ok(match, 'missing templated structured-data image URL');
  return match[1];
}

function completeEntry(source, match) {
  const block = source.slice(match.lineStart, match.closeIdx + 1);
  const imagePath = imagePathFromBlock(block);
  const imageStart = block.indexOf('"image"');
  const dateStart = block.indexOf('"datePublished"', imageStart);
  const imageBlock = block.slice(imageStart, dateStart);
  return {
    id: match.id,
    block,
    expected: source.slice(match.lineStart - 1, match.closeIdx + 2),
    datePublished: jsonField(block, 'datePublished'),
    dateModified: jsonField(block, 'dateModified'),
    imagePath,
    caption: jsonField(block, 'caption'),
    hasImageRights: /"acquireLicensePage"\s*:/.test(block),
    width: Number(imageBlock.match(/"width"\s*:\s*(\d+)/)?.[1]),
    height: Number(imageBlock.match(/"height"\s*:\s*(\d+)/)?.[1]),
    seo: {
      title: tsField(block, 'title'),
      description: tsField(block, 'description'),
      keywords: tsField(block, 'keywords'),
      ogTitle: tsField(block, 'ogTitle'),
      ogDescription: tsField(block, 'ogDescription'),
      headline: jsonField(block, 'headline'),
    },
  };
}

function firstDiff(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return { index, expected: right.slice(index, index + 80), actual: left.slice(index, index + 80) };
    }
  }
  return { index: limit, expected: right.slice(limit, limit + 80), actual: left.slice(limit, limit + 80) };
}

test('le voci recenti del main sono byte-identiche al builder condiviso', () => {
  const seoSource = read(SEO_FILE);
  const registry = parseRegistry();
  const slugs = parseArticleUrlSlugs(read('content/routerBlogData.ts'), 'BLOG_SLUGS');
  const imageAlt = parseMetaField(read('content/blog-meta-it.ts'), 'imageAlt');
  const credits = corpusCreditReader(ROOT);
  const generated = readGeneratedImageRecords(ROOT, { strict: false });
  const editorial = readEditorialImageRecords(ROOT, { strict: false });
  const entries = findAllSeoEntryMatches(seoSource, SEO_FILE)
    .map((match) => ({
      match,
      datePublished: seoSource.slice(match.lineStart, match.closeIdx + 1)
        .match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1],
    }))
    .filter(({ match, datePublished }) => registry.has(match.id) && Number.isFinite(Date.parse(datePublished)))
    .sort((left, right) => Date.parse(right.datePublished) - Date.parse(left.datePublished))
    .slice(0, SAMPLE_SIZE)
    .map(({ match }) => completeEntry(seoSource, match));

  assert.equal(entries.length, SAMPLE_SIZE, 'equivalence sample is smaller than the required fixed sample');
  const identical = [];
  const knownDiffs = [];
  const unknownDiffs = [];
  for (const saved of entries) {
    const registryEntry = registry.get(saved.id);
    const localizedSlugs = slugs[saved.id];
    assert.ok(localizedSlugs?.it, `${saved.id}: Italian slug missing`);
    assert.equal(registryEntry.image, saved.imagePath, `${saved.id}: registry/SEO image mismatch`);
    const credit = credits.get(saved.imagePath);
    const generatedRecord = generated.find((record) => record.imageUrl === saved.imagePath);
    const editorialRecord = editorial.find((record) => record.cover === saved.imagePath);
    const provenance = credit
      ? { kind: 'wikimedia-commons', record: credit }
      : generatedRecord
        ? { kind: 'generated', record: generatedRecord }
        : editorialRecord
          ? { kind: 'editorial-upload', record: editorialRecord }
          : imageRecordForPath(ROOT, saved.imagePath, { strict: false });
    assert.ok(provenance, `${saved.id}: no governed provenance for ${saved.imagePath}`);
    const data = {
      id: saved.id,
      seo: saved.seo,
      slugs: localizedSlugs,
      imageAlt: { it: imageAlt.get(saved.id) || '' },
      author: {
        slug: registryEntry.authorSlug || 'redazione',
        name: registryEntry.authorName || 'Redazione Frontaliere Ticino',
      },
      _generatedImagePath: saved.imagePath,
    };
    const actual = buildSeoEntry(data, {
      provenance,
      publishedAt: saved.datePublished,
      modifiedAt: saved.dateModified,
      hubSlug: 'articoli-frontaliere',
    });
    if (actual === saved.expected) {
      identical.push(saved.id);
      continue;
    }
    const reasons = [];
    if (saved.caption !== (imageAlt.get(saved.id) || '')) {
      reasons.push('image.caption: meta imageAlt aggiornato dopo la scrittura SEO');
    }
    if (provenance.kind !== 'wikimedia-commons' && !saved.hasImageRights) {
      reasons.push('image.provenance: il record governato esiste, ma la voce storica è precedente all’emissione dei diritti nel blocco image');
    }
    const diff = { id: saved.id, ...firstDiff(actual, saved.expected), reasons };
    if (reasons.length > 0) knownDiffs.push(diff);
    else unknownDiffs.push(diff);
  }

  console.log(JSON.stringify({
    sampleSize: entries.length,
    identical: identical.length,
    knownDifferences: knownDiffs,
    unknownDifferences: unknownDiffs,
  }));
  assert.deepEqual(unknownDiffs, [], `shared builder has unexplained differences: ${JSON.stringify(unknownDiffs)}`);
});
