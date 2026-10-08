import '../../host/cantonSectionsBootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GENERATED_IMAGE_CREDIT,
  GENERATED_IMAGE_LICENSE,
  GENERATED_IMAGE_LICENSE_URLS,
  GENERATED_IMAGE_PROMPT_VERSION,
  GENERATED_IMAGE_RESTRICTIONS,
} from '../../engine/shared/generatedImageRegistry.mjs';
import { articleImageAssetId } from '../scripts/lib/article-cover-identity.mjs';
import { webpDimensions } from '../scripts/lib/commons-credit.mjs';
import { appendImageRegenerationQueue } from '../scripts/lib/image-regeneration-queue.mjs';
import {
  drainQueuedCovers,
  isVisualTextFailure,
  NO_TEXT_IMAGE_RETRY_HINT,
} from '../scripts/regenerate-queued-covers.mjs';
import { mergeImageRegistryDelta } from '../../scripts/ci/merge-generated-image-registry.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cover-queue-drain-'));
}

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function queue(root, items) {
  write(root, 'data/image-regeneration-queue.json', JSON.stringify({ schema: 1, items }, null, 2));
}

function registryEntry(id, image) {
  return `export const ARTICLES = [\n {\n id: '${id}',\n image: '${image}',\n },\n];\n`;
}

function seoEntry(id, image = '/images/places/fallback.webp') {
  return `  'blog-${id}': {\n    title: '${id}',\n    description: '${id}',\n    keywords: '${id}',\n    ogTitle: '${id}',\n    ogDescription: '${id}',\n    canonicalPath: '/articoli-frontaliere/${id}/',\n    structuredData: {\n      "image": {\n        "url": \`\${BASE_URL}${image}\`,\n        "width": 1200,\n        "height": 675\n      },\n      "datePublished": "2026-10-07T12:00:00+00:00"\n    }\n  },\n`;
}

function inlineSeoEntry(id, image = '/images/places/fallback.webp') {
  return `  'blog-${id}': {\n    canonicalPath: '/articoli-frontaliere/${id}/',\n    structuredData: {\n      "image": { "@type": "ImageObject", "url": \`\${BASE_URL}${image}\`, "width": 1200, "height": 675 },\n      "datePublished": "2026-10-07T12:00:00+00:00"\n    }\n  },\n`;
}

function seoFile(entries) {
  return `const BASE_URL = 'https://frontaliereticino.ch';\nconst BLOG_SEO_METADATA = {\n${entries.join('\n')}\n};\nexport default BLOG_SEO_METADATA;\n`;
}

function generatedRecord(root, articleId, imageUrl, bytes) {
  return {
    schema: 1,
    assetId: articleImageAssetId(articleId),
    provider: 'openai-codex',
    model: 'gpt-image-2.5',
    executorModel: 'gpt-5.6-luna',
    promptVersion: GENERATED_IMAGE_PROMPT_VERSION,
    promptHash: 'a'.repeat(64),
    license: GENERATED_IMAGE_LICENSE,
    licenseUrl: GENERATED_IMAGE_LICENSE_URLS['openai-codex'],
    credit: GENERATED_IMAGE_CREDIT,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    width: 1200,
    height: 675,
    format: 'webp',
    generatedAt: '2026-10-07T12:00:00.000Z',
    verifiedAt: '2026-10-07T12:00:01.000Z',
    restrictions: [...GENERATED_IMAGE_RESTRICTIONS],
    scope: 'article-hero',
    imageUrl,
    area: 'Test',
    season: 'all seasons',
    variant: 'article hero',
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      looks_like_specific_real_event: false,
      notes: 'test fixture',
    },
  };
}

function fixture(root, items) {
  write(root, 'data/generated-image-registry.json', JSON.stringify({ schema: 1, assetCount: 0, assets: [] }));
  queue(root, items);
  const entries = items.map((entry) => inlineSeoEntry(entry.articleId));
  write(root, 'content/seo/seo-blog-5.ts', seoFile(entries));
  write(root, 'content/cantons/canton-ti/seo.ts', seoFile(entries));
}

function item(articleId, requestedAt, title = articleId) {
  return {
    articleId,
    title,
    fallbackImage: '/images/places/lugano-view.webp',
    reason: 'engine failed',
    status: 'queued',
    requestedAt,
    lastFailureAt: requestedAt,
  };
}

function validThumbnailBytes() {
  return Buffer.from('UklGRigAAABXRUJQVlA4TBsAAAAv30FDAAdQti71tv8BAEX6/58i+p/63//+TxoA', 'base64');
}

async function decodeFixtureThumbnail(bytes) {
  const dimensions = webpDimensions(bytes);
  if (!dimensions || bytes.length !== validThumbnailBytes().length) throw new Error('truncated WebP fixture');
  return dimensions;
}

function drain(options) {
  return drainQueuedCovers({ decodeThumbnail: decodeFixtureThumbnail, ...options });
}

function fakeCover(root) {
  return async (entry) => {
    const bytes = Buffer.from(`cover:${entry.articleId}`);
    const imageUrl = `/images/blog/${articleImageAssetId(entry.articleId)}.webp`;
    const filePath = path.join(root, '.cache', `${entry.articleId}.webp`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
    return { filePath, record: generatedRecord(root, entry.articleId, imageUrl, bytes) };
  };
}

async function fakeThumbnail(sourcePath) {
  const thumbPath = path.join(
    path.dirname(sourcePath),
    'thumbnails',
    `${path.basename(sourcePath, path.extname(sourcePath))}-480w.webp`,
  );
  fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
  fs.writeFileSync(thumbPath, validThumbnailBytes());
  return thumbPath;
}

test('smaltisce in ordine, rimuove solo il successo e aggiorna il registro giusto', async () => {
  const root = tempRoot();
  try {
    write(root, 'content/blog-articles-data.ts', registryEntry('front-oldest', '/images/places/old.webp'));
    write(root, 'content/cantons/canton-ti/registry.ts', registryEntry('canton-newer', '/images/places/old.webp'));
    fixture(root, [
      item('canton-newer', '2026-10-07T10:00:00.000Z'),
      item('front-oldest', '2026-10-07T09:00:00.000Z'),
    ]);

    let calls = 0;
    const generateCover = fakeCover(root);
    const summary = await drain({
      root,
      limit: 1,
      generateCover: async (...args) => {
        calls += 1;
        return generateCover(...args);
      },
      generateThumbnail: fakeThumbnail,
      now: () => '2026-10-07T13:00:00.000Z',
    });

    assert.equal(calls, 1);
    assert.equal(summary.drained, 1);
    assert.equal(summary.residual, 1);
    assert.deepEqual(summary.sections.frontaliere, ['front-oldest']);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-publish-outbox.json'), 'utf8')).items,
      [{ articleId: 'front-oldest', section: 'frontaliere' }],
    );
    assert.match(fs.readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf8'), /article-front-oldest\.webp/);
    assert.match(fs.readFileSync(path.join(root, 'content/seo/seo-blog-5.ts'), 'utf8'), /article-front-oldest\.webp/);
    assert.match(fs.readFileSync(path.join(root, 'content/cantons/canton-ti/registry.ts'), 'utf8'), /old\.webp/);

    const remaining = JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8'));
    assert.deepEqual(remaining.items.map((entry) => entry.articleId), ['canton-newer']);

    const second = await drain({
      root,
      limit: 1,
      generateCover: async (...args) => {
        calls += 1;
        return generateCover(...args);
      },
      generateThumbnail: fakeThumbnail,
    });
    assert.equal(second.drained, 1);
    assert.equal(second.residual, 0);
    assert.deepEqual(second.sections['canton-ti'], ['canton-newer']);
    assert.match(fs.readFileSync(path.join(root, 'content/cantons/canton-ti/registry.ts'), 'utf8'), /article-canton-newer\.webp/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-publish-outbox.json'), 'utf8')).items,
      [
        { articleId: 'front-oldest', section: 'frontaliere' },
        { articleId: 'canton-newer', section: 'canton-ti' },
      ],
    );
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('seleziona prima le voci mai tentate e poi quelle con meno fallimenti', async () => {
  const root = tempRoot();
  try {
    const entries = ['never-attempted', 'legacy-failure', 'one-failure', 'many-failures']
      .map((articleId) => ` {\n id: '${articleId}',\n image: '/images/places/fallback.webp',\n },`)
      .join('\n');
    write(root, 'content/blog-articles-data.ts', `export const ARTICLES = [\n${entries}\n];\n`);
    fixture(root, [
      { ...item('many-failures', '2026-10-07T08:00:00.000Z'), failureCount: 2 },
      { ...item('legacy-failure', '2026-10-07T08:30:00.000Z'), lastFailureAt: '2026-10-07T08:45:00.000Z' },
      { ...item('one-failure', '2026-10-07T09:00:00.000Z'), failureCount: 1 },
      { ...item('never-attempted', '2026-10-07T10:00:00.000Z'), failureCount: 0 },
    ]);

    const seen = [];
    const summary = await drain({
      root,
      limit: 4,
      generateCover: async (entry, ...args) => {
        seen.push(entry.articleId);
        return fakeCover(root)(entry, ...args);
      },
      generateThumbnail: fakeThumbnail,
    });

    assert.deepEqual(seen, ['never-attempted', 'legacy-failure', 'one-failure', 'many-failures']);
    assert.equal(summary.drained, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonizza gli articleId duplicati prima di selezionare e rimuovere il lavoro', async () => {
  const root = tempRoot();
  try {
    const articleId = 'duplicate-queue-entry';
    write(root, 'content/blog-articles-data.ts', registryEntry(articleId, '/images/places/fallback.webp'));
    write(root, 'content/seo/seo-blog-5.ts', seoFile([seoEntry(articleId)]));
    write(root, 'data/generated-image-registry.json', JSON.stringify({ schema: 1, assetCount: 0, assets: [] }));
    queue(root, [
      item(articleId, '2026-10-07T09:00:00.000Z'),
      { ...item(articleId, '2026-10-07T10:00:00.000Z'), reason: 'newer request' },
    ]);

    let calls = 0;
    const summary = await drain({
      root,
      limit: 1,
      generateCover: async (...args) => {
        calls += 1;
        return fakeCover(root)(...args);
      },
      generateThumbnail: fakeThumbnail,
    });

    assert.equal(calls, 1);
    assert.equal(summary.drained, 1);
    assert.equal(summary.residual, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8')).items, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una nuova accodatura aggiorna requestedAt ma conserva il contatore dei fallimenti', () => {
  const root = tempRoot();
  try {
    const articleId = 'requeued-after-drain-start';
    queue(root, [{
      ...item(articleId, '2026-10-07T22:00:00.000Z'),
      failureCount: 2,
    }]);
    assert.equal(appendImageRegenerationQueue(root, {
      articleId,
      title: articleId,
      fallbackImage: '/images/places/fallback.webp',
      reason: 'new request',
      requestedAt: '2026-10-07T22:41:00.000Z',
    }), true);
    const updated = JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8')).items[0];
    assert.equal(updated.requestedAt, '2026-10-07T22:41:00.000Z');
    assert.equal(updated.failureCount, 2);
    assert.equal(updated.status, 'queued');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('riconcilia all avvio le copertine già soddisfatte senza rigenerarle', async () => {
  const root = tempRoot();
  try {
    const articleId = 'already-satisfied';
    const imageUrl = `/images/blog/${articleImageAssetId(articleId)}.webp`;
    const bytes = Buffer.from('already-satisfied-cover');
    const record = generatedRecord(root, articleId, imageUrl, bytes);
    write(root, 'content/blog-articles-data.ts', registryEntry(articleId, imageUrl));
    write(root, 'content/seo/seo-blog-5.ts', seoFile([seoEntry(articleId, imageUrl)]));
    write(root, 'data/generated-image-registry.json', JSON.stringify({ schema: 1, assetCount: 1, assets: [record] }));
    write(root, `public${imageUrl}`, bytes);
    write(root, `public/images/blog/thumbnails/${articleImageAssetId(articleId)}-480w.webp`, validThumbnailBytes());
    queue(root, [{ ...item(articleId, '2026-10-07T09:00:00.000Z'), status: 'failed', failureCount: 3 }]);

    let calls = 0;
    const summary = await drain({
      root,
      limit: 1,
      generateCover: async () => {
        calls += 1;
        throw new Error('must not regenerate');
      },
      generateThumbnail: async () => { throw new Error('must not create a thumbnail'); },
    });

    assert.equal(calls, 0);
    assert.equal(summary.drained, 0);
    assert.equal(summary.alreadySatisfied, 1);
    assert.deepEqual(summary.alreadySatisfiedIds, [articleId]);
    assert.equal(summary.residual, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8')).items.length, 0);
    assert.match(fs.readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf8'), /article-already-satisfied\.webp/);
    assert.match(fs.readFileSync(path.join(root, 'content/seo/seo-blog-5.ts'), 'utf8'), /article-already-satisfied\.webp/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una copertina con thumbnail mancante o invalido viene riparata prima di togliere la coda', async () => {
  for (const thumbnailState of ['missing', 'invalid', 'truncated']) {
    const root = tempRoot();
    try {
      const articleId = `partial-thumbnail-${thumbnailState}`;
      const imageUrl = `/images/blog/${articleImageAssetId(articleId)}.webp`;
      const bytes = Buffer.from(`partial-cover:${thumbnailState}`);
      const record = generatedRecord(root, articleId, imageUrl, bytes);
      write(root, 'content/blog-articles-data.ts', registryEntry(articleId, imageUrl));
      write(root, 'content/seo/seo-blog-5.ts', seoFile([seoEntry(articleId, imageUrl)]));
      write(root, 'data/generated-image-registry.json', JSON.stringify({ schema: 1, assetCount: 1, assets: [record] }));
      write(root, `public${imageUrl}`, bytes);
      if (thumbnailState === 'invalid') {
        write(root, `public/images/blog/thumbnails/${articleImageAssetId(articleId)}-480w.webp`, 'not a webp');
      }
      if (thumbnailState === 'truncated') {
        write(root, `public/images/blog/thumbnails/${articleImageAssetId(articleId)}-480w.webp`, validThumbnailBytes().subarray(0, 30));
      }
      queue(root, [item(articleId, '2026-10-07T09:00:00.000Z')]);

      let thumbnailCalls = 0;
      const summary = await drain({
        root,
        limit: 1,
        generateCover: async () => { throw new Error('must reuse the materialized record'); },
        generateThumbnail: async (sourcePath) => {
          thumbnailCalls += 1;
          return fakeThumbnail(sourcePath);
        },
      });

      assert.equal(summary.alreadySatisfied, 0, `${thumbnailState}: non va scartata come già soddisfatta`);
      assert.equal(summary.reused, 1, `${thumbnailState}: il record hero deve essere riusato`);
      assert.equal(thumbnailCalls, 1, `${thumbnailState}: il thumbnail deve essere rigenerato`);
      assert.equal(summary.residual, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8')).items, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('un rifiuto visivo per testo o cartelli rafforza il prompt del ritentativo', () => {
  assert.equal(isVisualTextFailure('vision gate rejected image: visible lettering and signage'), true);
  assert.equal(isVisualTextFailure('vision gate rejected image: words and numbers in the scene'), true);
  assert.equal(isVisualTextFailure('vision gate rejected image: forbidden content'), true);
  assert.equal(isVisualTextFailure('vision gate rejected image: recognizable face'), false);
  assert.equal(isVisualTextFailure('provider unavailable'), false);
  assert.match(NO_TEXT_IMAGE_RETRY_HINT, /no signs/);
  assert.match(NO_TEXT_IMAGE_RETRY_HINT, /lettering/);
});

test('non ritenta le voci failed in schedule e le riapre solo con retry esplicito', async () => {
  const root = tempRoot();
  try {
    const articleId = 'already-failed';
    write(root, 'content/blog-articles-data.ts', registryEntry(articleId, '/images/places/fallback.webp'));
    fixture(root, [{
      ...item(articleId, '2026-10-07T09:00:00.000Z'),
      status: 'failed',
      failureCount: 3,
      reason: 'provider unavailable',
    }]);

    let calls = 0;
    const skipped = await drain({
      root,
      limit: 1,
      generateCover: async (...args) => {
        calls += 1;
        return fakeCover(root)(...args);
      },
      generateThumbnail: fakeThumbnail,
    });
    assert.equal(skipped.drained, 0);
    assert.equal(skipped.failed, 0);
    assert.equal(calls, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8')).items[0].failureCount, 3);

    const retried = await drain({
      root,
      limit: 1,
      retryFailed: true,
      generateCover: async (...args) => {
        calls += 1;
        return fakeCover(root)(...args);
      },
      generateThumbnail: fakeThumbnail,
    });
    assert.equal(retried.drained, 1);
    assert.deepEqual(retried.requeued, [articleId]);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8')).items.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un fallimento conserva articolo e coda, e il terzo tentativo resta marcato', async () => {
  const root = tempRoot();
  try {
    const originalImage = '/images/places/unchanged.webp';
    write(root, 'content/blog-articles-data.ts', registryEntry('will-fail', originalImage));
    fixture(root, [item('will-fail', '2026-10-07T09:00:00.000Z')]);
    let now = 0;
    const fail = async () => { throw new Error('provider unavailable'); };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const summary = await drain({
        root,
        limit: 1,
        generateCover: fail,
        generateThumbnail: fakeThumbnail,
        now: () => `2026-10-07T13:0${now++}:00.000Z`,
      });
      assert.equal(summary.failed, 1);
      assert.equal(summary.residual, 1);
      assert.equal(fs.readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf8').includes(originalImage), true);
    }

    const remaining = JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8'));
    assert.equal(remaining.items[0].failureCount, 3);
    assert.equal(remaining.items[0].status, 'failed');
    assert.equal(remaining.items[0].reason, 'provider unavailable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un errore dopo la generazione ripristina articolo, registro e file prima di lasciare la voce in coda', async () => {
  const root = tempRoot();
  try {
    const originalImage = '/images/places/unchanged.webp';
    const articleId = 'thumbnail-fails';
    write(root, 'content/blog-articles-data.ts', registryEntry(articleId, originalImage));
    fixture(root, [item(articleId, '2026-10-07T09:00:00.000Z')]);

    const summary = await drain({
      root,
      limit: 1,
      generateCover: fakeCover(root),
      generateThumbnail: async () => { throw new Error('thumbnail unavailable'); },
    });

    assert.equal(summary.failed, 1);
    assert.equal(summary.residual, 1);
    assert.equal(fs.readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf8').includes(originalImage), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/generated-image-registry.json'), 'utf8')).assets.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'public/images/blog/article-thumbnail-fails.webp')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8')).items[0].failureCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un errore nella persistenza della rimozione ripristina la transazione prima del fallimento', async () => {
  const root = tempRoot();
  try {
    const articleId = 'queue-write-fails';
    const originalImage = '/images/places/unchanged.webp';
    write(root, 'content/blog-articles-data.ts', registryEntry(articleId, originalImage));
    fixture(root, [item(articleId, '2026-10-07T09:00:00.000Z')]);
    const queuePath = path.join(root, 'data/image-regeneration-queue.json');

    await assert.rejects(
      () => drain({
        root,
        limit: 1,
        generateCover: fakeCover(root),
        generateThumbnail: async (sourcePath, options) => {
          const thumbnail = await fakeThumbnail(sourcePath, options);
          fs.rmSync(queuePath);
          fs.mkdirSync(queuePath, { recursive: true });
          return thumbnail;
        },
      }),
      /EISDIR|ENOTDIR|directory/i,
    );

    assert.equal(fs.readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf8').includes(originalImage), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/generated-image-registry.json'), 'utf8')).assets.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'data/image-regeneration-publish-outbox.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'public/images/blog/article-queue-write-fails.webp')), false);
    assert.equal(fs.existsSync(path.join(root, 'public/images/blog/thumbnails/article-queue-write-fails-480w.webp')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un record già materializzato rende il drain riprendibile senza una seconda generazione', async () => {
  const root = tempRoot();
  try {
    const articleId = 'already-generated';
    const imageUrl = `/images/blog/${articleImageAssetId(articleId)}.webp`;
    const bytes = Buffer.from('already-generated-cover');
    const record = generatedRecord(root, articleId, imageUrl, bytes);
    write(root, 'content/blog-articles-data.ts', registryEntry(articleId, '/images/places/fallback.webp'));
    write(root, 'data/generated-image-registry.json', JSON.stringify({ schema: 1, assetCount: 1, assets: [record] }));
    write(root, `public${imageUrl}`, bytes);
    write(root, `public/images/blog/thumbnails/${articleImageAssetId(articleId)}-480w.webp`, validThumbnailBytes());
    queue(root, [item(articleId, '2026-10-07T09:00:00.000Z')]);
    write(root, 'content/seo/seo-blog-5.ts', seoFile([seoEntry(articleId)]));

    const summary = await drain({
      root,
      limit: 1,
      generateCover: async () => { throw new Error('must not regenerate'); },
      generateThumbnail: async () => { throw new Error('thumbnail already exists'); },
    });

    assert.equal(summary.drained, 1);
    assert.equal(summary.reused, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8')).items.length, 0);
    assert.match(fs.readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf8'), /article-already-generated\.webp/);
    assert.match(fs.readFileSync(path.join(root, 'content/seo/seo-blog-5.ts'), 'utf8'), /article-already-generated\.webp/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il merge del registro applica solo il delta locale e conserva metadata upstream piu recenti', () => {
  const upstream = {
    schema: 1,
    assets: [
      { assetId: 'lugano-view', version: 'upstream' },
      { assetId: 'article-old', version: 'upstream' },
    ],
  };
  const base = {
    schema: 1,
    assets: [{ assetId: 'article-old', version: 'base' }],
  };
  const replayed = {
    schema: 1,
    assets: [
      { assetId: 'article-new', version: 'local' },
      { assetId: 'article-old', version: 'base' },
    ],
  };
  const merged = mergeImageRegistryDelta(upstream, base, replayed);
  assert.deepEqual(merged.assets.map((record) => record.assetId), ['lugano-view', 'article-old', 'article-new']);
  assert.equal(merged.assets[1].version, 'upstream');
  assert.equal(merged.assetCount, 3);
});

function workflowConcurrencyGroups(source) {
  const lines = source.split('\n');
  const groups = [];

  for (let index = 0; index < lines.length; index += 1) {
    const concurrency = /^(\s*)concurrency:\s*$/.exec(lines[index]);
    if (!concurrency) continue;

    const baseIndent = concurrency[1].length;
    let job = null;
    if (baseIndent > 0) {
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const candidate = /^( {2})([A-Za-z0-9_-]+):\s*$/.exec(lines[previous]);
        if (candidate) {
          job = candidate[2];
          break;
        }
      }
    }

    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].trim() === '') continue;
      const indent = lines[next].match(/^\s*/u)[0].length;
      if (indent <= baseIndent) break;
      const group = new RegExp(`^ {${baseIndent + 2}}group:\\s*(.+)$`).exec(lines[next]);
      if (group) {
        groups.push({job, value: group[1].trim(), line: next + 1});
        break;
      }
    }
  }

  return groups;
}

test('il gruppo generate-article resta confinato ai writer ammessi e il drain ha una corsia propria', () => {
  const workflowsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');
  const workflowSources = [
    ['generate-article.yml', 'generate-article.yml'],
    ['generate-article-core.yml', 'generate-article-core.yml'],
    ['publish-journalist-articles.yml', 'publish-journalist-articles.yml'],
    ['regenerate-queued-covers.yml', 'regenerate-queued-covers.yml'],
  ];
  const declarations = [];

  for (const [filename, workflowFile] of workflowSources) {
    const source = fs.readFileSync(path.join(workflowsDir, workflowFile), 'utf8');
    for (const group of workflowConcurrencyGroups(source)) {
      declarations.push({filename, ...group});
    }
  }

  const generateArticle = declarations.filter(({value}) => value.includes('generate-article'));
  const unexpected = generateArticle.filter(({filename, job, value}) => !(
    (filename === 'generate-article.yml' && job === 'generate' && value.includes('generate-article'))
    || (filename === 'publish-journalist-articles.yml' && job === null && value === 'generate-article')
  ));
  assert.deepEqual(unexpected, []);
  assert.ok(generateArticle.some(({filename, job}) => filename === 'generate-article.yml' && job === 'generate'));
  assert.ok(generateArticle.some(({filename, job}) => filename === 'publish-journalist-articles.yml' && job === null));

  const drain = declarations.find(({filename, value}) => (
    filename === 'regenerate-queued-covers.yml' && value === 'regenerate-queued-covers'
  ));
  assert.ok(drain);
  assert.equal(
    fs.readFileSync(path.join(workflowsDir, 'regenerate-queued-covers.yml'), 'utf8')
      .match(/cancel-in-progress:\s*false/gu)?.length,
    1,
  );
});

test('i writer concorrenti non possono riscrivere un articolo gia\' registrato', () => {
  const createArticle = fs.readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
  const registerStart = createArticle.indexOf('export async function registerArticleFiles');
  const registerEnd = createArticle.indexOf('\nexport function checkArticleIdExists', registerStart);
  assert.ok(registerStart >= 0 && registerEnd > registerStart);
  const registerBody = createArticle.slice(registerStart, registerEnd);
  assert.match(registerBody, /resolveRegisterLockAtStartup\(\);[\s\S]*if \(checkArticleIdExists\(data\.id\)\)/);

  const journalist = fs.readFileSync(new URL('../scripts/publish-journalist-article.mjs', import.meta.url), 'utf8');
  const processStart = journalist.indexOf('async function processDoc(');
  const processEnd = journalist.indexOf('\nasync function ', processStart + 1);
  assert.ok(processStart >= 0 && processEnd > processStart);
  const processBody = journalist.slice(processStart, processEnd);
  const duplicateGuard = processBody.indexOf('checkArticleIdExists(data.id)');
  const coverResolution = processBody.indexOf('resolveHeroImage(data, doc)');
  assert.ok(duplicateGuard >= 0 && duplicateGuard < coverResolution,
    'il publisher deve rifiutare l id gia registrato prima di poter scegliere o scrivere una copertina');
});

test('il merge del registro fa vincere una rigenerazione locale realmente cambiata', () => {
  const upstream = { schema: 1, assets: [{ assetId: 'article-old', version: 'upstream' }] };
  const base = { schema: 1, assets: [{ assetId: 'article-old', version: 'base' }] };
  const replayed = { schema: 1, assets: [{ assetId: 'article-old', version: 'local' }] };
  const merged = mergeImageRegistryDelta(upstream, base, replayed);
  assert.equal(merged.assets[0].version, 'local');
});

test('il registro editoriale usa cover come identita append-only', () => {
  const upstream = { schema: 1, assets: [{ cover: '/images/blog/a.webp', version: 'upstream' }] };
  const base = { schema: 1, assets: [{ cover: '/images/blog/a.webp', version: 'base' }] };
  const replayed = { schema: 1, assets: [
    { cover: '/images/blog/a.webp', version: 'base' },
    { cover: '/images/blog/b.webp', version: 'local' },
  ] };
  const merged = mergeImageRegistryDelta(upstream, base, replayed, { key: 'cover' });
  assert.deepEqual(merged.assets, [
    { cover: '/images/blog/a.webp', version: 'upstream' },
    { cover: '/images/blog/b.webp', version: 'local' },
  ]);
});

test('il drain verifica il residuo rebased senza confondere le aggiunte upstream con perdite', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/regenerate-queued-covers.yml', import.meta.url), 'utf8');
  assert.match(workflow, /registry_base="\$RUNNER_TEMP\/generated-image-registry-base\.json"/);
  assert.match(workflow, /git show "\$PRODUCED\^:data\/generated-image-registry\.json" > "\$registry_base"/);
  assert.match(
    workflow,
    /node scripts\/ci\/merge-generated-image-registry\.mjs \\\n\s+data\/generated-image-registry\.json "\$registry_base" "\$registry_snapshot"/,
  );
  assert.match(
    workflow,
    /if \[ "\$\(git rev-parse HEAD\)" = "\$\(git rev-parse FETCH_HEAD\)" \]; then\s+git commit -C "\$PRODUCED"\s+else\s+git commit --amend --no-edit/,
  );
  assert.match(workflow, /verify_pushed_queue\(\)/);
  assert.match(workflow, /snapshot_expected_queue\(\)/);
  assert.match(workflow, /\.residualDrainer = \.residual/);
  assert.match(workflow, /\.residualExpected = \$expected/);
  assert.match(workflow, /queue_file=data\/image-regeneration-queue\.json/);
  assert.match(workflow, /--merge-queue "\$queue_file"/);
  assert.match(workflow, /if \[ -e "\$queue_file" \]; then\s+cp "\$queue_file" "\$expected_queue"\s+else\s+printf '%s\\n' '\{"schema":1,"items":\[\]\}' > "\$expected_queue"/);
  assert.match(workflow, /if git cat-file -e "HEAD:\$queue_file" 2>\/dev\/null; then\s+pushed_queue="\$\(git show "HEAD:\$queue_file"\)"\s+else\s+pushed_queue='\{"schema":1,"items":\[\]\}'/);
  assert.match(workflow, /queued-cover-expected-queue\.json/);
  assert.match(workflow, /\.residualMissing = \$missing/);
  assert.match(workflow, /\.residualSource = "pushed-branch"/);
  assert.match(workflow, /\[\.items\[\] \| \.articleId \| tostring\] \| unique \| length/);
  assert.match(workflow, /queued-cover queue count diverged after push/);
  assert.match(workflow, /if \[ "\$actual" -ne "\$internal" \]/);
  assert.match(workflow, /queued-cover queue items lost after push/);
});

test('il workflow pubblica in parallelo, ha una scadenza interna e acka per sezione', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/regenerate-queued-covers.yml', import.meta.url), 'utf8');
  const clock = workflow.indexOf('name: Start cover drain clock before checkout');
  const checkout = workflow.indexOf('name: Checkout');
  const preDispatch = workflow.indexOf('name: Dispatch pending cover publishers before generation');
  const drain = workflow.indexOf('name: Drain queued covers');
  const dispatch = workflow.indexOf('name: Dispatch and complete pending cover publishers');
  const acknowledge = workflow.indexOf('name: Acknowledge cover publisher outbox');
  assert.ok(clock >= 0);
  assert.ok(checkout > clock);
  assert.ok(preDispatch >= 0);
  assert.ok(drain > preDispatch);
  assert.ok(dispatch > drain);
  assert.ok(acknowledge > dispatch);
  assert.match(workflow, /cover-publisher-drain\.mjs[\s\S]*--mode run/u);
  assert.match(workflow, /cover-publisher-drain\.mjs[\s\S]*--mode ack/u);
  assert.doesNotMatch(workflow, /gh run watch/u);
  assert.match(workflow, /queued-cover-deadline-ms/);
  assert.match(workflow, /queued-cover-job-start-ms/);
  assert.match(workflow, /deadline_ms=\$\(\(job_started_ms \+ 40 \* 60 \* 1000\)\)/);
  assert.match(workflow, /40m internal deadline/);
  assert.match(workflow, /publisher_reserve_ms=\$\(\(15 \* 60 \* 1000\)\)/);
  assert.match(workflow, /skippedBeforeDrain:true/);
  assert.match(workflow, /steps\.budget\.outputs\.initial_outbox/);
  assert.match(workflow, /steps\.pre_ack\.outputs\.outbox_pending/);
  assert.match(workflow, /if: \$\{\{ always\(\) && steps\.push\.outputs\.publish_ready == 'true'/);
  assert.match(workflow, /git add -A -- "\$OUTBOX_FILE"/);
  assert.match(workflow, /if: steps\.drain\.outcome == 'success'/);
  assert.match(workflow, /publisher_complete='true'/);
  assert.match(workflow, /publishers are incomplete/);
  assert.doesNotMatch(workflow, /git rm -f "\$OUTBOX_FILE"/);
  assert.match(workflow, /registry_base=\"\$RUNNER_TEMP\/generated-image-registry-base\.json\"/);
  assert.match(workflow, /merge-generated-image-registry\.mjs[\s\S]*data\/generated-image-registry\.json \"\$registry_base\" \"\$registry_snapshot\"/);

  const publisherWorkflows = [
    '../../.github/workflows/fast-publish-article.yml',
    '../../.github/workflows/fast-publish-section.yml',
  ];
  for (const publisherWorkflow of publisherWorkflows) {
    const publisher = fs.readFileSync(new URL(publisherWorkflow, import.meta.url), 'utf8');
    assert.match(publisher, /dispatch_nonce:/u);
    assert.match(publisher, /run-name:[^\n]*nonce=\$\{\{ inputs\.dispatch_nonce \|\| 'none' \}\}/u);
  }

  const articlePublisher = fs.readFileSync(new URL('../../.github/workflows/fast-publish-article.yml', import.meta.url), 'utf8');
  assert.match(articlePublisher, /publisher omitted requested article IDs/u);

  const drainScript = fs.readFileSync(new URL('../../scripts/ci/cover-publisher-drain.mjs', import.meta.url), 'utf8');
  assert.match(drainScript, /displayTitle/u);
  assert.match(drainScript, /nonce=\$\{dispatchNonce\}/u);
  assert.match(drainScript, /process\.exitCode = 1/u);
});
