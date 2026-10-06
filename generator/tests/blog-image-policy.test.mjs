import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BLOG_IMAGE_TARGET_MAX_BYTES,
  BLOG_IMAGE_HARD_MAX_BYTES,
  BLOG_IMAGE_WIDTH,
  BLOG_IMAGE_HEIGHT,
  BLOG_IMAGE_QUALITY_PASSES,
} from '../scripts/lib/blog-image-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('article hero policy stays below the SEO image-size threshold', () => {
  assert.ok(BLOG_IMAGE_TARGET_MAX_BYTES < 200 * 1024);
  assert.ok(BLOG_IMAGE_HARD_MAX_BYTES > BLOG_IMAGE_TARGET_MAX_BYTES);
  assert.deepEqual([BLOG_IMAGE_WIDTH, BLOG_IMAGE_HEIGHT], [1200, 675]);
  assert.equal(BLOG_IMAGE_QUALITY_PASSES[0], 75);
  assert.equal(BLOG_IMAGE_QUALITY_PASSES.at(-1), 20);
  assert.ok(BLOG_IMAGE_QUALITY_PASSES.every((quality, i, all) => i === 0 || quality < all[i - 1]));
});



test('all hero producers consume the shared byte and dimension policy', () => {
  const createArticle = readFileSync(path.join(HERE, '../scripts/create-article.mjs'), 'utf8');
  const journalistPublisher = readFileSync(path.join(HERE, '../scripts/publish-journalist-article.mjs'), 'utf8');
  const dailyBriefImage = readFileSync(path.join(HERE, '../scripts/lib/daily-brief-image.mjs'), 'utf8');
  const maintenanceScript = readFileSync(path.join(HERE, '../scripts/optimize-blog-images.mjs'), 'utf8');
  assert.match(createArticle, /BLOG_IMAGE_QUALITY_PASSES/);
  assert.match(createArticle, /BLOG_IMAGE_TARGET_MAX_BYTES/);
  assert.match(journalistPublisher, /BLOG_IMAGE_QUALITY_PASSES/);
  assert.match(journalistPublisher, /BLOG_IMAGE_TARGET_MAX_BYTES/);
  assert.match(journalistPublisher, /if \(destPath\) fs\.rmSync\(destPath, \{ force: true \}\)/);
  assert.match(dailyBriefImage, /BLOG_IMAGE_QUALITY_PASSES/);
  assert.match(dailyBriefImage, /BLOG_IMAGE_TARGET_MAX_BYTES/);
  assert.match(dailyBriefImage, /BLOG_IMAGE_HARD_MAX_BYTES/);
  assert.match(maintenanceScript, /BLOG_IMAGE_WIDTH/);
  assert.match(maintenanceScript, /BLOG_IMAGE_HEIGHT/);
  assert.match(maintenanceScript, /metadata\(\)/);
  assert.match(maintenanceScript, /sourceGeometryOk/);
});
