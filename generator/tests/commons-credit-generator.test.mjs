/**
 * commons-credit-generator.test.mjs — the generator's half of P14: a Commons
 * cover is picked with its credit, the record is written next to it, and the
 * SEO literal of a credited cover no longer claims the photo for the site.
 * Run with `node --test`.
 *
 * `create-article.mjs` and `publish-journalist-article.mjs` cannot be imported
 * here (jsdom, firebase-admin: this suite runs with no `npm ci`), so — as in
 * `structured-data-creator-type.test.mjs` — the REAL source of each function is
 * sliced out and evaluated with its collaborators injected. The slice markers
 * are asserted, so a refactor that moves them fails here instead of testing
 * nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as credit from '../scripts/lib/commons-credit.mjs';
import { findSeoEntryMatches } from '../../engine/shared/seo-entry.mjs';
import { escapeForSingleQuoteTS } from '../scripts/lib/article-meta-block.mjs';

const CREATE = fs.readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf-8');
const JOURNALIST = fs.readFileSync(new URL('../scripts/publish-journalist-article.mjs', import.meta.url), 'utf-8');
const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('./fixtures/commons-credit/probe-2026-10-04.snapshot.json', import.meta.url), 'utf-8'));

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `marker not found after the start: ${endMarker}`);
  return src.slice(start, end);
}

/** The API's formatversion=1 search page for a fixture file, as Strategy 4 receives it. */
function searchPage(title, { mime = 'image/jpeg' } = {}) {
  const f = SNAPSHOT.files[title];
  const extmetadata = Object.fromEntries(Object.entries(f.meta).map(([k, v]) => [k, { value: v }]));
  return {
    pageid: f.pageId,
    title: `File:${title}`,
    imageinfo: [{
      timestamp: f.revision, width: f.width, height: f.height, descriptionurl: f.pageUrl, mime,
      url: `https://upload.wikimedia.org/wikipedia/commons/x/xy/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/x/xy/${encodeURIComponent(title.replace(/ /g, '_'))}/1280px-x.jpg`,
      extmetadata,
    }],
  };
}

function webpHeader(width, height) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-gen-'));
  fs.mkdirSync(path.join(root, 'public', 'images', 'blog'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return root;
}

const quiet = { error() {}, warn() {}, log() {} };

// ── Strategy 4 ─────────────────────────────────────────────────────────────

const STRATEGY_4 = slice(CREATE, '  // ── Strategy 4: Wikimedia Commons', '  // ── Strategy 5: Pixabay');

/**
 * Runs the real Strategy 4 block against a fake Commons search (one response
 * per query) and a fake optimizer that writes a 1200×675 WebP header.
 */
async function runStrategy4({ root, responses, failRecord = false, failUsed = false }) {
  const calls = { search: [], download: [], used: [], catalog: [], saveOptions: [] };
  const data = { id: 'nuovo-articolo' };
  const imgPath = path.join(root, 'public', 'images', 'blog', `${data.id}.webp`);
  const queries = Object.keys(responses);
  const fetch = async (url) => {
    if (url.startsWith('https://commons.wikimedia.org/w/api.php')) {
      calls.search.push(url);
      const query = new URL(url).searchParams.get('gsrsearch');
      return { ok: true, json: async () => ({ query: { pages: Object.fromEntries(responses[query].map((p) => [p.pageid, p])) } }) };
    }
    calls.download.push(url);
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const block = new Function(
    'data', 'imgPath', 'PROJECT_ROOT', 'fetch', 'console', 'Math', 'imagePhaseExpired', '_buildWikimediaQueries',
    '_saveAndOptimize', '_saveUsedImageUrl', 'appendCatalogEntry', 'readFileSync', 'existsSync', 'unlinkSync',
    'COMMONS_IMAGEINFO_PARAMS', 'chooseCommonsCredit', 'creditRecordForCover', 'loadCommonsUsage', 'readCommonsPage',
    'utcDate', 'webpDimensions', 'writeCreditRecord',
    `return (async () => {\n${STRATEGY_4}\nreturn null;\n})();`,
  );
  const result = await block(
    data, imgPath, root, fetch, quiet, { floor: Math.floor, min: Math.min, random: () => 0 }, () => false,
    () => queries,
    async (_buffer, _label, _type, options) => {
      calls.saveOptions.push(options);
      fs.writeFileSync(imgPath, webpHeader(1200, 675));
      return `/images/blog/${data.id}.webp`;
    },
    failUsed ? () => { throw new Error('EROFS'); } : (id, url) => calls.used.push([id, url]),
    (cover) => calls.catalog.push(cover),
    fs.readFileSync, fs.existsSync, fs.unlinkSync,
    credit.COMMONS_IMAGEINFO_PARAMS, credit.chooseCommonsCredit, credit.creditRecordForCover, credit.loadCommonsUsage,
    credit.readCommonsPage, () => '2026-10-04', credit.webpDimensions,
    failRecord ? () => { throw new Error('disk full'); } : credit.writeCreditRecord,
  );
  return { result, data, calls, imgPath };
}

test('Strategy 4 asks for the licence metadata in the search request it already makes', async () => {
  const root = tempRoot();
  try {
    const { calls } = await runStrategy4({ root, responses: { lugano: [searchPage('Locarno 1.jpg')] } });
    assert.equal(calls.search.length, 1, 'no extra request');
    const url = new URL(calls.search[0]);
    assert.equal(url.searchParams.get('generator'), 'search');
    assert.match(url.searchParams.get('iiprop'), /\bextmetadata\b/);
    assert.match(url.searchParams.get('iiprop'), /\btimestamp\b/);
    assert.match(url.searchParams.get('iiextmetadatafilter'), /Artist\|Attribution\|.*LicenseShortName/);
    assert.equal(url.searchParams.get('iiextmetadatalanguage'), 'en');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Strategy 4 writes the credit record of the chosen cover, then the usage map', async () => {
  const root = tempRoot();
  try {
    const { result, data, calls } = await runStrategy4({ root, responses: { lugano: [searchPage('Locarno 1.jpg')] } });
    assert.equal(result, '/images/blog/nuovo-articolo.webp');
    const record = JSON.parse(fs.readFileSync(path.join(root, 'content/image-credits/blog/nuovo-articolo.json'), 'utf-8'));
    assert.equal(record.cover, '/images/blog/nuovo-articolo.webp');
    assert.equal(record.commons.title, 'Locarno 1.jpg');
    assert.equal(record.author.name, 'Riessdo');
    assert.equal(record.modified, 'cropped', '2560×1920 cut to 1200×675');
    assert.equal(record.fetchedAt, '2026-10-04');
    assert.deepEqual(data._imageCredit, record);
    assert.equal(calls.used.length, 1, '_saveUsedImageUrl is kept');
    assert.deepEqual(calls.catalog, ['/images/blog/nuovo-articolo.webp'], 'cataloged once, after the credit is in place');
    assert.deepEqual(calls.saveOptions, [{ commons: true }], '_saveAndOptimize leaves the catalog to Strategy 4');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Strategy 4 undoes the whole install when the usage map cannot be written', async () => {
  const root = tempRoot();
  try {
    const { result, data, imgPath, calls } = await runStrategy4({ root, failUsed: true, responses: { lugano: [searchPage('Locarno 1.jpg')] } });
    assert.equal(result, null, 'the next strategy runs');
    assert.equal(fs.existsSync(path.join(root, 'content/image-credits/blog/nuovo-articolo.json')), false, 'no record left for a picture another strategy will write');
    assert.equal(fs.existsSync(imgPath), false, 'no Commons cover on disk');
    assert.equal(data._imageCredit, undefined, 'no credit in memory for the SEO literal');
    assert.deepEqual(calls.catalog, [], 'nothing cataloged for the journalist picker');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Strategy 4 never downloads a file it cannot credit', async () => {
  const root = tempRoot();
  try {
    const { result, calls } = await runStrategy4({
      root,
      responses: { festival: [searchPage('Patrol Police.jpg'), searchPage('EHIC Slovenia.jpg'), searchPage('Voting sign Switzerland (2024, cropped).jpg')] },
    });
    assert.equal(result, null);
    assert.deepEqual(calls.download, [], 'personality-restricted, GFDL-only and author-less files are not candidates');
    assert.equal(fs.existsSync(path.join(root, 'content/image-credits')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Strategy 4 dedups by Commons file and reuses one only when no unused file is usable', async () => {
  const root = tempRoot();
  try {
    // Locarno 1.jpg already sits on an article, under a thumb URL with tracking parameters.
    fs.writeFileSync(path.join(root, 'data/blog-images-used.json'), JSON.stringify({
      'articolo-vecchio': 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/23/Locarno_1.jpg/1280px-Locarno_1.jpg?utm_source=commons.wikimedia.org',
    }));
    // Query 1 offers only the used file; query 2 offers an unused one: the unused wins.
    let run = await runStrategy4({ root, responses: { q1: [searchPage('Locarno 1.jpg')], q2: [searchPage('Lugano prokudin.jpg')] } });
    assert.equal(run.data._imageCredit.commons.title, 'Lugano prokudin.jpg');
    assert.equal(run.calls.download.length, 1);

    // Nothing unused anywhere: the used file, as the last resort, after every query.
    fs.rmSync(path.join(root, 'content'), { recursive: true, force: true });
    run = await runStrategy4({ root, responses: { q1: [searchPage('Locarno 1.jpg')], q2: [] } });
    assert.equal(run.calls.search.length, 2, 'every query is tried before a reuse');
    assert.equal(run.result, '/images/blog/nuovo-articolo.webp');
    assert.equal(run.data._imageCredit.commons.title, 'Locarno 1.jpg');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Strategy 4 reuses a credited file with ITS record (curation and accepted restriction carried over)', async () => {
  const root = tempRoot();
  try {
    const f = { title: 'Patrol Police.jpg', ...SNAPSHOT.files['Patrol Police.jpg'] };
    const template = credit.creditTemplate(credit.assessCommonsFile(f), f, { fetchedAt: '2026-10-01' });
    credit.writeCreditRecord(root, credit.finalizeCreditRecord(
      { ...template, status: 'ok', curation: { by: 'owner', at: '2026-10-02', note: 'Q1: accepted' } },
      { cover: '/images/blog/articolo-polizia.webp', modified: 'resized' },
    ));
    const { data } = await runStrategy4({ root, responses: { police: [searchPage('Patrol Police.jpg')] } });
    assert.equal(data._imageCredit.cover, '/images/blog/nuovo-articolo.webp');
    assert.deepEqual(data._imageCredit.restrictions, ['personality']);
    assert.deepEqual(data._imageCredit.curation, { by: 'owner', at: '2026-10-02', note: 'Q1: accepted' });
    assert.equal(data._imageCredit.fetchedAt, '2026-10-01', 'the file fields are the existing record\'s, so the two covers agree');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Strategy 4 drops the cover when its record cannot be written', async () => {
  const root = tempRoot();
  try {
    const { result, data, imgPath, calls } = await runStrategy4({ root, failRecord: true, responses: { lugano: [searchPage('Locarno 1.jpg')] } });
    assert.equal(result, null);
    assert.equal(fs.existsSync(imgPath), false, 'no credit, no Commons cover on disk');
    assert.equal(data._imageCredit, undefined);
    assert.deepEqual(calls.used, []);
    assert.deepEqual(calls.catalog, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generateArticleImage forgets a credit left by an earlier attempt', () => {
  const head = slice(CREATE, 'async function generateArticleImage(data) {', 'const imageDeadline');
  assert.match(head, /delete data\._imageCredit;/);
});

const SAVE_AND_OPTIMIZE = slice(CREATE, '  async function _saveAndOptimize(', '  // ── Strategy 1: Gemini');

/** The real `_saveAndOptimize`, with a fake optimizer that copies the source to the cover. */
function makeSaveAndOptimize({ root, data }) {
  const imgPath = path.join(root, 'public', 'images', 'blog', `${data.id}.webp`);
  const catalog = [];
  const factory = new Function(
    'data', 'imgPath', 'PROJECT_ROOT', 'resolve', 'writeFileSync', 'existsSync', 'unlinkSync', 'optimizeImageToWebp',
    'BLOG_IMAGE_HARD_MAX_BYTES', 'console', 'appendCatalogEntry', 'creditRecordPath',
    `${SAVE_AND_OPTIMIZE}\nreturn _saveAndOptimize;`,
  );
  const save = factory(
    data, imgPath, root, (rel) => path.join(root, rel), fs.writeFileSync, fs.existsSync, fs.unlinkSync,
    async (src, dst) => { fs.copyFileSync(src, dst); return { ok: true, before: 6000, after: 6000 }; },
    10_000_000, quiet, (cover) => catalog.push(cover), credit.creditRecordPath,
  );
  return { save, catalog };
}

function writeLocarnoRecord(root, cover) {
  const verdict = credit.acceptCommonsCandidate(credit.readCommonsPage(searchPage('Locarno 1.jpg')), { fetchedAt: '2026-10-04' });
  assert.ok(verdict.ok);
  const record = credit.creditRecordForCover(verdict.template, { cover, original: { width: 2560, height: 1920 }, coverSize: { width: 1200, height: 675 } });
  return credit.writeCreditRecord(root, record);
}

test('a picture that is not from Commons removes a credit record left for the same cover, then is cataloged', async () => {
  const root = tempRoot();
  try {
    const data = { id: 'nuovo-articolo' };
    const recordFile = writeLocarnoRecord(root, '/images/blog/nuovo-articolo.webp');
    const { save, catalog } = makeSaveAndOptimize({ root, data });
    const cover = await save(Buffer.alloc(6000), 'Pixabay/lugano', 'image/jpeg');
    assert.equal(cover, '/images/blog/nuovo-articolo.webp');
    assert.equal(fs.existsSync(recordFile), false, 'the Commons credit would label a Pixabay picture');
    assert.deepEqual(catalog, ['/images/blog/nuovo-articolo.webp']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Commons picture leaves the record and the catalog to Strategy 4', async () => {
  const root = tempRoot();
  try {
    const data = { id: 'nuovo-articolo' };
    const recordFile = writeLocarnoRecord(root, '/images/blog/nuovo-articolo.webp');
    const { save, catalog } = makeSaveAndOptimize({ root, data });
    const cover = await save(Buffer.alloc(6000), 'Wikimedia/lugano', 'image/jpeg', { commons: true });
    assert.equal(cover, '/images/blog/nuovo-articolo.webp');
    assert.equal(fs.existsSync(recordFile), true, 'Strategy 4 rewrites it, or removes it if the install fails');
    assert.deepEqual(catalog, [], 'cataloged only once the credit is in place');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findStockImageCandidates offers a Commons photo only with its credit', () => {
  const body = slice(CREATE, 'async function findStockImageCandidates(data, count = 4) {', 'const pixabayKey = process.env.PIXABAY_API_KEY;');
  assert.match(body, /&\$\{COMMONS_IMAGEINFO_PARAMS\}&iiurlwidth=1280/);
  assert.match(body, /const verdict = acceptCommonsCandidate\(readCommonsPage\(p\)\);\s*if \(verdict\.ok\) \{\s*candidates\.push\(\{[^}]*credit: verdict\.template \}\)/);
});

// ── The SEO literal ────────────────────────────────────────────────────────

const MODIFY_SEO = slice(CREATE, 'function modifySeoService(data) {', '\n/**\n * Post-write validation');
const VALIDATE_LD = slice(CREATE, 'function validateStructuredData(data) {', 'function updateSitemapIndexLastmod(');
const SEO_SEED = "const BLOG_SEO_METADATA_5 = {\n  'blog-existing': {\n    title: 'Esistente',\n  },\n};\nexport default BLOG_SEO_METADATA_5;\n";
const SITE_RIGHTS = `
        "acquireLicensePage": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "copyrightNotice": "© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.",
        "license": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch/" },
        "creditText": "Frontaliere Ticino",`;

/**
 * The real modifySeoService then the real validateStructuredData, on an
 * in-memory SEO file. `records` maps a cover path to the record on disk.
 */
function registerSeo(data, records = new Map()) {
  let file = SEO_SEED;
  const SECTION = { seoFile: 'content/seo/seo-blog-5.ts', hubSlug: { it: 'articoli-frontaliere' }, seoConstName: 'BLOG_SEO_METADATA', updateRouterUnion: true };
  const modify = new Function(
    'SECTION', 'BASE_URL', 'PROJECT_ROOT', 'read', 'write', 'corpusPath', 'console', 'decodeSeoEntities', 'toIsoWithTz',
    'escapeForSingleQuoteTS', 'escapeRegex', 'replaceCaptureSafe', 'coverCreditFor',
    `${MODIFY_SEO}\nreturn modifySeoService;`,
  )(
    SECTION, 'https://frontaliereticino.ch', '/repo', () => file, (_rel, content) => { file = content; }, (p) => p, quiet,
    () => {}, () => '2026-10-04T10:00:00+02:00', escapeForSingleQuoteTS,
    (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    (src, re, build) => src.replace(re, (...args) => build(...args.slice(0, -2))),
    (_root, cover) => records.get(cover) ?? null,
  );
  modify(data);
  const validate = new Function(
    'SECTION', 'BASE_URL', 'read', 'findSeoEntryMatches', 'corpusPath', 'console',
    `${VALIDATE_LD}\nreturn validateStructuredData;`,
  )(SECTION, 'https://frontaliereticino.ch', () => file, findSeoEntryMatches, (p) => p, quiet);
  validate(data);
  const [match] = findSeoEntryMatches(file, data.id, 'memory');
  return file.slice(match.index, match.closeIdx + 1);
}

function articleData(cover, imageCredit) {
  return {
    id: 'nuovo-articolo',
    slugs: { it: 'nuovo-articolo' },
    seo: { title: 'Titolo', description: 'Descrizione', keywords: 'k', ogTitle: 'Og', ogDescription: 'Og descr', headline: 'Titolo' },
    imageAlt: { it: 'Alt' },
    author: { slug: 'redazione', name: 'Redazione Frontaliere Ticino' },
    _generatedImagePath: cover,
    ...(imageCredit ? { _imageCredit: imageCredit } : {}),
  };
}

const RECORD = credit.finalizeCreditRecord(
  credit.acceptCommonsCandidate({ title: 'Locarno 1.jpg', ...SNAPSHOT.files['Locarno 1.jpg'] }).template,
  { cover: '/images/blog/nuovo-articolo.webp', modified: 'cropped' },
);

test('the literal of a credited Commons cover carries none of the five rights fields', () => {
  const entry = registerSeo(articleData('/images/blog/nuovo-articolo.webp', RECORD));
  const image = entry.slice(entry.indexOf('"image"'), entry.indexOf('"datePublished"'));
  for (const key of ['acquireLicensePage', 'copyrightNotice', 'license', 'creator', 'creditText']) {
    assert.doesNotMatch(image, new RegExp(`"${key}"`), key);
  }
  assert.doesNotMatch(entry, /Tutti i diritti riservati/);
  assert.match(image, /"@type": "ImageObject",\n {8}"url": `\$\{BASE_URL\}\/images\/blog\/nuovo-articolo\.webp`,/);
});

test('a Commons cover reused by path (catalog pick, keyword fallback) is credited by its record too', () => {
  const reused = { ...RECORD, cover: '/images/blog/articolo-vecchio.webp' };
  const data = articleData('/images/blog/articolo-vecchio.webp');
  const entry = registerSeo(data, new Map([['/images/blog/articolo-vecchio.webp', reused]]));
  assert.doesNotMatch(entry, /"acquireLicensePage"|"creator"|Tutti i diritti riservati/);
  assert.equal(data._imageCredit, reused, 'validateStructuredData reads the same verdict');
});

test('every other cover keeps the site claim, byte for byte', () => {
  for (const data of [
    articleData('/images/blog/nuovo-articolo.webp'), // AI or stock cover: no record
    articleData('/images/places/lugano-view.webp'), // places catalogue
    articleData('/images/blog/nuovo-articolo.webp', { ...RECORD, cover: '/images/blog/another.webp' }), // stale credit
  ]) {
    const entry = registerSeo(data);
    assert.ok(entry.includes(`"@type": "ImageObject",${SITE_RIGHTS}\n        "url": \``), entry);
    assert.equal(data._imageCredit, null);
  }
});

test('validateStructuredData refuses a credited cover whose literal still claims rights', () => {
  const validate = new Function(
    'SECTION', 'BASE_URL', 'read', 'findSeoEntryMatches', 'corpusPath', 'console',
    `${VALIDATE_LD}\nreturn validateStructuredData;`,
  );
  const entryWith = (imageBody) => `{
    title: 'T', description: 'D', canonicalPath: '/articoli-frontaliere/x/',
    structuredData: { "image": { "@type": "ImageObject",${imageBody} "url": "u" }, "datePublished": "2026-10-04T10:00:00+02:00" }
  }`;
  const run = (entry, data) => validate(
    { seoFile: 'memory.ts' }, 'https://frontaliereticino.ch', () => entry,
    () => [{ index: 0, closeIdx: entry.length - 1 }], (p) => p, quiet,
  )(data);
  assert.doesNotThrow(() => run(entryWith(''), { id: 'x', _imageCredit: RECORD }));
  assert.throws(() => run(entryWith(' "creditText": "Frontaliere Ticino",'), { id: 'x', _imageCredit: RECORD }), /image\.creditText must be absent/);
  assert.throws(
    () => run(entryWith(' "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization" },'), { id: 'x', _imageCredit: RECORD }),
    /image\.creator must be absent/,
  );
  // Not credited: the existing rule, unchanged.
  assert.throws(() => run(entryWith(''), { id: 'x' }), /image\.creator must reference/);
});

// ── The journalist path ────────────────────────────────────────────────────

const RESOLVE_HERO = slice(JOURNALIST, 'async function resolveHeroImage(data, doc) {', '\n/**\n * Resolves the byline');
const SHARP_IMPORT = "(await import('sharp')).default";

/**
 * The real resolveHeroImage. Commons answers from the fixture, the download
 * returns bytes, and a fake sharp writes a WebP header of the size it would
 * produce a 1200×675 WebP, cropping larger uploads to the shared social geometry.
 */
async function runResolveHero({ root, image, apiTitle, original = { width: 2560, height: 1920 }, writeCreditRecord = credit.writeCreditRecord }) {
  assert.ok(RESOLVE_HERO.includes(SHARP_IMPORT), 'the sharp import moved: update the harness');
  const calls = { api: 0, download: 0, catalog: [] };
  const apiFetch = async () => {
    calls.api += 1;
    const f = SNAPSHOT.files[apiTitle];
    const extmetadata = Object.fromEntries(Object.entries(f.meta).map(([k, v]) => [k, { value: v }]));
    return {
      ok: true,
      json: async () => ({ query: { pages: [{ pageid: f.pageId, title: `File:${apiTitle}`, imageinfo: [{ timestamp: f.revision, width: f.width, height: f.height, descriptionurl: f.pageUrl, extmetadata }] }] } }),
    };
  };
  const download = async () => { calls.download += 1; return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) }; };
  const sharp = () => {
    let resized = null;
    const api = {
      rotate: () => api,
      metadata: async () => original,
      resize: (opts) => { resized = opts; return api; },
      webp: () => api,
      toFile: async (dest) => { fs.writeFileSync(dest, webpHeader(resized?.width ?? original.width, resized?.height ?? original.height)); },
    };
    return api;
  };
  const resolveHeroImage = new Function(
    'fs', 'path', 'PROJECT_ROOT', 'fetch', '__sharp', 'console', 'appendCatalogEntry', 'findBestFallbackImage',
    'STATIC_FALLBACK_IMAGE', 'BLOG_IMAGE_TARGET_MAX_BYTES', 'BLOG_IMAGE_HARD_MAX_BYTES',
    'BLOG_IMAGE_WIDTH', 'BLOG_IMAGE_HEIGHT', 'BLOG_IMAGE_QUALITY_PASSES', 'resolveCommonsPick',
    'creditRecordForCover', 'webpDimensions',
    'writeCreditRecord',
    `${RESOLVE_HERO.replace(SHARP_IMPORT, '__sharp')}\nreturn resolveHeroImage;`,
  )(
    fs, path, root, download, sharp, quiet, (p) => calls.catalog.push(p), () => '/images/places/lugano-view.webp',
    'lugano-view.webp', 190 * 1024, 320 * 1024, 1200, 675,
    [75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20],
    (args) => credit.resolveCommonsPick({ ...args, fetchImpl: apiFetch, fetchedAt: '2026-10-04' }),
    credit.creditRecordForCover, credit.webpDimensions, writeCreditRecord,
  );
  const data = { id: 'articolo-firmato' };
  const result = await resolveHeroImage(data, { image });
  return { result, data, calls };
}

const COMMONS_THUMB = (file) => `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${file}/1280px-${file}`;

test('journalist path: a creditable Commons pick is used with its record', async () => {
  const root = tempRoot();
  try {
    const { result, data, calls } = await runResolveHero({ root, image: COMMONS_THUMB('Locarno_1.jpg'), apiTitle: 'Locarno 1.jpg' });
    assert.equal(result.source, 'commons-pick');
    assert.equal(calls.api, 1);
    assert.equal(calls.download, 1);
    assert.equal(data._generatedImagePath, '/images/blog/articolo-firmato.webp');
    const record = JSON.parse(fs.readFileSync(path.join(root, 'content/image-credits/blog/articolo-firmato.json'), 'utf-8'));
    assert.deepEqual(data._imageCredit, record);
    assert.equal(record.modified, 'cropped', 'large uploads use the shared 1200×675 social geometry');
    assert.deepEqual(calls.catalog, ['/images/blog/articolo-firmato.webp']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('journalist path: a Commons pick that cannot be credited is never downloaded', async () => {
  const root = tempRoot();
  try {
    const { result, data, calls } = await runResolveHero({ root, image: COMMONS_THUMB('Patrol_Police.jpg'), apiTitle: 'Patrol Police.jpg' });
    assert.equal(calls.download, 0);
    assert.equal(result.source, 'keyword-fallback');
    assert.equal(data._generatedImagePath, '/images/places/lugano-view.webp');
    assert.equal(data._imageCredit, undefined);
    assert.equal(fs.existsSync(path.join(root, 'public/images/blog/articolo-firmato.webp')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('journalist path: an own upload is handled as before, without asking Commons', async () => {
  const root = tempRoot();
  try {
    const { result, data, calls } = await runResolveHero({ root, image: 'https://firebasestorage.googleapis.com/v0/b/x/o/upload.jpg', apiTitle: 'Locarno 1.jpg', original: { width: 800, height: 600 } });
    assert.equal(result.source, 'journalist-upload');
    assert.equal(calls.api, 0);
    assert.equal(data._imageCredit, undefined);
    assert.equal(fs.existsSync(path.join(root, 'content/image-credits')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('journalist path: no record written, no Commons cover kept', async () => {
  const root = tempRoot();
  try {
    const { result, data } = await runResolveHero({
      root, image: COMMONS_THUMB('Locarno_1.jpg'), apiTitle: 'Locarno 1.jpg',
      writeCreditRecord: () => { throw new Error('disk full'); },
    });
    assert.equal(result.source, 'keyword-fallback');
    assert.equal(data._imageCredit, undefined);
    assert.equal(fs.existsSync(path.join(root, 'public/images/blog/articolo-firmato.webp')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
