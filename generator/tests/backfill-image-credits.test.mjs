/**
 * backfill-image-credits.test.mjs — the one-off backfill of the cover credits
 * (P14, `scripts/backfill-image-credits.mjs`), on a small corpus built in a
 * temporary tree from real probe data. Run with `node --test`.
 *
 * The tree has what C2 will meet, in miniature: a creditable file on two
 * covers and a third article reusing one of them, a personality-restricted
 * file, a GFDL-only file to replace, a file with no machine-readable licence,
 * a site-era cover whose webp is not in this repository, a cover still shown
 * by another article after its own was retired, a cover that is not Commons at
 * all, a map entry no page shows any more, and literals in both formats. The
 * last tests add what C3 met: a restricted file replaced by a new Commons
 * cover under a new name, `<id>-2.webp`, with its own record and map entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OVERRIDES_FILE,
  SNAPSHOT_FILE,
  checkTree,
  fetchSnapshot,
  liveCommonsCovers,
  retryAfterSeconds,
  serializeSnapshot,
  titleBatches,
} from '../../scripts/backfill-image-credits.mjs';
import { corpusCreditReader, scanSeoImageBlocks } from '../../scripts/lib/image-credit-records.mjs';
import {
  acceptCommonsCandidate,
  assessCommonsFile,
  creditRecordForCover,
  finalizeCreditRecord,
  writeCreditRecord,
} from '../scripts/lib/commons-credit.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/backfill-image-credits.mjs');
const PROBE = JSON.parse(fs.readFileSync(new URL('./fixtures/commons-credit/probe-2026-10-04.snapshot.json', import.meta.url), 'utf-8'));
const NASA = 'PIA11044-PhoenixLander-WorkspaceNames-20080819.jpg';
const CURATION = { by: 'redazione', at: '2026-10-05', note: 'checked on the file page' };

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

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const upload = (title) => `https://upload.wikimedia.org/wikipedia/commons/a/ab/${encodeURIComponent(title.replace(/ /g, '_'))}`;
const thumb = (title) => `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${encodeURIComponent(title.replace(/ /g, '_'))}/1280px-x.jpg?utm_source=commons.wikimedia.org`;
const SITE_RIGHTS_ML = `"acquireLicensePage": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "copyrightNotice": "© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.",
        "license": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch/" },
        "creditText": "Frontaliere Ticino",
        `;
const SITE_RIGHTS_SL = '"acquireLicensePage": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini", "copyrightNotice": "© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.", "license": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini", "creator": { "@type": "NewsMediaOrganization", "@id": "https://frontaliereticino.ch/#organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch/" }, "creditText": "Frontaliere Ticino", ';
const literal = (id, cover, rights = SITE_RIGHTS_ML) => `  'blog-${id}': {
    title: 'Titolo ${id}',
    structuredData: {
      "@type": "NewsArticle",
      "image": {
        "@type": "ImageObject",
        ${rights}"url": \`\${BASE_URL}${cover}\`,
        "width": 1200,
        "height": 675
      },
      "datePublished": "2026-10-04T10:00:00+02:00"
    }
  },
`;
const row = (id, image) => `  {\n   id: '${id}',\n   category: 'novita',\n   date: '2026-10-01',\n   image: '${image}',\n   hasCalculator: false,\n  },\n`;

/** The miniature corpus (see the header). */
function corpusTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-credits-'));
  write(root, 'content/blog-articles-data.ts', `const RAW_ARTICLES = [\n${[
    row('locarno-uno', '/images/blog/locarno-uno.webp'),
    row('riuso-locarno', '/images/blog/locarno-uno.webp'),
    row('polizia', '/images/blog/polizia.webp'),
    row('tessera', '/images/blog/tessera.webp'),
    row('nasa', '/images/blog/nasa.webp'),
    row('prokudin', '/images/blog/prokudin.webp'),
    row('stock', '/images/blog/stock.webp'),
    row('usa-ritirato', '/images/blog/ritirato.webp'),
    row('tessera-due', '/images/blog/tessera-due.webp'),
  ].join('')}];\n`);
  write(root, 'content/swiss-articles-data.ts', `const RAW_SWISS_ARTICLES = [\n${row('ch-locarno', '/images/blog/ch-locarno.webp')}];\n`);
  write(root, 'data/blog-images-used.json', JSON.stringify({
    'locarno-uno': thumb('Locarno 1.jpg'),
    polizia: upload('Patrol Police.jpg'),
    tessera: upload('EHIC Slovenia.jpg'),
    nasa: upload(NASA),
    'ch-locarno': upload('Locarno 1.jpg'),
    'non-pubblicato': upload('Locarno 1.jpg'),
    ritirato: upload('Locarno 1.jpg'),
    'tessera-due': upload('EHIC Slovenia.jpg'),
  }));
  write(root, 'data/blog-images-used-site-legacy.json', JSON.stringify({ prokudin: upload('Lugano prokudin.jpg') }));
  const files = Object.fromEntries(['Locarno 1.jpg', 'Patrol Police.jpg', 'EHIC Slovenia.jpg', NASA, 'Lugano prokudin.jpg'].map((t) => [t, PROBE.files[t]]));
  write(root, SNAPSHOT_FILE, serializeSnapshot({ schema: 1, fetchedAt: '2026-10-04', requests: 1, files, aliases: {} }));
  write(root, 'public/images/blog/locarno-uno.webp', webpHeader(1200, 675));
  write(root, 'public/images/blog/ch-locarno.webp', webpHeader(1200, 900));
  write(root, 'public/images/blog/polizia.webp', webpHeader(1200, 675));
  write(root, 'public/images/blog/tessera.webp', webpHeader(1200, 675));
  write(root, 'public/images/blog/nasa.webp', webpHeader(1200, 675));
  write(root, 'public/images/blog/ritirato.webp', webpHeader(1200, 675));
  write(root, 'public/images/blog/tessera-due.webp', webpHeader(1200, 675));
  write(root, 'public/images/blog/stock.webp', webpHeader(1280, 720));
  write(root, 'content/seo/seo-blog-5.ts', `const BLOG_SEO_METADATA_5 = {\n${[
    literal('locarno-uno', '/images/blog/locarno-uno.webp'),
    literal('riuso-locarno', '/images/blog/locarno-uno.webp'),
    literal('polizia', '/images/blog/polizia.webp'),
    literal('tessera', '/images/blog/tessera.webp'),
    literal('nasa', '/images/blog/nasa.webp'),
    literal('prokudin', '/images/blog/prokudin.webp'),
    literal('stock', '/images/blog/stock.webp'),
    literal('usa-ritirato', '/images/blog/ritirato.webp'),
    literal('tessera-due', '/images/blog/tessera-due.webp'),
  ].join('')}};\nexport default BLOG_SEO_METADATA_5;\n`);
  write(root, 'content/seo/seo-blog-ch.ts', `const BLOG_CH_SEO_METADATA = {\n${literal('ch-locarno', '/images/blog/ch-locarno.webp', SITE_RIGHTS_SL)}};\nexport default BLOG_CH_SEO_METADATA;\n`);
  return root;
}

const OVERRIDES = {
  schema: 1,
  files: {
    'Patrol Police.jpg': { decision: 'accept-restriction', curation: { by: 'owner', at: '2026-10-05', note: 'Q1: kept' } },
    'EHIC Slovenia.jpg': { decision: 'replace', replacement: '/images/places/lugano-view.webp', curation: { by: 'owner', at: '2026-10-05', note: 'GFDL-only' } },
    [NASA]: {
      licence: { name: 'Public domain', url: null, family: 'pd', attributionRequired: false },
      author: { name: 'NASA/JPL-Caltech/University of Arizona/Texas A&M University', url: null, type: 'Organization' },
      curation: CURATION,
    },
  },
  // A cover suited to each article: the second GFDL cover gets its own replacement.
  covers: { prokudin: { modified: 'cropped' }, 'tessera-due': { replacement: '/images/blog/stock.webp' } },
};

function run(root, mode) {
  return spawnSync(process.execPath, [SCRIPT, mode, '--root', root], { encoding: 'utf8' });
}

const records = (root) => {
  const dir = path.join(root, 'content/image-credits/blog');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};
const readRecord = (root, key) => JSON.parse(fs.readFileSync(path.join(root, 'content/image-credits/blog', `${key}.json`), 'utf-8'));
const rightsByCover = (root) => {
  const out = {};
  for (const rel of ['content/seo/seo-blog-5.ts', 'content/seo/seo-blog-ch.ts']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf-8');
    for (const [i, block] of scanSeoImageBlocks(src).entries()) out[`${rel.slice(12)}#${i}:${block.cover}`] = block.rights.length;
  }
  return out;
};

test('--build without curation: credits what it can, strips those literals, and lists what needs a human', () => {
  const root = corpusTree();
  try {
    const result = run(root, '--build');
    assert.equal(result.status, 1, 'pending files keep the build red');
    assert.deepEqual(records(root), ['ch-locarno.json', 'locarno-uno.json', 'ritirato.json'], 'a cover only another article shows is credited too; one no page shows is not');
    assert.equal(readRecord(root, 'locarno-uno').modified, 'cropped');
    assert.equal(readRecord(root, 'ch-locarno').modified, 'resized', '2560×1920 → 1200×900 keeps the shape');
    assert.equal(readRecord(root, 'locarno-uno').fetchedAt, '2026-10-04', 'the snapshot date, not today');
    const needs = result.stderr.split('\n').filter((l) => l.includes('needs a human'));
    assert.equal(needs.length, 4, result.stderr);
    assert.match(result.stderr, /«Patrol Police\.jpg» \(polizia\): restriction:personality/);
    assert.match(result.stderr, /«EHIC Slovenia\.jpg» \(tessera, tessera-due\): licence:GFDL.*decision "replace"/);
    assert.match(result.stderr, new RegExp(`«${NASA.replace(/[.]/g, '\\.')}» \\(nasa\\): licence:OTHER:none`));
    assert.match(result.stderr, /«Lugano prokudin\.jpg» \(prokudin\): size of \/images\/blog\/prokudin\.webp unknown/);
    assert.deepEqual(rightsByCover(root), {
      'seo-blog-5.ts#0:locarno-uno': 0,
      'seo-blog-5.ts#1:locarno-uno': 0, // the article that reuses the credited cover
      'seo-blog-5.ts#2:polizia': 5,
      'seo-blog-5.ts#3:tessera': 5,
      'seo-blog-5.ts#4:nasa': 5,
      'seo-blog-5.ts#5:prokudin': 5,
      'seo-blog-5.ts#6:stock': 5,
      'seo-blog-5.ts#7:ritirato': 0,
      'seo-blog-5.ts#8:tessera-due': 5,
      'seo-blog-ch.ts#0:ch-locarno': 0,
    });
    const check = run(root, '--check');
    assert.equal(check.status, 1);
    assert.equal(check.stderr.split('\n').filter((l) => l.includes('needs a human')).length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--build with curation: every file answered, the replaced cover repointed, --check clean, a rerun writes nothing', () => {
  const root = corpusTree();
  try {
    write(root, OVERRIDES_FILE, JSON.stringify(OVERRIDES, null, 2));
    const result = run(root, '--build');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(records(root), ['ch-locarno.json', 'locarno-uno.json', 'nasa.json', 'polizia.json', 'prokudin.json', 'ritirato.json']);
    const polizia = readRecord(root, 'polizia');
    assert.deepEqual(polizia.restrictions, ['personality']);
    assert.deepEqual(polizia.curation, { by: 'owner', at: '2026-10-05', note: 'Q1: kept' });
    assert.equal(polizia.status, 'ok');
    const nasa = readRecord(root, 'nasa');
    assert.equal(nasa.licence.family, 'pd');
    assert.equal(nasa.author.type, 'Organization');
    assert.deepEqual(nasa.curation, CURATION);
    assert.equal(readRecord(root, 'prokudin').modified, 'cropped', 'from overrides.covers: the webp is on the site side');
    // The GFDL file: no record, and both registry and literal now show the replacement.
    const registry = fs.readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf-8');
    assert.match(registry, /id: 'tessera',[\s\S]*?image: '\/images\/places\/lugano-view\.webp'/);
    const seo = fs.readFileSync(path.join(root, 'content/seo/seo-blog-5.ts'), 'utf-8');
    assert.match(seo, /"url": `\$\{BASE_URL\}\/images\/places\/lugano-view\.webp`/);
    assert.doesNotMatch(seo, /images\/blog\/tessera\.webp/);
    assert.deepEqual(rightsByCover(root), {
      'seo-blog-5.ts#0:locarno-uno': 0,
      'seo-blog-5.ts#1:locarno-uno': 0,
      'seo-blog-5.ts#2:polizia': 0,
      'seo-blog-5.ts#3:null': 5, // now a places image: the site's own claim stays
      'seo-blog-5.ts#4:nasa': 0,
      'seo-blog-5.ts#5:prokudin': 0,
      'seo-blog-5.ts#6:stock': 5,
      'seo-blog-5.ts#7:ritirato': 0,
      'seo-blog-5.ts#8:stock': 5, // its own replacement, a cover that is not Commons
      'seo-blog-ch.ts#0:ch-locarno': 0,
    });
    assert.match(registry, /id: 'tessera-due',[\s\S]*?image: '\/images\/blog\/stock\.webp'/);
    // The declared size follows the new cover when its file is here, and stays when it is not.
    assert.match(seo, /"url": `\$\{BASE_URL\}\/images\/blog\/stock\.webp`,\n {8}"width": 1280,\n {8}"height": 720/);
    assert.match(seo, /"url": `\$\{BASE_URL\}\/images\/places\/lugano-view\.webp`,\n {8}"width": 1200,\n {8}"height": 675/);
    assert.deepEqual(checkTree(root), []);
    assert.equal(run(root, '--check').status, 0);
    const before = fs.statSync(path.join(root, 'content/image-credits/blog/locarno-uno.json')).mtimeMs;
    const again = run(root, '--build');
    assert.equal(again.status, 0);
    assert.match(again.stdout, /0 written, 0 removed; 0 covers repointed in 0 files; 0 literals stripped/);
    assert.equal(fs.statSync(path.join(root, 'content/image-credits/blog/locarno-uno.json')).mtimeMs, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check catches what a hand edit or a later write breaks', () => {
  const root = corpusTree();
  try {
    write(root, OVERRIDES_FILE, JSON.stringify(OVERRIDES, null, 2));
    assert.equal(run(root, '--build').status, 0);
    // A hand-edited record, a re-added claim, a restriction nobody accepted.
    const edited = readRecord(root, 'locarno-uno');
    write(root, 'content/image-credits/blog/locarno-uno.json', JSON.stringify({ ...edited, author: { ...edited.author, name: 'Qualcun altro' } }));
    const seoFile = path.join(root, 'content/seo/seo-blog-ch.ts');
    fs.writeFileSync(seoFile, fs.readFileSync(seoFile, 'utf-8').replace('"@type": "ImageObject",\n        "url"', `"@type": "ImageObject",\n        ${SITE_RIGHTS_ML}"url"`));
    // A later write that brings the replaced cover back, in the registry and in the literal.
    for (const rel of ['content/blog-articles-data.ts', 'content/seo/seo-blog-5.ts']) {
      const file = path.join(root, rel);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('/images/places/lugano-view.webp', '/images/blog/tessera.webp'));
    }
    const overrides = structuredClone(OVERRIDES);
    delete overrides.files['Patrol Police.jpg'].decision;
    overrides.files[NASA].curation = { ...CURATION, note: 'changed later' };
    write(root, OVERRIDES_FILE, JSON.stringify(overrides));
    const problems = checkTree(root).join('\n');
    assert.match(problems, /locarno-uno\.json: disagrees with .*ch-locarno\.json about Commons file «Locarno 1\.jpg»/);
    assert.match(problems, /locarno-uno\.json: differs from a rebuild — run --build/);
    assert.match(problems, /seo-blog-ch\.ts: the literal of credited cover ch-locarno still carries acquireLicensePage/);
    assert.match(problems, /polizia\.json: restrictions personality without the owner's accept-restriction/);
    assert.match(problems, /nasa\.json: curation is not the one in data\/image-credit-overrides\.json/);
    assert.match(problems, /needs a human: «Patrol Police\.jpg» \(polizia\): restriction:personality/);
    assert.match(problems, /registry row tessera still shows replaced cover tessera/);
    assert.match(problems, /seo-blog-5\.ts: a literal still shows replaced cover tessera/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check after a new --fetch: an unchanged file is not a change, a changed one is named by field', () => {
  const root = corpusTree();
  try {
    write(root, OVERRIDES_FILE, JSON.stringify(OVERRIDES, null, 2));
    assert.equal(run(root, '--build').status, 0);
    // The same metadata, read again a month later.
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT_FILE), 'utf-8'));
    write(root, SNAPSHOT_FILE, serializeSnapshot({ ...snapshot, fetchedAt: '2026-11-07' }));
    assert.deepEqual(checkTree(root), [], 'a re-read on another day that finds every file unchanged is clean');
    // Commons relicenses one file and uploads a new version of it.
    const locarno = snapshot.files['Locarno 1.jpg'];
    snapshot.files['Locarno 1.jpg'] = {
      ...locarno,
      revision: '2026-10-20T08:00:00Z',
      meta: { ...locarno.meta, LicenseShortName: 'CC BY-SA 4.0', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', License: 'cc-by-sa-4.0' },
    };
    write(root, SNAPSHOT_FILE, serializeSnapshot({ ...snapshot, fetchedAt: '2026-11-07' }));
    assert.deepEqual(checkTree(root), ['ch-locarno', 'locarno-uno', 'ritirato'].map((key) => (
      `content/image-credits/blog/${key}.json: differs from a rebuild — run --build (commons.revision, licence.name, licence.url)`
    )));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check refuses a malformed curation file before using it', () => {
  const root = corpusTree();
  try {
    write(root, OVERRIDES_FILE, JSON.stringify({
      schema: 1,
      files: {
        'Patrol Police.jpg': { decision: 'maybe', curation: CURATION },
        'EHIC Slovenia.jpg': { decision: 'replace', replacement: 'images/no-leading-slash.webp', curation: CURATION },
        [NASA]: { author: { url: 'https://example.com/me' } },
      },
      covers: { prokudin: { modified: 'squashed' } },
    }));
    const problems = checkTree(root).join('\n');
    assert.match(problems, /files\["Patrol Police\.jpg"\]: decision must be replace or accept-restriction/);
    assert.match(problems, /files\["EHIC Slovenia\.jpg"\]: "replacement" must be a site path under \/images\//);
    assert.match(problems, /: every override needs curation \{ by, at, note \}/);
    assert.match(problems, /author\.url is not an allowed profile URL/);
    assert.match(problems, /covers\["prokudin"\]\.modified must be cropped or resized/);
    assert.equal(run(root, '--build').status, 1, '--build does not apply a malformed curation file');
    assert.deepEqual(records(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--build: a replaced file needs a replacement for each of its covers; an unused one is reported', () => {
  const root = corpusTree();
  try {
    const overrides = structuredClone(OVERRIDES);
    delete overrides.files['EHIC Slovenia.jpg'].replacement; // only tessera-due has its own
    overrides.covers.stock = { replacement: '/images/places/lugano-view.webp' }; // not a Commons cover
    write(root, OVERRIDES_FILE, JSON.stringify(overrides));
    const result = run(root, '--build');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /«EHIC Slovenia\.jpg» \(tessera\): decision "replace" without a replacement for this cover/);
    assert.match(result.stderr, /\(stock\): a replacement for a cover whose Commons file is not replaced/);
    const registry = fs.readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf-8');
    assert.match(registry, /id: 'tessera-due',[\s\S]*?image: '\/images\/blog\/stock\.webp'/, 'the cover with its own replacement is repointed');
    assert.match(registry, /id: 'tessera',[\s\S]*?image: '\/images\/blog\/tessera\.webp'/, 'the one without stays as it is');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--build after a rebase: a cover the generator credited after the snapshot keeps its record', () => {
  const root = corpusTree();
  try {
    write(root, OVERRIDES_FILE, JSON.stringify(OVERRIDES, null, 2));
    // Since C1 the generator writes the record, the map entry and a literal
    // without rights fields for each new Commons cover. Its file may be one the
    // snapshot has never seen.
    const title = 'Gorgier station nov 2020.jpg';
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT_FILE), 'utf-8')).files[title], undefined);
    const registry = path.join(root, 'content/blog-articles-data.ts');
    fs.writeFileSync(registry, fs.readFileSync(registry, 'utf-8').replace('];\n', `${row('generato-dopo', '/images/blog/generato-dopo.webp')}];\n`));
    const map = path.join(root, 'data/blog-images-used.json');
    write(root, 'data/blog-images-used.json', JSON.stringify({ ...JSON.parse(fs.readFileSync(map, 'utf-8')), 'generato-dopo': thumb(title) }));
    const seo = path.join(root, 'content/seo/seo-blog-5.ts');
    fs.writeFileSync(seo, fs.readFileSync(seo, 'utf-8').replace('};\nexport default', `${literal('generato-dopo', '/images/blog/generato-dopo.webp', '')}};\nexport default`));
    write(root, 'public/images/blog/generato-dopo.webp', webpHeader(1200, 675));
    const record = finalizeCreditRecord(acceptCommonsCandidate({ title, ...PROBE.files[title] }, { fetchedAt: '2026-10-06' }).template, { cover: '/images/blog/generato-dopo.webp', modified: 'cropped' });
    writeCreditRecord(root, record);

    assert.equal(run(root, '--build').status, 0);
    assert.deepEqual(readRecord(root, 'generato-dopo'), record, 'the generator\'s record is kept as it is');
    assert.deepEqual(checkTree(root), []);

    fs.rmSync(path.join(root, 'content/image-credits/blog/generato-dopo.json'));
    const result = run(root, '--build');
    assert.equal(result.status, 1, 'without its record the cover needs the metadata');
    assert.match(result.stderr, /«Gorgier station nov 2020\.jpg» \(generato-dopo\): not in the snapshot: run --fetch/);
  } finally {
    fs.rmSync(path.join(root), { recursive: true, force: true });
  }
});

test('--check before the backfill (no snapshot, no curation file) audits the records the generator wrote', () => {
  const root = corpusTree();
  try {
    fs.rmSync(path.join(root, SNAPSHOT_FILE));
    assert.deepEqual(checkTree(root), [], 'no record, nothing to say');
    write(root, 'content/image-credits/blog/locarno-uno.json', JSON.stringify({ schema: 1, cover: '/images/blog/locarno-uno.webp' }));
    assert.match(checkTree(root).join('\n'), /locarno-uno\.json: invalid record/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--fetch follows the API etiquette: ≤50 titles per GET, maxlag, User-Agent, pause, Retry-After', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-fetch-'));
  try {
    const titles = Array.from({ length: 51 }, (_, i) => `Foto ${String(i).padStart(2, '0')}.jpg`);
    write(root, 'content/blog-articles-data.ts', `const RAW_ARTICLES = [\n${titles.map((_, i) => row(`a${i}`, `/images/blog/a${i}.webp`)).join('')}];\n`);
    write(root, 'data/blog-images-used.json', JSON.stringify(Object.fromEntries(titles.map((t, i) => [`a${i}`, upload(t)]))));
    const requests = [];
    const sleeps = [];
    let throttled = false;
    const fetchImpl = async (url, init) => {
      requests.push({ url: new URL(url), headers: init.headers });
      if (!throttled) {
        throttled = true;
        return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '7' : null) }, text: async () => '' };
      }
      const asked = new URL(url).searchParams.get('titles').split('|').map((t) => t.replace(/^File:/, ''));
      const pages = asked.map((t) => (t === 'Foto 03.jpg'
        ? { title: 'File:Foto 03.jpg', missing: true }
        : { pageid: 1, title: `File:${t === 'Foto 01.jpg' ? 'Foto uno.jpg' : t}`, imageinfo: [{ width: 10, height: 10, timestamp: 't', descriptionurl: 'https://commons.wikimedia.org/wiki/File:x', extmetadata: {
          LicenseShortName: { value: t === 'Foto 02.jpg' ? 'CC BY-SA 4.0' : 'CC0' },
          ...(t === 'Foto 02.jpg' ? {
            Artist: { value: 'Mail me: <a href="mailto:jane.doe@example.com">jane.doe@example.com</a>' },
            Attribution: { value: 'jane (at) example (dot) com' },
          } : {}),
        } }] }));
      const redirects = asked.includes('Foto 01.jpg') ? [{ from: 'File:Foto 01.jpg', to: 'File:Foto uno.jpg' }] : [];
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ query: { redirects, pages } }) };
    };
    const result = await fetchSnapshot({ root, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, now: new Date('2026-10-05T08:00:00Z'), log: () => {} });
    assert.deepEqual(result, { titles: 51, requests: 3 });
    assert.deepEqual(requests.map((r) => r.url.searchParams.get('titles').split('|').length), [50, 50, 1], 'the throttled batch is retried whole');
    for (const { url, headers } of requests) {
      assert.equal(url.searchParams.get('maxlag'), '5');
      assert.equal(url.searchParams.get('formatversion'), '2');
      assert.equal(url.searchParams.get('redirects'), '1');
      assert.match(url.searchParams.get('iiprop'), /extmetadata/);
      assert.match(headers['User-Agent'], /^FrontaliereTicino-ImageCredits\/.*https:\/\/frontaliereticino\.ch/);
    }
    assert.ok(sleeps.includes(7000), 'Retry-After honoured');
    assert.ok(sleeps.some((ms) => ms > 1000 && ms <= 1500), `a pause between requests (${sleeps})`);
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT_FILE), 'utf-8'));
    assert.equal(snapshot.fetchedAt, '2026-10-05');
    assert.equal(snapshot.requests, 3);
    assert.deepEqual(snapshot.aliases, { 'Foto 01.jpg': 'Foto uno.jpg' });
    assert.deepEqual(snapshot.files['Foto 03.jpg'], { exists: false });
    assert.equal(snapshot.files['Foto uno.jpg'].meta.LicenseShortName, 'CC0');
    assert.equal(Object.keys(snapshot.files).length, 51);
    // No third party's e-mail address reaches the committed snapshot, and the
    // rule still sees that the author text is an address.
    const raw = fs.readFileSync(path.join(root, SNAPSHOT_FILE), 'utf-8');
    assert.doesNotMatch(raw, /jane|example\.com/);
    assert.match(snapshot.files['Foto 02.jpg'].meta.Artist, /mailto:redacted@example\.invalid">redacted@example\.invalid</);
    assert.equal(snapshot.files['Foto 02.jpg'].meta.Attribution, 'redacted(at)example(dot)invalid');
    const verdict = assessCommonsFile({ title: 'Foto 02.jpg', ...snapshot.files['Foto 02.jpg'] });
    assert.equal(verdict.decision, 'review');
    assert.match(verdict.reasons.join(','), /attribution-needs-curation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--fetch: Retry-After as seconds or as an HTTP date, never NaN, never a stall', () => {
  const now = Date.parse('2026-10-05T08:00:00Z');
  assert.equal(retryAfterSeconds('7', now), 7);
  assert.equal(retryAfterSeconds('Mon, 05 Oct 2026 08:00:30 GMT', now), 30, 'an HTTP date is a moment, not a number');
  assert.equal(retryAfterSeconds('Mon, 05 Oct 2026 07:00:00 GMT', now), 1, 'a date already past still pauses');
  assert.equal(retryAfterSeconds('soon', now), 5);
  assert.equal(retryAfterSeconds(null, now), 5);
  assert.equal(retryAfterSeconds('86400', now), 300, 'capped: a far date cannot stall the run');
});

test('--fetch: a batch also stops before its titles make the URL too long', () => {
  const long = Array.from({ length: 50 }, (_, i) => `${'Ä'.repeat(60)} ${i}.jpg`);
  const batches = titleBatches(long);
  assert.ok(batches.length > 1, 'fifty long names do not fit one request');
  assert.deepEqual(batches.flat(), long, 'every title once, in order');
  for (const batch of batches) assert.ok(encodeURIComponent(batch.map((t) => `File:${t}`).join('|')).length <= 6000);
  assert.deepEqual(titleBatches(Array.from({ length: 51 }, (_, i) => `Foto ${i}.jpg`)).map((b) => b.length), [50, 1], 'short names: 50 per request');
});

test('--build: a curated author replaces a redacted address in the Artist text, so the record validates', () => {
  const root = corpusTree();
  try {
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT_FILE), 'utf-8'));
    snapshot.files['Locarno 1.jpg'].meta.Artist = 'Foto Mario Rossi, contatto redacted@example.invalid';
    write(root, SNAPSHOT_FILE, serializeSnapshot(snapshot));
    const overrides = structuredClone(OVERRIDES);
    overrides.files['Locarno 1.jpg'] = { author: { name: 'Mario Rossi', url: null, type: 'Person' }, curation: CURATION };
    write(root, OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
    const result = run(root, '--build');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const record = readRecord(root, 'locarno-uno');
    assert.equal(record.author.name, 'Mario Rossi');
    assert.equal(record.author.text, null, 'the placeholder is not kept as the author text');
    assert.equal(run(root, '--check').status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── C3: a replaced cover moved to a new Commons cover, `<id>-2.webp` ─────────
//
// A new file name keeps stale CDN copies of the old cover out of the pages.
// The usage map is keyed by the cover, as the generator keys it (there the
// cover is `<id>.webp`): `<id>-2` → the file's URL. That entry is what makes
// the new cover a live Commons cover, so the content gate requires its record.

const NEW_PICK = '1 a gorgier train station 22.jpg';

/** Installs `/images/blog/<id>-2.webp` as Strategy 4 installs a cover: the webp, its record, then its usage-map entry. */
function installC3Cover(root, id, title = NEW_PICK) {
  const key = `${id}-2`;
  const cover = `/images/blog/${key}.webp`;
  write(root, `public${cover}`, webpHeader(1200, 675));
  const verdict = acceptCommonsCandidate({ title, ...PROBE.files[title] }, { fetchedAt: '2026-10-04' });
  assert.equal(verdict.ok, true, verdict.reasons?.join(', '));
  const record = creditRecordForCover(verdict.template, {
    cover,
    original: { width: PROBE.files[title].width, height: PROBE.files[title].height },
    coverSize: { width: 1200, height: 675 },
  });
  writeCreditRecord(root, record);
  const map = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-images-used.json'), 'utf-8'));
  write(root, 'data/blog-images-used.json', JSON.stringify({ ...map, [key]: thumb(title) }));
  return record;
}

/** The owner's Q1 default applied: the restricted file is replaced, and `polizia` gets its own new cover. */
const C3_OVERRIDES = {
  ...OVERRIDES,
  files: { ...OVERRIDES.files, 'Patrol Police.jpg': { decision: 'replace', curation: { by: 'owner', at: '2026-10-05', note: 'Q1: replaced' } } },
  covers: { ...OVERRIDES.covers, polizia: { replacement: '/images/blog/polizia-2.webp' } },
};

/** The content gate's last check, per live Commons cover: does the engine reader find a publishable record? */
const liveCredited = (root) => {
  const reader = corpusCreditReader(root, () => {});
  return liveCommonsCovers(root).map(({ id, title }) => ({ id, title, credited: Boolean(reader.get(`/images/blog/${id}.webp`)) }));
};

test('C3: a restricted cover replaced by a new Commons cover <id>-2.webp is repointed, then credited and checked like any other', () => {
  const root = corpusTree();
  try {
    // C2's state: the restricted file credited with the owner's acceptance.
    write(root, OVERRIDES_FILE, JSON.stringify(OVERRIDES, null, 2));
    assert.equal(run(root, '--build').status, 0);
    assert.ok(records(root).includes('polizia.json'));

    const record = installC3Cover(root, 'polizia');
    write(root, OVERRIDES_FILE, JSON.stringify(C3_OVERRIDES, null, 2));
    const result = run(root, '--build');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /0 written, 1 removed; 1 covers repointed in 2 files; 0 literals stripped/);
    assert.ok(!records(root).includes('polizia.json'), 'the replaced cover loses its record');
    assert.deepEqual(readRecord(root, 'polizia-2'), record, 'the new cover keeps the record it was installed with');
    const registry = fs.readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf-8');
    assert.match(registry, /id: 'polizia',[\s\S]*?image: '\/images\/blog\/polizia-2\.webp'/);
    const seo = fs.readFileSync(path.join(root, 'content/seo/seo-blog-5.ts'), 'utf-8');
    assert.match(seo, /"url": `\$\{BASE_URL\}\/images\/blog\/polizia-2\.webp`,\n {8}"width": 1200,\n {8}"height": 675/);
    assert.equal(rightsByCover(root)['seo-blog-5.ts#2:polizia-2'], 0, 'the literal claims nothing: the record credits the photo');

    // The content gate: a live Commons cover, with a publishable record; the old one is no longer live.
    const live = liveCredited(root);
    assert.deepEqual(live.filter((c) => c.id.startsWith('polizia')), [{ id: 'polizia-2', title: NEW_PICK, credited: true }]);
    assert.deepEqual(live.filter((c) => !c.credited), []);
    assert.deepEqual(checkTree(root), []);

    // A later --build (after a rebase) neither drops nor rewrites it.
    const file = path.join(root, 'content/image-credits/blog/polizia-2.json');
    const before = fs.readFileSync(file, 'utf-8');
    const again = run(root, '--build');
    assert.equal(again.status, 0);
    assert.match(again.stdout, /0 written, 0 removed; 0 covers repointed in 0 files; 0 literals stripped/);
    assert.equal(fs.readFileSync(file, 'utf-8'), before);

    // Once a --fetch has read its file, --build derives the very same record from the snapshot.
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT_FILE), 'utf-8'));
    write(root, SNAPSHOT_FILE, serializeSnapshot({ ...snapshot, files: { ...snapshot.files, [NEW_PICK]: PROBE.files[NEW_PICK] } }));
    const refreshed = run(root, '--build');
    assert.equal(refreshed.status, 0, refreshed.stdout + refreshed.stderr);
    assert.match(refreshed.stdout, /0 written, 0 removed/);
    assert.equal(fs.readFileSync(file, 'utf-8'), before);
    assert.deepEqual(checkTree(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C3: a <id>-2.webp cover that loses its record is caught by the gate and by --build, never published uncredited', () => {
  const root = corpusTree();
  try {
    installC3Cover(root, 'polizia');
    write(root, OVERRIDES_FILE, JSON.stringify(C3_OVERRIDES, null, 2));
    assert.equal(run(root, '--build').status, 0);
    fs.rmSync(path.join(root, 'content/image-credits/blog/polizia-2.json'));
    assert.deepEqual(liveCredited(root).filter((c) => !c.credited).map((c) => c.id), ['polizia-2']);
    const result = run(root, '--build');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /«1 a gorgier train station 22\.jpg» \(polizia-2\): not in the snapshot: run --fetch/);
    assert.match(checkTree(root).join('\n'), /needs a human: «1 a gorgier train station 22\.jpg» \(polizia-2\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
