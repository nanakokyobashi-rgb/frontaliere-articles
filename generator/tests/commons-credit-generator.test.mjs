/**
 * Safe image governance at the generator boundary.
 *
 * The old suite exercised the removed Commons/stock generation strategies by
 * slicing their implementation out of create-article.mjs. Commons records are
 * still covered by commons-credit.test.mjs; this suite now pins the contract
 * that new covers use the mirrored engine or a record-bearing catalog entry.
 * It stays dependency-free so it runs before npm ci.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendEditorialImageRecord,
  appendGeneratedImageRecord,
  buildBlogImageCreditsAggregate,
  buildPublishedBlogImageRegistry,
  hasValidBlogImageRecord,
  imageRecordForPath,
  validateEditorialImageRecord,
} from '../scripts/lib/blog-image-registry.mjs';
import { classifyJournalistImage, editorialUploadMetadata } from '../scripts/lib/journalist-image-policy.mjs';
import {
  GENERATED_IMAGE_CREDIT,
  GENERATED_IMAGE_LICENSE,
  GENERATED_IMAGE_LICENSE_URLS,
  GENERATED_IMAGE_PROMPT_VERSION,
  GENERATED_IMAGE_RESTRICTIONS,
  validateGeneratedImageRecord,
} from '../../engine/shared/generatedImageRegistry.mjs';

const CREATE = fs.readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf-8');
const JOURNALIST = fs.readFileSync(new URL('../scripts/publish-journalist-article.mjs', import.meta.url), 'utf-8');
const RETIRED_FLASH_IMAGE_MODEL = ['gemini', '2.5', 'flash', 'image'].join('-');

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `marker not found after the start: ${endMarker}`);
  return src.slice(start, end);
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'safe-image-generator-'));
}

function generatedRecord(overrides = {}) {
  return {
    schema: 1,
    assetId: 'article-governance-test',
    provider: 'openai-codex',
    model: 'gpt-image-2.5',
    executorModel: 'gpt-5.6-luna',
    promptVersion: GENERATED_IMAGE_PROMPT_VERSION,
    promptHash: 'a'.repeat(64),
    license: GENERATED_IMAGE_LICENSE,
    licenseUrl: GENERATED_IMAGE_LICENSE_URLS['openai-codex'],
    credit: GENERATED_IMAGE_CREDIT,
    width: 1200,
    height: 675,
    format: 'webp',
    bytes: 1024,
    sha256: 'b'.repeat(64),
    generatedAt: '2026-10-06T10:00:00.000Z',
    verifiedAt: '2026-10-06T10:01:00.000Z',
    restrictions: [...GENERATED_IMAGE_RESTRICTIONS],
    scope: 'article-hero',
    imageUrl: '/images/generated/article-governance-test.webp',
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      looks_like_specific_real_event: false,
      notes: 'generic editorial illustration',
    },
    ...overrides,
  };
}

test('the new-cover pipeline uses only the governed article-hero engine', () => {
  const imageFunction = slice(CREATE, 'async function generateArticleImage(data) {', 'const imageDeadline');
  const imageAdapter = slice(CREATE, 'async function generateArticleImage(data) {', '// ── Step 4: Modify source files');
  const imageStep = slice(CREATE, '  // Step 3b: Generate article image through the governed engine.', '  // Step 4: Modify files');

  assert.match(imageAdapter, /generateImageFromSpec/);
  assert.match(imageAdapter, /appendGeneratedImageRecord/);
  assert.match(imageAdapter, /scope:\s*'article-hero'/);
  for (const forbidden of [
    RETIRED_FLASH_IMAGE_MODEL,
    'pollinations.ai',
    'together.xyz',
    'fal.ai',
    'commons.wikimedia.org',
    'pixabay.com',
    'pexels.com',
  ]) {
    assert.doesNotMatch(imageAdapter, new RegExp(forbidden.replaceAll('.', '\\.'), 'i'), forbidden);
  }
  assert.doesNotMatch(imageStep, /fetch\s*\(/, 'the article cover step has no arbitrary image download');
  assert.match(imageStep, /imageRecordForPath\(PROJECT_ROOT, matched, \{ strict: true \}\)/);
  assert.match(CREATE, /Hero image has no valid provenance record/);
});

test('a failed generation can fall back only to a record-bearing catalog cover', () => {
  const imageStep = slice(CREATE, '  // Step 3b: Generate article image through the governed engine.', '  // Step 4: Modify files');
  assert.match(imageStep, /findBestFallbackImage\(data\)/);
  assert.match(imageStep, /imageRecordForPath\(PROJECT_ROOT, matched, \{ strict: true \}\)/);
  assert.match(imageStep, /No governed image or valid catalog fallback/);
  assert.doesNotMatch(imageStep, /PLACES_IMAGES|STATIC_FALLBACK_IMAGE|picsum\.photos/i);
});

test('the article adapter clears stale provenance before each governed attempt', () => {
  const imageFunction = slice(CREATE, 'async function generateArticleImage(data) {', 'const imageDeadline');
  for (const field of ['_imageCredit', '_generatedImageRecord', '_editorialImageRecord']) {
    assert.match(imageFunction, new RegExp(`delete data\\.${field};`));
  }
});

test('journalist URLs are downloaded only after the four-field upload check', () => {
  const resolver = slice(JOURNALIST, 'async function resolveHeroImage(data, doc) {', '\n/**\n * Resolves the byline');
  assert.match(resolver, /classifyJournalistImage\(rawImage, doc\)/);
  assert.match(resolver, /imageRecordForPath\(PROJECT_ROOT, rawImage, \{ strict: true \}\)/);
  assert.match(resolver, /if \(isEditorialUpload && upload\)/);
  assert.match(resolver, /appendEditorialImageRecord\(PROJECT_ROOT, record\)/);
  assert.match(resolver, /generateArticleImage\(data\)/);
  assert.doesNotMatch(resolver, /resolveCommonsPick|STATIC_FALLBACK_IMAGE/);
  assert.ok(
    resolver.indexOf('if (isEditorialUpload && upload)') < resolver.indexOf('fetch(rawImage'),
    'rawImage is fetched only inside the documented upload branch',
  );
  assert.match(resolver, /No governed image or valid catalog fallback/);
});

test('the pure journalist image policy rejects arbitrary URLs and accepts complete upload provenance', () => {
  assert.deepEqual(classifyJournalistImage('/images/blog/already-recorded.webp', {}), {
    kind: 'catalog',
    path: '/images/blog/already-recorded.webp',
  });
  assert.equal(classifyJournalistImage('https://example.test/photo.jpg', {}).kind, 'rejected-url');
  assert.equal(classifyJournalistImage('http://example.test/photo.jpg', {
    rightsHolder: 'Titolare', license: 'CC BY 4.0', proofUrl: 'https://example.test/license', author: 'Autore',
  }).kind, 'rejected-url');
  const doc = {
    image: 'https://example.test/photo.jpg',
    imageRights: {
      rightsHolder: 'Titolare dei diritti',
      license: 'CC BY 4.0',
      proofUrl: 'https://example.test/license',
      author: 'Autore della foto',
    },
  };
  assert.deepEqual(editorialUploadMetadata(doc), doc.imageRights);
  assert.equal(classifyJournalistImage(doc.image, doc).kind, 'editorial-upload');
  assert.equal(classifyJournalistImage(doc.image, doc).metadata.proofUrl, 'https://example.test/license');
});

test('generated and editorial records are reader-facing and discoverable by cover path', () => {
  const root = tempRoot();
  try {
    const generatedBytes = Buffer.from('generated image fixture');
    const generatedPath = path.join(root, 'public/images/generated/article-governance-test.webp');
    fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
    fs.writeFileSync(generatedPath, generatedBytes);
    const generated = generatedRecord({
      bytes: generatedBytes.length,
      sha256: crypto.createHash('sha256').update(generatedBytes).digest('hex'),
    });
    assert.equal(validateGeneratedImageRecord(generated).valid, true);
    appendGeneratedImageRecord(root, generated);
    assert.equal(imageRecordForPath(root, generated.imageUrl, { strict: true }).kind, 'generated');
    assert.equal(hasValidBlogImageRecord(root, generated.imageUrl), true);

    const editorialBytes = Buffer.from('editorial image fixture');
    const editorialPath = path.join(root, 'public/images/blog/editorial-governance-test.webp');
    fs.mkdirSync(path.dirname(editorialPath), { recursive: true });
    fs.writeFileSync(editorialPath, editorialBytes);
    const editorial = {
      schema: 1,
      source: 'editorial-upload',
      cover: '/images/blog/editorial-governance-test.webp',
      rightsHolder: 'Titolare dei diritti',
      license: 'CC BY 4.0',
      proofUrl: 'https://example.test/license',
      author: 'Autore della foto',
      sourceUrl: 'https://example.test/photo.jpg',
      modified: 'cropped',
      fetchedAt: '2026-10-06T10:02:00.000Z',
      status: 'ok',
      sha256: crypto.createHash('sha256').update(editorialBytes).digest('hex'),
      bytes: editorialBytes.length,
      width: 1200,
      height: 675,
    };
    assert.equal(validateEditorialImageRecord(editorial).valid, true);
    appendEditorialImageRecord(root, editorial);
    assert.equal(imageRecordForPath(root, editorial.cover, { strict: true }).kind, 'editorial-upload');
    assert.equal(hasValidBlogImageRecord(root, editorial.cover), true);

    const registry = buildPublishedBlogImageRegistry(root);
    const aggregate = buildBlogImageCreditsAggregate({
      commit: 'test-commit',
      sectionPayloads: { frontaliere: { covers: {}, files: {} } },
      registry,
    });
    assert.equal(aggregate.generated[generated.imageUrl].assetId, generated.assetId);
    assert.equal(aggregate.editorial[editorial.cover].rightsHolder, editorial.rightsHolder);
    assert.equal(aggregate.sections.frontaliere, 'image-credits-frontaliere.json');

    fs.writeFileSync(generatedPath, Buffer.from('tampered image fixture'));
    assert.equal(imageRecordForPath(root, generated.imageUrl), null, 'un record generated con hash stale non autorizza il file');
    assert.equal(buildPublishedBlogImageRegistry(root).generated[generated.imageUrl], undefined);
    assert.equal(validateEditorialImageRecord({ ...editorial, cover: '/images/blog/not-webp.jpg' }).valid, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
