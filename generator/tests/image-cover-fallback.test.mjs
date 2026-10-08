import '../../host/cantonSectionsBootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_FALLBACK_MIN_SHARED_WORDS,
  catalogFallbackSharedWordCount,
  queueArticleCoverRegeneration,
  resolveArticleCoverFallback,
} from '../scripts/lib/article-cover-fallback.mjs';
import {
  appendGeneratedImageRecord,
  imageRecordForPath,
  sha256File,
} from '../scripts/lib/blog-image-registry.mjs';
import {
  GENERATED_IMAGE_CREDIT,
  GENERATED_IMAGE_LICENSE,
  GENERATED_IMAGE_LICENSE_URLS,
  GENERATED_IMAGE_PROMPT_VERSION,
  GENERATED_IMAGE_RESTRICTIONS,
  LICENSED_PHOTO_RESTRICTIONS,
} from '../../engine/shared/generatedImageRegistry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cover-fallback-'));
}
function generatedCatalogRecord() {
  return {
    schema: 1,
    assetId: 'catalog-fallback-test',
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
    sha256: '0'.repeat(64),
    generatedAt: '2026-10-07T00:00:00.000Z',
    verifiedAt: '2026-10-07T00:01:00.000Z',
    restrictions: [...GENERATED_IMAGE_RESTRICTIONS],
    scope: 'article-hero',
    imageUrl: '/images/blog/catalog-fallback-test.webp',
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      looks_like_specific_real_event: false,
      notes: 'generic catalog illustration',
    },
  };
}

function licensedCatalogRecord() {
  return {
    schema: 1,
    assetId: 'licensed-cover-ledger-test',
    kind: 'photo',
    provider: 'wikimedia',
    model: 'Wikimedia Commons file mirror',
    executorModel: 'Wikimedia Commons file mirror',
    license: 'CC BY-SA 4.0',
    licenseFamily: 'cc-by-sa',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    credit: 'Ada Foto · CC BY-SA 4.0',
    author: { name: 'Ada Foto', url: 'https://commons.wikimedia.org/wiki/User:Ada_Foto' },
    sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Zurich_employment_office.jpg',
    sourceImageUrl: 'https://upload.wikimedia.org/commons/Zurich_employment_office.jpg',
    sourceWidth: 2400,
    sourceHeight: 1600,
    photoTitle: 'Zurich employment office.jpg',
    copyrightNotice: '© Ada Foto',
    acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Zurich_employment_office.jpg',
    modifications: ['cropped', 'resized', 'converted-to-webp'],
    width: 1200,
    height: 675,
    format: 'webp',
    bytes: 1024,
    sha256: '0'.repeat(64),
    generatedAt: '2026-10-08T00:00:00.000Z',
    verifiedAt: '2026-10-08T00:01:00.000Z',
    restrictions: [...LICENSED_PHOTO_RESTRICTIONS],
    scope: 'article-hero',
    imageUrl: '/images/blog/licensed-cover-ledger-test.webp',
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      contains_recognizable_foreground_person: false,
      looks_like_specific_real_event: false,
      is_photograph: true,
      is_topic_relevant: true,
      notes: 'relevant, unbranded landscape photograph',
    },
  };
}

function article(id, title = 'Titolo di prova') {
  return {
    id,
    content: { it: { title } },
  };
}

test('engine failure uses a record-bearing catalog cover and queues regeneration', () => {
  const root = tempRoot();
  try {
    const record = generatedCatalogRecord();
    const file = path.join(root, 'public', record.imageUrl.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(record.bytes, 0x47));
    record.sha256 = sha256File(file);
    appendGeneratedImageRecord(root, record);

    const data = article('article-cover-fallback', 'Catalog fallback test');
    const result = resolveArticleCoverFallback(data, {
      root,
      findCatalogImage: () => record.imageUrl,
      reason: 'Gemini image request failed with HTTP 400',
    });

    assert.equal(result.source, 'catalog-fallback');
    assert.equal(data._generatedImagePath, record.imageUrl);
    assert.equal(data._generatedImageRecord.assetId, record.assetId);
    assert.equal(data.qualityReject, undefined);
    assert.equal(data.imagePolicyReject, undefined);
    assert.equal(fs.existsSync(path.join(root, 'data/image-regeneration-queue.json')), false);
    queueArticleCoverRegeneration(root, data);
    const queue = JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8'));
    assert.equal(queue.schema, 1);
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].fallbackImage, record.imageUrl);
    assert.match(queue.items[0].reason, /HTTP 400/);
    assert.equal(imageRecordForPath(root, record.imageUrl, { strict: true }).kind, 'generated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a licensed article hero writes the shared attribution ledger and resolves as licensed-photo', () => {
  const root = tempRoot();
  try {
    const record = licensedCatalogRecord();
    const file = path.join(root, 'public', record.imageUrl.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(record.bytes, 0x47));
    record.sha256 = sha256File(file);
    appendGeneratedImageRecord(root, record);

    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'content/image-credits/blog/licensed-cover-ledger-test.json'), 'utf8'));
    assert.equal(persisted.source, 'licensed-photo');
    assert.equal(persisted.photo.pageUrl, record.sourcePageUrl);
    assert.equal(persisted.licence.family, 'cc-by-sa');
    const provenance = imageRecordForPath(root, record.imageUrl, { strict: true });
    assert.equal(provenance.kind, 'licensed-photo');
    const data = article('licensed-cover-ledger-test', 'Tasse e lavoro a Zurigo');
    resolveArticleCoverFallback(data, { root, findCatalogImage: () => record.imageUrl });
    assert.equal(data._imageCredit.source, 'licensed-photo');
    assert.equal(data._imageCredit.licence.attributionRequired, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replacing a licensed hero with generated media removes the stale per-cover credit', () => {
  const root = tempRoot();
  try {
    const licensed = licensedCatalogRecord();
    const file = path.join(root, 'public', licensed.imageUrl.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(licensed.bytes, 0x47));
    licensed.sha256 = sha256File(file);
    appendGeneratedImageRecord(root, licensed);

    const generated = generatedCatalogRecord();
    generated.assetId = licensed.assetId;
    generated.imageUrl = licensed.imageUrl;
    generated.sha256 = licensed.sha256;
    appendGeneratedImageRecord(root, generated);

    assert.equal(fs.existsSync(path.join(root, 'content/image-credits/blog/licensed-cover-ledger-test.json')), false);
    assert.equal(imageRecordForPath(root, licensed.imageUrl, { strict: true }).kind, 'generated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un catalogo valido ma non pertinente non diventa la copertina finale', () => {
  const root = tempRoot();
  try {
    const record = generatedCatalogRecord();
    const file = path.join(root, 'public', record.imageUrl.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(record.bytes, 0x47));
    record.sha256 = sha256File(file);
    appendGeneratedImageRecord(root, record);

    const data = article('article-cover-irrelevant', 'Aggressione turisti Como');
    const result = resolveArticleCoverFallback(data, {
      root,
      findCatalogImage: () => record.imageUrl,
      reason: 'Codex broker timed out after 119999ms',
    });

    assert.equal(result.source, 'static');
    assert.equal(result.path, '/images/places/lugano-view.webp');
    assert.equal(data._generatedImageRecord.scope, 'place');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('la pertinenza della cover usa il testo finale e una soglia condivisa', () => {
  const data = article('article-cantello-teatro', 'Cantello teatro dialettale ottobre');
  data.imagePrompt = 'Scena editoriale sul teatro dialettale di Cantello';
  assert.equal(
    catalogFallbackSharedWordCount(data, '/images/blog/cantello-teatro-dialettale-ottobre-2026.webp'),
    4,
  );
  assert.equal(
    catalogFallbackSharedWordCount(data, '/images/blog/sindacati-miazzina-diritti-9-ottobre.webp'),
    1,
  );
  assert.equal(CATALOG_FALLBACK_MIN_SHARED_WORDS, 2);
});

test('la pertinenza confronta token esatti e ignora category e imagePrompt boilerplate', () => {
  const data = article('article-casa-tassa', 'Casa tassa');
  data.category = 'fiscale';
  data.imagePrompt = 'Scena editoriale fiscale';

  assert.equal(
    catalogFallbackSharedWordCount(data, '/images/blog/casale-tassazione.webp'),
    0,
  );
  assert.equal(
    catalogFallbackSharedWordCount(data, '/images/blog/fiscale-editoriale.webp'),
    0,
  );
});

test('when the catalog is empty, the governed static cover still publishes and deduplicates the queue', () => {
  const root = tempRoot();
  try {
    const data = article('article-static-fallback');
    const options = {
      root,
      findCatalogImage: () => null,
      reason: 'image-budget-expired',
    };
    const first = resolveArticleCoverFallback(data, options);
    queueArticleCoverRegeneration(root, data);
    resolveArticleCoverFallback(data, { ...options, reason: 'provider-timeout' });
    queueArticleCoverRegeneration(root, data);

    assert.equal(first.source, 'static');
    assert.equal(first.path, '/images/places/lugano-view.webp');
    assert.equal(data._generatedImageRecord.scope, 'place');
    const queue = JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8'));
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].reason, 'provider-timeout');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the generator lets the governed chain reach licensed photos and keeps the 120-second phase budget', () => {
  const source = fs.readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
  const engine = fs.readFileSync(path.join(ROOT, 'generator/scripts/lib/article-cover-engine.mjs'), 'utf8');
  assert.doesNotMatch(engine, /maxAttempts:\s*1/);
  assert.match(engine, /usedRecords: usedArticlePhotoRecords\(root\)/);
  assert.match(engine, /readCreditRecords\(root\)/);
  assert.match(engine, /topic: articleImageTopic/);
  assert.match(engine, /place: articleImagePlace\(articleData, area\)/);
  assert.match(engine, /keywords: articleImageKeywords/);
  assert.match(source, /Math\.min\(120_000/);
  assert.match(source, /generateGovernedArticleHero/);
  assert.match(source, /deadlineAt:\s*imageDeadline/);
});
