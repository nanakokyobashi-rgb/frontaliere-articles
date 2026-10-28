import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_UPLOAD_CONCURRENCY,
  MAX_UPLOAD_CONCURRENCY,
  resolveUploadConcurrency,
  runUploadPool,
  uploadEntriesFromSummary,
} from '../../scripts/ci/upload-cdn-batch.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/fast-publish-article.yml', import.meta.url), 'utf8');
const batch = readFileSync(new URL('../../scripts/ci/upload-cdn-batch.mjs', import.meta.url), 'utf8');

test('the fast publisher uses one bounded CDN batch uploader', () => {
  assert.match(workflow, /scripts\/ci\/upload-cdn-batch\.mjs "\$summary"/u);
  assert.doesNotMatch(workflow, /while IFS=.*cdnUploads/u);
  assert.match(workflow, /scripts\/ci\/upload-cdn-batch\.mjs/u);
  assert.match(batch, /IMAGE_LEASE_CONTEXT_ENV/u);
  assert.match(batch, /r2-image-namespace-lock\.mjs/u);
  assert.ok(DEFAULT_UPLOAD_CONCURRENCY > 1);
  assert.ok(DEFAULT_UPLOAD_CONCURRENCY <= MAX_UPLOAD_CONCURRENCY);
});

test('upload concurrency accepts only a bounded positive integer', () => {
  assert.equal(resolveUploadConcurrency(undefined), DEFAULT_UPLOAD_CONCURRENCY);
  assert.equal(resolveUploadConcurrency('2'), 2);
  assert.throws(() => resolveUploadConcurrency('0'), /positive integer/u);
  assert.throws(() => resolveUploadConcurrency(String(MAX_UPLOAD_CONCURRENCY + 1)), /no larger/u);
});

test('summary validation keeps local paths and CDN keys paired', () => {
  assert.deepEqual(
    uploadEntriesFromSummary({ cdnUploads: [{ local: 'public/a.webp', key: 'images/blog/a.webp' }] }),
    [{ local: 'public/a.webp', key: 'images/blog/a.webp' }],
  );
  assert.throws(() => uploadEntriesFromSummary({ cdnUploads: [{ local: 'public/a.webp', key: 'images/blog/a.webp\n' }] }), /without NUL\/newline/u);
});

test('the upload pool never exceeds its worker bound and drains every entry', async () => {
  const entries = Array.from({ length: 7 }, (_, index) => index);
  let active = 0;
  let peak = 0;
  const seen = [];
  const results = await runUploadPool(entries, 2, async (entry) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(entry);
    active -= 1;
    return { code: 0 };
  });
  assert.equal(peak, 2);
  assert.deepEqual(seen.sort((a, b) => a - b), entries);
  assert.equal(results.filter(Boolean).length, entries.length);
});
