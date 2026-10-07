import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchDeclaredImage, prepareImageView } from '../../scripts/lib/article-render-pipeline.mjs';

function response({ status = 200, type = 'image/webp', body = Buffer.from('image') } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === 'content-type' ? type : String(body.byteLength)) },
    arrayBuffer: async () => body,
  };
}

test('il fetch CDN richiede manual redirect e content-type image', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-image-download-'));
  try {
    await assert.rejects(
      fetchDeclaredImage({
        imagePath: '/images/places/redirect.webp',
        destination: path.join(root, 'redirect.webp'),
        fetchImpl: async (_url, options) => {
          assert.equal(options.redirect, 'manual');
          return response({ status: 302, type: 'text/html' });
        },
      }),
      /HTTP 302/,
    );
    await assert.rejects(
      fetchDeclaredImage({
        imagePath: '/images/places/html.webp',
        destination: path.join(root, 'html.webp'),
        fetchImpl: async () => response({ type: 'text/html' }),
      }),
      /content-type non immagine/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('il renderer scarica al massimo quattro immagini dichiarate in parallelo', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-image-view-root-'));
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-image-view-dist-'));
  let active = 0;
  let maxActive = 0;
  try {
    const ids = Array.from({ length: 6 }, (_, index) => `article-${index}`);
    const declaredImages = Object.fromEntries(ids.map((id) => [id, `/images/places/${id}.webp`]));
    const result = await prepareImageView({
      rootDir,
      distDir,
      ids,
      declaredImages,
      logPrefix: 'test',
      fetchImpl: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return response();
      },
    });
    assert.ok(maxActive <= 4);
    assert.equal(result.failures.length, 0);
    assert.equal(result.downloadedImageKeys.length, ids.length);
    for (const id of ids) assert.equal(fs.existsSync(path.join(result.viewDir, 'places', `${id}.webp`)), true);
    fs.rmSync(result.viewDir, { recursive: true, force: true });
    fs.rmSync(result.downloadDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});
