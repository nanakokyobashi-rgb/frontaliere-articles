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

test('the generator bounds the outage path to one attempt and 120 seconds', () => {
  const source = fs.readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
  const engine = fs.readFileSync(path.join(ROOT, 'generator/scripts/lib/article-cover-engine.mjs'), 'utf8');
  assert.match(engine, /maxAttempts:\s*1/);
  assert.match(source, /Math\.min\(120_000/);
  assert.match(source, /generateGovernedArticleHero/);
  assert.match(source, /deadlineAt:\s*imageDeadline/);
});
