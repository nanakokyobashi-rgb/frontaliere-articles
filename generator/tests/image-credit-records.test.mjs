/**
 * image-credit-records.test.mjs — the corpus-side checks on the cover credits
 * and the SPA's copy of them (P14, `scripts/lib/image-credit-records.mjs`,
 * `scripts/build-blog-index.mjs`, `publish-api.yml`). Run with `node --test`.
 *
 * Fixtures only, in temporary trees: the same checks on the REAL corpus are
 * the content gate `image-credits-content.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_CREDITS_INDEX_SCHEMA,
  auditCreditRecords,
  buildImageCreditsIndex,
  corpusCreditReader,
  findCreditedRightsClaims,
  readCreditRecords,
  scanSeoImageBlocks,
  stripCreditedImageRights,
} from '../../scripts/lib/image-credit-records.mjs';
import { acceptCommonsCandidate, finalizeCreditRecord, writeCreditRecord } from '../scripts/lib/commons-credit.mjs';
import { relativeImportClosure } from './lib/reachable-source.mjs';
import { imageCreditParts, imageObjectCreditFields, validateImageCreditRecord } from '../../engine/shared/imageCredits.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('./fixtures/commons-credit/probe-2026-10-04.snapshot.json', import.meta.url), 'utf-8'));

function recordFor(title, cover, modified = 'cropped') {
  const verdict = acceptCommonsCandidate({ title, ...SNAPSHOT.files[title] }, { fetchedAt: '2026-10-04' });
  assert.ok(verdict.ok, title);
  return finalizeCreditRecord(verdict.template, { cover, modified });
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'image-credit-records-'));
}

function writeRaw(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The three shapes of the five rights fields found in the 7,627 literals of content/seo. */
const RIGHTS_MULTILINE = `"@type": "ImageObject",
        "acquireLicensePage": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "copyrightNotice": "© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.",
        "license": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "creator": { "@type": "NewsMediaOrganization", "@id": "https://frontaliereticino.ch/#organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch/" },
        "creditText": "Frontaliere Ticino",
        "url": \`\${BASE_URL}/images/blog/KEY.webp\`,
        "width": 1200,
        "height": 675,
        "caption": "Una didascalia con \\"virgolette\\" e {graffe}"`;
const RIGHTS_SINGLELINE = '"@type": "ImageObject", "acquireLicensePage": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini", "copyrightNotice": "© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.", "license": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini", "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch/" }, "creditText": "Frontaliere Ticino", "url": `${BASE_URL}/images/blog/KEY.webp`,\n "width": 1344,\n "height": 756';
const RIGHTS_NO_CREDITTEXT = `"@type": "ImageObject",
        "acquireLicensePage": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "copyrightNotice": "© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.",
        "license": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch/" },
        "url": \`\${BASE_URL}/images/blog/KEY.webp\`,
        "width": 1200`;

function seoEntry(id, imageBody) {
  return ` 'blog-${id}': {\n title: 'T ${id}',\n structuredData: {\n "@type": "NewsArticle",\n "image": {\n ${imageBody.replace(/KEY/g, id)}\n },\n "datePublished": "2026-10-04T10:00:00+02:00"\n }\n },\n`;
}

// ── Records ────────────────────────────────────────────────────────────────

test('audit: a clean set of records has no problem; no directory is an empty set', () => {
  const root = tempRoot();
  try {
    assert.deepEqual(readCreditRecords(root), [], 'before the backfill no cover has a record');
    writeCreditRecord(root, recordFor('Locarno 1.jpg', '/images/blog/a.webp'));
    writeCreditRecord(root, recordFor('Locarno 1.jpg', '/images/blog/b.webp', 'resized'));
    assert.deepEqual(auditCreditRecords(readCreditRecords(root)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('audit: invalid, misnamed, under review, unparseable and disagreeing records are each reported', () => {
  const root = tempRoot();
  try {
    const dir = 'content/image-credits/blog';
    const good = recordFor('Locarno 1.jpg', '/images/blog/good.webp');
    writeRaw(root, `${dir}/good.json`, JSON.stringify(good));
    writeRaw(root, `${dir}/broken.json`, '{ not json');
    writeRaw(root, `${dir}/invalid.json`, JSON.stringify({ ...good, cover: '/images/blog/invalid.webp', licence: { ...good.licence, url: null } }));
    writeRaw(root, `${dir}/misnamed.json`, JSON.stringify({ ...good, cover: '/images/blog/elsewhere.webp' }));
    writeRaw(root, `${dir}/review.json`, JSON.stringify({ ...good, cover: '/images/blog/review.webp', status: 'review' }));
    writeRaw(root, `${dir}/other.json`, JSON.stringify({ ...good, cover: '/images/blog/other.webp', author: { ...good.author, name: 'Somebody Else' } }));
    const problems = auditCreditRecords(readCreditRecords(root)).join('\n');
    assert.match(problems, /broken\.json: not JSON/);
    assert.match(problems, /invalid\.json: invalid record — .*licence\.url is required for cc-by-sa/);
    assert.match(problems, /misnamed\.json: cover \/images\/blog\/elsewhere\.webp does not match the file name/);
    assert.match(problems, /review\.json: status "review"/);
    assert.match(problems, /disagrees with .* about Commons file «Locarno 1\.jpg»/);
    assert.doesNotMatch(problems, /^content\/image-credits\/blog\/good\.json/m, 'the clean record is only ever the reference');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── SEO literals ───────────────────────────────────────────────────────────

test('scan: each literal shape yields its cover and the rights fields it carries', () => {
  const src = seoEntry('uno', RIGHTS_MULTILINE) + seoEntry('due', RIGHTS_SINGLELINE) + seoEntry('tre', RIGHTS_NO_CREDITTEXT)
    + seoEntry('quattro', '"@type": "ImageObject", "url": `${BASE_URL}/images/places/lugano.webp`');
  const blocks = scanSeoImageBlocks(src);
  assert.deepEqual(blocks.map((b) => [b.cover, b.rights.join(',')]), [
    ['uno', 'acquireLicensePage,copyrightNotice,license,creator,creditText'],
    ['due', 'acquireLicensePage,copyrightNotice,license,creator,creditText'],
    ['tre', 'acquireLicensePage,copyrightNotice,license,creator'],
    [null, ''],
  ]);
});

test('strip: only the rights run of credited covers goes, everything else stays byte for byte', () => {
  const src = seoEntry('uno', RIGHTS_MULTILINE) + seoEntry('due', RIGHTS_SINGLELINE) + seoEntry('tre', RIGHTS_NO_CREDITTEXT)
    + seoEntry('altro', RIGHTS_MULTILINE);
  const credited = new Set(['uno', 'due', 'tre']);
  const { src: out, stripped, unmatched } = stripCreditedImageRights(src, (key) => credited.has(key));
  assert.deepEqual(stripped.sort(), ['due', 'tre', 'uno']);
  assert.deepEqual(unmatched, []);
  const blocks = new Map(scanSeoImageBlocks(out).map((b) => [b.cover, b]));
  for (const key of credited) assert.deepEqual(blocks.get(key).rights, [], key);
  assert.equal(blocks.get('altro').rights.length, 5, 'a cover without a record keeps the site claim');
  assert.ok(out.includes('"@type": "ImageObject",\n        "url": `${BASE_URL}/images/blog/uno.webp`,'), 'multi-line: the lines go, the indentation stays');
  assert.ok(out.includes('"@type": "ImageObject", "url": `${BASE_URL}/images/blog/due.webp`,'), 'single-line');
  assert.ok(out.includes('"caption": "Una didascalia con \\"virgolette\\" e {graffe}"'), 'escaped quotes and braces in values survive');
  // Idempotent.
  assert.equal(stripCreditedImageRights(out, (key) => credited.has(key)).src, out);
});

test('strip: a literal written differently is left for a human, not guessed', () => {
  const foreign = '"@type": "ImageObject", "creditText": "Someone Else", "url": `${BASE_URL}/images/blog/KEY.webp`';
  const split = '"@type": "ImageObject", "license": "https://frontaliereticino.ch/x", "caption": "c", "creator": { "name": "Frontaliere Ticino" }, "url": `${BASE_URL}/images/blog/KEY.webp`';
  const src = seoEntry('estraneo', foreign) + seoEntry('spezzato', split);
  const result = stripCreditedImageRights(src, () => true);
  assert.equal(result.src, src);
  assert.deepEqual(result.unmatched.map((u) => [u.cover, u.reason]), [
    ['estraneo', "rights fields are not the site's claim"],
    ['spezzato', 'rights fields are not contiguous'],
  ]);
});

test('claims: a credited cover whose literal still carries rights fields is found, in any seo-blog file', () => {
  const root = tempRoot();
  try {
    writeRaw(root, 'content/seo/seo-blog.ts', seoEntry('vecchio', RIGHTS_SINGLELINE));
    writeRaw(root, 'content/seo/seo-blog-ch.ts', seoEntry('nuovo', RIGHTS_MULTILINE) + seoEntry('libero', RIGHTS_MULTILINE));
    writeRaw(root, 'content/seo/seoMetadataType.ts', seoEntry('tipo', RIGHTS_MULTILINE));
    const claims = findCreditedRightsClaims(root, new Set(['vecchio', 'nuovo', 'tipo']));
    assert.deepEqual(claims.map((c) => [c.file, c.cover]), [
      ['content/seo/seo-blog-ch.ts', 'nuovo'],
      ['content/seo/seo-blog.ts', 'vecchio'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── data/image-credits-<section>.json ──────────────────────────────────────

test('credits index: one entry per Commons file, one per cover, only publishable records', () => {
  const root = tempRoot();
  try {
    writeCreditRecord(root, recordFor('Locarno 1.jpg', '/images/blog/uno.webp', 'resized'));
    writeCreditRecord(root, recordFor('Locarno 1.jpg', '/images/blog/due.webp', 'cropped'));
    writeCreditRecord(root, recordFor('Lugano prokudin.jpg', '/images/blog/tre.webp'));
    writeRaw(root, 'content/image-credits/blog/rivedere.json', JSON.stringify({ ...recordFor('Lugano prokudin.jpg', '/images/blog/rivedere.webp'), status: 'review' }));
    const warnings = [];
    const { payload, conflicts } = buildImageCreditsIndex({
      section: 'frontaliere',
      commit: 'abc123',
      images: [
        'https://cdn.frontaliereticino.ch/images/blog/uno.webp',
        'https://cdn.frontaliereticino.ch/images/blog/due.webp',
        '/images/blog/tre.webp',
        '/images/blog/rivedere.webp',
        '/images/blog/senza-credito.webp',
        '/images/places/lugano-view.webp',
      ],
      reader: corpusCreditReader(root, (m) => warnings.push(m)),
    });
    assert.deepEqual(conflicts, []);
    assert.equal(payload.schema, IMAGE_CREDITS_INDEX_SCHEMA);
    assert.equal(payload.commit, 'abc123');
    assert.equal(payload.section, 'frontaliere');
    assert.deepEqual(payload.covers, {
      due: { file: 'Locarno 1.jpg', modified: 'cropped' },
      tre: { file: 'Lugano prokudin.jpg', modified: 'cropped' },
      uno: { file: 'Locarno 1.jpg', modified: 'resized' },
    });
    assert.deepEqual(Object.keys(payload.files), ['Locarno 1.jpg', 'Lugano prokudin.jpg']);
    assert.deepEqual(payload.files['Locarno 1.jpg'], {
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Locarno_1.jpg',
      author: { name: 'Riessdo', url: 'https://de.wikipedia.org/wiki/User:Riessdo', type: 'Person' },
      attribution: null,
      licence: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/', family: 'cc-by-sa', attributionRequired: true },
      fetchedAt: '2026-10-04',
    });
    assert.match(warnings.join('\n'), /rivedere\.json: status "review" is not publishable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credits index: a consumer rebuilds, from it, the record the engine renders', () => {
  const root = tempRoot();
  try {
    const record = recordFor('Locarno 1.jpg', '/images/blog/uno.webp', 'resized');
    writeCreditRecord(root, record);
    const { payload } = buildImageCreditsIndex({ section: 'svizzera', commit: null, images: ['/images/blog/uno.webp'], reader: corpusCreditReader(root) });
    const { file, modified } = payload.covers.uno;
    const f = payload.files[file];
    const rebuilt = {
      schema: 1, cover: '/images/blog/uno.webp', source: 'wikimedia-commons',
      commons: { title: file, pageUrl: f.pageUrl },
      author: { text: null, ...f.author }, attribution: f.attribution, licence: f.licence,
      restrictions: [], modified, fetchedAt: f.fetchedAt, status: 'ok', curation: null,
    };
    assert.ok(validateImageCreditRecord(rebuilt).valid, validateImageCreditRecord(rebuilt).errors.join('; '));
    assert.deepEqual(imageObjectCreditFields(rebuilt), imageObjectCreditFields(record));
    assert.deepEqual(imageCreditParts(rebuilt, 'it'), imageCreditParts(record, 'it'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credits index: two covers that credit one file differently are a conflict, not a coin toss', () => {
  const root = tempRoot();
  try {
    const first = recordFor('Locarno 1.jpg', '/images/blog/a-uno.webp');
    writeCreditRecord(root, first);
    // Same file read on another day: not a conflict, the most recent read is kept.
    writeCreditRecord(root, { ...first, cover: '/images/blog/b-due.webp', fetchedAt: '2026-09-30' });
    writeCreditRecord(root, { ...first, cover: '/images/blog/c-tre.webp', licence: { ...first.licence, name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' } });
    const { conflicts, payload } = buildImageCreditsIndex({
      section: 'frontaliere', commit: null, reader: corpusCreditReader(root),
      images: ['/images/blog/c-tre.webp', '/images/blog/b-due.webp', '/images/blog/a-uno.webp'],
    });
    assert.deepEqual(conflicts, ['covers a-uno and c-tre credit Commons file «Locarno 1.jpg» differently']);
    // c-tre was read the same day as a-uno, the group's latest read: a tie keeps the cover first in key order.
    assert.equal(payload.files['Locarno 1.jpg'].licence.name, 'CC BY-SA 3.0');
    assert.equal(payload.files['Locarno 1.jpg'].fetchedAt, '2026-10-04');
    assert.deepEqual(payload.covers['c-tre'], { file: 'Locarno 1.jpg', modified: first.modified }, 'no cover goes out without a credit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credits index: covers of one file that agree carry its most recent read, whatever their key order', () => {
  const root = tempRoot();
  try {
    const record = recordFor('Locarno 1.jpg', '/images/blog/a-uno.webp');
    // The latest read sits between two older ones in key order.
    writeCreditRecord(root, { ...record, fetchedAt: '2026-09-01' });
    writeCreditRecord(root, { ...record, cover: '/images/blog/b-due.webp', fetchedAt: '2026-10-04' });
    writeCreditRecord(root, { ...record, cover: '/images/blog/c-tre.webp', fetchedAt: '2026-09-15' });
    const { conflicts, payload } = buildImageCreditsIndex({
      section: 'frontaliere', commit: null, reader: corpusCreditReader(root),
      images: ['/images/blog/a-uno.webp', '/images/blog/b-due.webp', '/images/blog/c-tre.webp'],
    });
    assert.deepEqual(conflicts, [], 'the same credit read on three days is not a conflict');
    assert.equal(payload.files['Locarno 1.jpg'].fetchedAt, '2026-10-04', 'the day the credit was last confirmed');
    assert.deepEqual(Object.keys(payload.covers), ['a-uno', 'b-due', 'c-tre']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credits index: of two disagreeing reads of one file, the most recent is the file\'s credit for every cover', () => {
  const root = tempRoot();
  try {
    const old = { ...recordFor('Locarno 1.jpg', '/images/blog/a-uno.webp'), fetchedAt: '2026-09-01' };
    writeCreditRecord(root, old);
    writeCreditRecord(root, { ...old, cover: '/images/blog/b-due.webp', fetchedAt: '2026-10-04', author: { ...old.author, name: 'Riessdo (new display name)' } });
    const { conflicts, payload } = buildImageCreditsIndex({
      section: 'frontaliere', commit: null, reader: corpusCreditReader(root),
      images: ['/images/blog/a-uno.webp', '/images/blog/b-due.webp'],
    });
    assert.equal(conflicts.length, 1);
    assert.equal(payload.files['Locarno 1.jpg'].author.name, 'Riessdo (new display name)');
    assert.equal(payload.files['Locarno 1.jpg'].fetchedAt, '2026-10-04');
    assert.deepEqual(Object.keys(payload.covers), ['a-uno', 'b-due']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── The publisher ──────────────────────────────────────────────────────────

/** A corpus tree build-blog-index.mjs can run on: code copied from this checkout, two sections of one article each. */
function blogIndexTree() {
  const root = tempRoot();
  for (const file of relativeImportClosure(path.join(REPO, 'scripts/build-blog-index.mjs'))) {
    const rel = path.relative(REPO, file);
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.cpSync(file, path.join(root, rel));
  }
  writeRaw(root, 'content/blog-body/it/uno.ts', 'export const uno = true;\n');
  writeRaw(root, 'content/blog-body-ch/it/due.ts', 'export const due = true;\n');
  writeRaw(root, 'content/blog-articles-data.ts', "export const RAW_ARTICLES = [{ id: 'uno', category: 'news', date: '2026-10-01', image: '/images/blog/uno.webp' }];\n");
  writeRaw(root, 'content/swiss-articles-data.ts', "export const RAW_SWISS_ARTICLES = [{ id: 'due', category: 'news', date: '2026-10-02', image: '/images/blog/due.webp' }];\n");
  for (const locale of ['it', 'en', 'de', 'fr']) {
    writeRaw(root, `content/blog-meta-${locale}.ts`, "'blog.article.uno.title': 'Uno',\n");
    writeRaw(root, `content/blog-meta-ch-${locale}.ts`, "'blog.article.due.title': 'Due',\n");
  }
  writeCreditRecord(root, recordFor('Locarno 1.jpg', '/images/blog/uno.webp'));
  return root;
}

test('build-blog-index publishes image-credits-<section>.json beside the index, declared in the manifest', () => {
  const root = blogIndexTree();
  try {
    writeRaw(root, 'dist/api/manifest.json', JSON.stringify({ schema: 1, commit: 'f00dfeed', counts: {}, files: {} }));
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-blog-index.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const frontaliere = JSON.parse(fs.readFileSync(path.join(root, 'dist/api/data/image-credits-frontaliere.json'), 'utf-8'));
    assert.equal(frontaliere.commit, 'f00dfeed', 'the release of manifest.json');
    assert.deepEqual(frontaliere.covers, { uno: { file: 'Locarno 1.jpg', modified: 'cropped' } });
    assert.equal(frontaliere.files['Locarno 1.jpg'].author.name, 'Riessdo');
    const svizzera = JSON.parse(fs.readFileSync(path.join(root, 'dist/api/data/image-credits-svizzera.json'), 'utf-8'));
    assert.deepEqual(svizzera.covers, {}, 'a section without a credited cover still gets its (empty) file');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/api/manifest.json'), 'utf-8'));
    for (const section of ['frontaliere', 'svizzera']) {
      const rel = `data/image-credits-${section}.json`;
      assert.equal(manifest.files[rel], fs.statSync(path.join(root, 'dist/api', rel)).size, rel);
    }
    const aggregate = JSON.parse(fs.readFileSync(path.join(root, 'dist/api/data/image-credits-blog.json'), 'utf-8'));
    assert.equal(aggregate.schema, 1);
    assert.equal(aggregate.section, 'blog');
    assert.deepEqual(aggregate.sections, {
      frontaliere: 'image-credits-frontaliere.json',
      svizzera: 'image-credits-svizzera.json',
    });
    assert.equal(manifest.files['data/image-credits-blog.json'], fs.statSync(path.join(root, 'dist/api/data/image-credits-blog.json')).size);
    assert.equal(manifest.counts.imageCreditFiles, 3);
    assert.equal(manifest.counts.blogIndexShards, 16, 'the index declaration is unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('build-blog-index still publishes when two covers credit one file differently: both carry the file\'s most recent read, with a warning', () => {
  const root = blogIndexTree();
  try {
    const first = recordFor('Locarno 1.jpg', '/images/blog/uno.webp');
    writeRaw(root, 'content/blog-articles-data.ts', "export const RAW_ARTICLES = [{ id: 'uno', category: 'news', date: '2026-10-01', image: '/images/blog/uno.webp' }, { id: 'tre', category: 'news', date: '2026-10-03', image: '/images/blog/tre.webp' }];\n");
    writeRaw(root, 'content/blog-body/it/tre.ts', 'export const tre = true;\n');
    for (const locale of ['it', 'en', 'de', 'fr']) writeRaw(root, `content/blog-meta-${locale}.ts`, "'blog.article.uno.title': 'Uno',\n'blog.article.tre.title': 'Tre',\n");
    writeCreditRecord(root, { ...first, cover: '/images/blog/tre.webp', author: { ...first.author, name: 'Someone Else' } });
    const out = path.join(root, 'out');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-blog-index.mjs'), '--out', out], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, 'one disagreeing cover does not hold back the publication: ' + result.stdout + result.stderr);
    assert.match(result.stderr, /::warning::frontaliere: covers tre and uno credit Commons file «Locarno 1\.jpg» differently — both covers carry the most recent read of the file/);
    const credits = JSON.parse(fs.readFileSync(path.join(out, 'image-credits-frontaliere.json'), 'utf-8'));
    assert.deepEqual(Object.keys(credits.covers), ['tre', 'uno'], 'no cover goes out without a credit');
    assert.equal(credits.files['Locarno 1.jpg'].author.name, 'Someone Else', 'same day: the cover first in key order');
    assert.ok(fs.existsSync(path.join(out, 'blog-index-frontaliere-it.json')), 'the index is published as usual');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publish-api.yml uploads and purges the credits like the blog index, and republishes when their builder changes', () => {
  const wf = fs.readFileSync(path.join(REPO, '.github/workflows/publish-api.yml'), 'utf-8');
  assert.match(wf, /for f in dist\/api\/data\/blog-index-\*\.json dist\/api\/data\/image-credits-\*\.json; do\n\s+\[ -s "\$f" \] \|\| continue\n\s+bash scripts\/lib\/upload-cdn-file\.sh "\$f" "data\/\$\(basename "\$f"\)" "public,max-age=600"\n\s+urls\+=\("https:\/\/cdn\.frontaliereticino\.ch\/data\/\$\(basename "\$f"\)"\)/);
  const paths = wf.slice(wf.indexOf('paths:'), wf.indexOf('schedule:'));
  for (const trigger of ["'content/**'", "'engine/**'", "'public/images/generated/**'", "'scripts/build-blog-index.mjs'", "'scripts/lib/image-credit-records.mjs'", "'generator/scripts/lib/blog-image-registry.mjs'"]) {
    assert.ok(paths.includes(trigger), `publish-api.yml does not republish on ${trigger}`);
  }
});
