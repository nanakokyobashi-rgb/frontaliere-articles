/**
 * Reader-facing provenance for blog cover images.
 *
 * Generated covers keep the strict engine record and its article-hero path
 * (the current engine uses `/images/blog/`; records from the older
 * `/images/generated/` layout remain readable). Editorial uploads use a
 * separate, explicit record because the engine's `generated-provider`
 * licence is not a licence for a human-supplied photograph. The aggregate is
 * published by build-blog-index.mjs as `data/image-credits-blog.json`.
 */

import '../../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateGeneratedImageRecord, validateGeneratedImageRegistry } from '../../../engine/shared/generatedImageRegistry.mjs';
import { corpusCreditReader } from '../../../scripts/lib/image-credit-records.mjs';
import { writeJsonAtomic } from './atomic-write-json.mjs';

export const GENERATED_IMAGE_REGISTRY_REL = 'data/generated-image-registry.json';
export const EDITORIAL_IMAGE_REGISTRY_REL = 'data/editorial-image-registry.json';
export const BLOG_IMAGE_CREDITS_AGGREGATE = 'data/image-credits-blog.json';
export const STATIC_FALLBACK_IMAGE = '/images/places/lugano-view.webp';

// The place asset is owned by the site and is materialized in the site tree,
// not in this corpus checkout. Keep its governed record available here so a
// corpus-only generator can publish it during an image-provider outage.
const STATIC_FALLBACK_RECORD = Object.freeze({
  schema: 1,
  assetId: 'lugano-view',
  provider: 'openai-codex',
  model: 'gpt-image-2.5',
  executorModel: 'gpt-5.6-luna',
  promptVersion: 'frontaliereticino.generated-image-policy.v1',
  promptHash: 'a552b810810fc3e04267e7c17af799c7a182a0cda5732e97212ee0b1d9e0cecb',
  license: 'generated-provider',
  licenseUrl: 'https://openai.com/policies/terms-of-use/',
  credit: 'frontaliereticino.ch',
  sha256: 'feb0ec2c59872a3d1ccb23dba22a436ca1d747d5e909b142cd4a593c550b6a96',
  bytes: 169332,
  width: 1200,
  height: 675,
  format: 'webp',
  generatedAt: '2026-10-06T19:26:04.084Z',
  verifiedAt: '2026-10-06T19:26:14.671Z',
  restrictions: [
    'illustrative-only',
    'no-real-recognizable-foreground-person',
    'no-public-figure-face',
    'no-logo-brand-or-text',
    'no-specific-real-event-photojournalism',
  ],
  scope: 'place',
  imageUrl: STATIC_FALLBACK_IMAGE,
  area: 'Canton Ticino e regione di confine',
  season: 'luce diurna equilibrata',
  variant: 'place-hero',
  vision: {
    ok: true,
    contains_text: false,
    contains_logo: false,
    contains_recognizable_face: false,
    looks_like_specific_real_event: false,
    notes: 'Original generic illustrated landscape; no readable text, logos, signatures, recognizable faces, or specific real event.',
  },
});

// New governed records are emitted and copied as WebP only. Accepting other
// extensions here would let a valid-looking registry point at a file that the
// API publisher never copies.
const IMAGE_PATH_RX = /^\/images\/(?:blog|generated)\/[A-Za-z0-9._-]+\.webp$/i;
const MATERIALIZED_IMAGE_PATH_RX = /^\/images\/(?:blog|generated)\/[A-Za-z0-9._-]+\.(?:webp|png|jpe?g|avif)$/i;
const HTTPS_RX = /^https:\/\//i;

function absolute(root, rel) {
  return path.join(root, rel);
}

function readJson(root, rel, fallback) {
  const file = absolute(root, rel);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${rel} is not valid JSON: ${error.message}`);
  }
}

function generatedEnvelope(assets) {
  return { schema: 1, assetCount: assets.length, assets };
}

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search ? parsed.search : ''}`.split('?')[0];
  } catch {
    return value.startsWith('/') ? value.split('?')[0] : null;
  }
}

function validImagePath(value) {
  return typeof value === 'string' && IMAGE_PATH_RX.test(value);
}

function materializedImagePath(root, imagePath) {
  if (!MATERIALIZED_IMAGE_PATH_RX.test(imagePath)) return null;
  return absolute(root, path.join('public', imagePath.slice(1)));
}

function hasMaterializedImageRecord(root, imagePath, record) {
  const file = materializedImagePath(root, imagePath);
  if (!file) return false;
  let stat;
  try {
    // Do not follow a symlink from a provenance record to bytes outside the
    // published tree.
    stat = fs.lstatSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (Number.isInteger(record?.bytes) && stat.size !== record.bytes) return false;
  if (typeof record?.sha256 === 'string' && sha256File(file) !== record.sha256.toLowerCase()) return false;
  return true;
}

export function readGeneratedImageRecords(root, { strict = true } = {}) {
  const raw = readJson(root, GENERATED_IMAGE_REGISTRY_REL, generatedEnvelope([]));
  const verdict = validateGeneratedImageRegistry(raw, { scope: undefined });
  if (!verdict.valid && strict) {
    throw new Error(`generated image registry is invalid: ${verdict.errors.join('; ')}`);
  }
  return (raw.assets || []).filter((record) => validateGeneratedImageRecord(record).valid);
}

export function readEditorialImageRecords(root, { strict = true } = {}) {
  const raw = readJson(root, EDITORIAL_IMAGE_REGISTRY_REL, { schema: 1, assets: [] });
  const assets = Array.isArray(raw) ? raw : raw.assets;
  if (!Array.isArray(assets)) throw new Error(`${EDITORIAL_IMAGE_REGISTRY_REL} must contain an assets array`);
  const valid = [];
  const errors = [];
  for (const record of assets) {
    const verdict = validateEditorialImageRecord(record);
    if (verdict.valid) valid.push(record);
    else errors.push(`${record?.cover || '<unknown>'}: ${verdict.errors.join(', ')}`);
  }
  if (errors.length && strict) throw new Error(`editorial image registry is invalid: ${errors.join('; ')}`);
  return valid;
}

export function validateEditorialImageRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { valid: false, errors: ['record must be an object'] };
  if (record.schema !== 1) errors.push('schema must be 1');
  if (record.source !== 'editorial-upload') errors.push('source must be editorial-upload');
  for (const field of ['cover', 'rightsHolder', 'license', 'proofUrl', 'author', 'fetchedAt']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) errors.push(`${field} is required`);
  }
  if (!validImagePath(record.cover) || !record.cover.startsWith('/images/blog/')) errors.push('cover must be a blog image path');
  for (const field of ['proofUrl', 'sourceUrl']) {
    if (record[field] !== undefined && !HTTPS_RX.test(String(record[field]))) errors.push(`${field} must be an https URL`);
  }
  if (record.status !== 'ok') errors.push('status must be ok');
  if (record.modified !== 'cropped' && record.modified !== 'resized') errors.push('modified must be cropped or resized');
  if (!/^[a-f0-9]{64}$/i.test(String(record.sha256 || ''))) errors.push('sha256 is required');
  if (!Number.isInteger(record.bytes) || record.bytes <= 0) errors.push('bytes must be positive');
  if (!Number.isInteger(record.width) || record.width <= 0 || !Number.isInteger(record.height) || record.height <= 0) errors.push('width/height must be positive');
  return { valid: errors.length === 0, errors };
}

export function imageRecordForPath(root, imagePath, { strict = false } = {}) {
  const normalized = normalizePath(imagePath);
  if (!normalized) return null;
  if (normalized === STATIC_FALLBACK_IMAGE) {
    // Prefer the versioned registry copy when present, but do not require the
    // corpus checkout to materialize bytes owned by the site repository.
    try {
      const registered = readGeneratedImageRecords(root, { strict: false })
        .find((record) => record.scope === 'place' && record.imageUrl === normalized);
      if (registered) return { kind: 'generated', record: registered };
    } catch {
      // The built-in governed record below keeps the outage fallback usable;
      // a malformed optional registry must not reject the article cover.
    }
    return { kind: 'generated', record: STATIC_FALLBACK_RECORD };
  }
  const generated = readGeneratedImageRecords(root, { strict })
    .find((record) => (record.scope === 'article-hero' || record.scope === 'place') && record.imageUrl === normalized);
  if (generated) {
    // Place records point at the site's static asset tree. Article-hero records
    // must still prove the materialized corpus bytes before publication.
    return generated.scope === 'place' || hasMaterializedImageRecord(root, normalized, generated)
      ? { kind: 'generated', record: generated }
      : null;
  }
  const editorial = readEditorialImageRecords(root, { strict }).find((record) => record.cover === normalized);
  if (editorial) return hasMaterializedImageRecord(root, normalized, editorial)
    ? { kind: 'editorial-upload', record: editorial }
    : null;
  try {
    const legacy = corpusCreditReader(root).get(normalized);
    if (legacy && hasMaterializedImageRecord(root, normalized, legacy)) {
      return { kind: 'wikimedia-commons', record: legacy };
    }
  } catch (error) {
    if (strict) throw error;
  }
  return null;
}

export function hasValidBlogImageRecord(root, imagePath) {
  return Boolean(imageRecordForPath(root, imagePath));
}

export function appendGeneratedImageRecord(root, record) {
  const verdict = validateGeneratedImageRecord(record);
  if (!verdict.valid) throw new Error(`generated image record rejected: ${verdict.errors.join('; ')}`);
  const assets = readGeneratedImageRecords(root);
  const next = assets.filter((item) => item.assetId !== record.assetId && item.imageUrl !== record.imageUrl);
  next.push(record);
  writeJsonAtomic(absolute(root, GENERATED_IMAGE_REGISTRY_REL), generatedEnvelope(next));
}

export function appendEditorialImageRecord(root, record) {
  const verdict = validateEditorialImageRecord(record);
  if (!verdict.valid) throw new Error(`editorial image record rejected: ${verdict.errors.join('; ')}`);
  const assets = readEditorialImageRecords(root);
  const next = assets.filter((item) => item.cover !== record.cover);
  next.push(record);
  writeJsonAtomic(absolute(root, EDITORIAL_IMAGE_REGISTRY_REL), { schema: 1, assetCount: next.length, assets: next });
}

export function buildPublishedBlogImageRegistry(root, images = []) {
  const selected = new Set(images.map(normalizePath).filter(Boolean));
  const generated = Object.fromEntries(
    readGeneratedImageRecords(root)
      .filter((record) => record.scope === 'article-hero' && validImagePath(record.imageUrl))
      .filter((record) => hasMaterializedImageRecord(root, record.imageUrl, record))
      .filter((record) => selected.size === 0 || selected.has(record.imageUrl))
      .map((record) => [record.imageUrl, record]),
  );
  const editorial = Object.fromEntries(
    readEditorialImageRecords(root).filter((record) => selected.size === 0 || selected.has(record.cover))
      .filter((record) => hasMaterializedImageRecord(root, record.cover, record))
      .map((record) => [record.cover, record]),
  );
  return { generated, editorial };
}

export function buildBlogImageCreditsAggregate({ commit, sectionPayloads, registry }) {
  const covers = {};
  const files = {};
  const sections = {};
  for (const [section, payload] of Object.entries(sectionPayloads)) {
    sections[section] = `image-credits-${section}.json`;
    Object.assign(covers, payload.covers || {});
    Object.assign(files, payload.files || {});
  }
  return {
    schema: 1,
    section: 'blog',
    commit: commit ?? null,
    covers,
    files,
    generated: registry.generated || {},
    editorial: registry.editorial || {},
    sections,
  };
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
