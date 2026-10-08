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
  return Buffer.from(
    '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',
    'base64',
  );
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
    const summary = await drainQueuedCovers({
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

    const second = await drainQueuedCovers({
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
    const summary = await drainQueuedCovers({
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
    const summary = await drainQueuedCovers({
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

test('una copertina con thumbnail mancante, invalido o troncato viene riparata prima di togliere la coda', async () => {
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
        write(
          root,
          `public/images/blog/thumbnails/${articleImageAssetId(articleId)}-480w.webp`,
          validThumbnailBytes().subarray(0, 30),
        );
      }
      queue(root, [item(articleId, '2026-10-07T09:00:00.000Z')]);

      let thumbnailCalls = 0;
      const summary = await drainQueuedCovers({
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
    const skipped = await drainQueuedCovers({
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

    const retried = await drainQueuedCovers({
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
      const summary = await drainQueuedCovers({
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

    const summary = await drainQueuedCovers({
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
      () => drainQueuedCovers({
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

    const summary = await drainQueuedCovers({
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
  assert.match(workflow, /queued-cover queue count diverged after push/);
  assert.match(workflow, /if \[ "\$actual" -ne "\$internal" \]/);
  assert.match(workflow, /queued-cover queue items lost after push/);
});

test('il workflow attende la completion del publisher prima di ackare l outbox', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/regenerate-queued-covers.yml', import.meta.url), 'utf8');
  const dispatch = workflow.indexOf('gh workflow run');
  const completion = workflow.indexOf('gh run watch "$run_id" --repo "$REPO" --exit-status');
  const acknowledge = workflow.indexOf('name: Acknowledge cover publisher outbox');
  assert.ok(dispatch >= 0);
  assert.ok(completion > dispatch);
  assert.ok(acknowledge > completion);
  assert.match(workflow, /if: steps\.drain\.outcome == 'success'/);
  assert.doesNotMatch(workflow.slice(dispatch, acknowledge), /git rm -f/);
  assert.match(workflow, /registry_base=\"\$RUNNER_TEMP\/generated-image-registry-base\.json\"/);
  assert.match(workflow, /merge-generated-image-registry\.mjs[\s\S]*data\/generated-image-registry\.json \"\$registry_base\" \"\$registry_snapshot\"/);
});
