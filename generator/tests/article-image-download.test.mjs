import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregatePageVerdict,
  CDN_BASE,
  fetchDeclaredImage,
  prepareImageView,
  readDeclaredImages,
  registryPathForSection,
  rewriteDownloadedImageFiles,
  rewriteDownloadedImageRefs,
} from '../../scripts/lib/article-render-pipeline.mjs';

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

test('le sole immagini scaricate vengono riscritte sul CDN senza duplicare URL CDN', () => {
  const html = [
    '<meta property="og:image" content="https://frontaliereticino.ch/images/places/recovered.webp">',
    '<img src="/images/places/recovered.webp?v=2">',
    '<img src="https://cdn.frontaliereticino.ch/images/places/recovered.webp">',
    '<img src="https://raw.githubusercontent.com/example/repo/main/public/images/places/recovered.webp">',
    '<img src="/images/places/local.webp">',
  ].join('\n');

  const rewritten = rewriteDownloadedImageRefs(html, ['images/places/recovered.webp']);

  assert.equal((rewritten.match(new RegExp(`${CDN_BASE}/images/places/recovered\\.webp`, 'g')) ?? []).length, 3);
  assert.equal(rewritten.includes(`${CDN_BASE}${CDN_BASE}`), false);
  assert.match(rewritten, /raw\.githubusercontent\.com\/example\/repo\/main\/public\/images\/places\/recovered\.webp/);
  assert.match(rewritten, /src="\/images\/places\/local\.webp"/);
  assert.match(rewritten, /recovered\.webp\?v=2/);
});

test('le immagini scaricate vengono riscritte anche in ogni pagina aggregata prodotta prima dell’offload', () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-image-aggregates-'));
  try {
    const landing = 'articoli-ticino/index.html';
    const hub = 'articoli-ticino/lavoro/index.html';
    const untouched = 'articoli-ticino/non-pubblicata/index.html';
    for (const rel of [landing, hub, untouched]) {
      fs.mkdirSync(path.join(distDir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(distDir, rel), '<img src="/images/places/recovered.webp">');
    }

    rewriteDownloadedImageFiles({
      distDir,
      relPaths: [landing, hub],
      downloadedImageKeys: ['images/places/recovered.webp'],
    });

    for (const rel of [landing, hub]) {
      assert.equal(fs.readFileSync(path.join(distDir, rel), 'utf8'), `<img src="${CDN_BASE}/images/places/recovered.webp">`);
    }
    assert.equal(fs.readFileSync(path.join(distDir, untouched), 'utf8'), '<img src="/images/places/recovered.webp">');
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

test('un articolo rilasciato col fallback resta fuori dagli aggregati finché l’immagine non è disponibile', () => {
  const online = [{ articleId: 'online', online: [{ state: 'own' }] }];
  assert.equal(aggregatePageVerdict({ excludedArticles: online, releasedArticles: [] }).allowed, true);
  assert.equal(
    aggregatePageVerdict({ excludedArticles: online, releasedArticles: [{ articleId: 'fallback' }] }).allowed,
    false,
  );
  assert.equal(
    aggregatePageVerdict({ excludedArticles: [{ articleId: 'missing', online: [{ state: 'absent' }] }], releasedArticles: [] }).allowed,
    false,
  );
});

test('il registro immagini viene dal profilo della sezione e manca fail-closed', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-image-registry-'));
  try {
    assert.equal(
      registryPathForSection(rootDir, 'frontaliere'),
      path.join(rootDir, 'content', 'blog-articles-data.ts'),
    );
    assert.equal(
      registryPathForSection(rootDir, 'canton-ti'),
      path.join(rootDir, 'content', 'cantons', 'canton-ti', 'registry.ts'),
    );
    await assert.rejects(
      readDeclaredImages(rootDir, 'canton-ti', ['missing']),
      /registro immagini dichiarate non leggibile per "canton-ti"/,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('IL CASO canton-sh: una sezione senza registro e senza id non legge niente e non fallisce', async () => {
  // Run 37691307907, primo giro cantonale dopo la PR 2425: 23 sezioni su 24
  // pubblicate, canton-sh ferma su «registro immagini dichiarate non leggibile».
  // La sezione ha solo hubs/: nessun articolo, quindi nessun registry.ts.
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-image-registry-'));
  try {
    fs.mkdirSync(path.join(rootDir, 'content', 'cantons', 'canton-sh', 'hubs'), { recursive: true });
    assert.deepEqual(await readDeclaredImages(rootDir, 'canton-sh', []), {});
    // Con un id richiesto il registro serve davvero: la sua assenza resta un errore.
    await assert.rejects(
      readDeclaredImages(rootDir, 'canton-sh', ['un-articolo']),
      /registro immagini dichiarate non leggibile per "canton-sh"/,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('il renderer scarica al massimo quattro immagini dichiarate in parallelo', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-image-view-root-'));
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-image-view-dist-'));
  let active = 0;
  let maxActive = 0;
  const logs = [];
  try {
    const ids = Array.from({ length: 6 }, (_, index) => `article-${index}`);
    const declaredImages = Object.fromEntries(ids.map((id) => [id, `/images/places/${id}.webp`]));
    const result = await prepareImageView({
      rootDir,
      distDir,
      ids,
      declaredImages,
      logPrefix: 'test',
      logger: {
        log: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
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
    assert.equal(logs.length, ids.length);
    assert.ok(logs.every((message) => message.startsWith('[test] downloaded declared image from CDN:')));
    for (const id of ids) assert.equal(fs.existsSync(path.join(result.viewDir, 'places', `${id}.webp`)), true);
    fs.rmSync(result.viewDir, { recursive: true, force: true });
    fs.rmSync(result.downloadDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});
