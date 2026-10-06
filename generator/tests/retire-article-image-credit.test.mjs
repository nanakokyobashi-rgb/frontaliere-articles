/**
 * retire-article-image-credit.test.mjs — ritirare un articolo cancella il
 * credito della sua copertina insieme alla copertina (P14).
 *
 * `scripts/retire-article.mjs` cancella `public/images/blog/<id>.webp` e la
 * sua miniatura. Il record `content/image-credits/blog/<id>.json` descrive
 * proprio quel file: lasciato lì, resterebbe il credito di una copertina che
 * non c'è più, che il sito tira comunque giù col pull del corpus.
 *
 * La copertina però è un FILE, non un articolo: il campo `image` può nominare
 * la copertina di un altro articolo (oggi 10 copertine sono condivise, fra cui
 * `a2-giornico-cantiere-disagi-frontalieri`, riusata da
 * `laccordo-italia-svizzera-del-2020-…`). Una copertina che un altro articolo
 * pubblicato usa ancora, in qualunque sezione, resta per intero: file,
 * miniatura, credito e voce del catalogo del giornalista.
 *
 * Lo script chiama `main()` a fine file e risolve la radice dalla propria
 * posizione, quindi qui gira davvero: copiato con i suoi import in un albero
 * temporaneo, su superfici minime della sezione svizzera.
 *
 * Lancia con:
 *   node --test generator/tests/retire-article-image-credit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeImportClosure } from './lib/reachable-source.mjs';
import { acceptCommonsCandidate, finalizeCreditRecord, writeCreditRecord } from '../scripts/lib/commons-credit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('./fixtures/commons-credit/probe-2026-10-04.snapshot.json', import.meta.url), 'utf-8'));
const LOCALES = ['it', 'en', 'de', 'fr'];
const RETIRED = 'ritirata-ch';
const WINNER = 'vincitore-ch';

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function creditFor(cover) {
  const verdict = acceptCommonsCandidate({ title: 'Locarno 1.jpg', ...SNAPSHOT.files['Locarno 1.jpg'] }, { fetchedAt: '2026-10-04' });
  assert.ok(verdict.ok);
  return finalizeCreditRecord(verdict.template, { cover, modified: 'cropped' });
}

/**
 * Le superfici che il ritiro di un articolo svizzero legge e riscrive, più le
 * copertine, i loro crediti e il catalogo del giornalista.
 *
 * `covers` mappa l'id di un articolo svizzero alla chiave della copertina che
 * il suo `image` dichiara (di default la propria); `swiss` aggiunge articoli
 * svizzeri oltre al ritirato e al vincitore, `frontaliere` articoli del
 * registro frontaliere, entrambi come `{ id, cover }`.
 */
function corpusTree({ credited = true, covers = {}, swiss = [], frontaliere = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-credit-'));
  for (const file of relativeImportClosure(path.join(REPO, 'scripts/retire-article.mjs'))) {
    const rel = path.relative(REPO, file);
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.cpSync(file, path.join(root, rel));
  }
  // D22: the retire path reaches the corpus bootstrap before it can inspect
  // the image-credit surfaces. Keep the activation profile in this isolated
  // fixture so the test reaches its own assertions instead of failing on the
  // committed input lookup.
  write(root, 'generator/data/canton-sections.json', fs.readFileSync(path.join(REPO, 'generator/data/canton-sections.json'), 'utf8'));
  const row = ({ id, cover = id }) => `  {\n    id: '${id}',\n    category: 'news',\n    date: '2026-10-01',\n    image: '/images/blog/${cover}.webp',\n  },\n`;
  const swissRows = [
    { id: RETIRED, cover: covers[RETIRED] ?? RETIRED },
    { id: WINNER, cover: covers[WINNER] ?? WINNER },
    ...swiss,
  ];
  write(root, 'content/blog-articles-data.ts', `export const RAW_ARTICLES = [\n${frontaliere.map(row).join('')}];\n`);
  write(root, 'content/swiss-articles-data.ts', `export const RAW_SWISS_ARTICLES = [\n${swissRows.map(row).join('')}];\n`);
  write(root, 'content/routerSwissData.ts', [
    'export const SWISS_SLUGS = {',
    `  '${RETIRED}': { it: 'ritirata-ch', en: 'retired-ch', de: 'zurueckgezogen-ch', fr: 'retiree-ch' },`,
    `  '${WINNER}': { it: 'vincitore-ch', en: 'winner-ch', de: 'gewinner-ch', fr: 'gagnant-ch' },`,
    '};',
    'export const SWISS_SLUG_FALLBACK_REASONS = {',
    '};',
    '',
  ].join('\n'));
  for (const locale of LOCALES) {
    write(root, `content/blog-meta-ch-${locale}.ts`, [
      'const meta = {',
      `  'blog.article.${RETIRED}.title': 'Ritirata',`,
      `  'blog.article.${WINNER}.title': 'Vincitore',`,
      '};',
      'export default meta;',
      '',
    ].join('\n'));
  }
  write(root, `content/blog-body-ch/it/${RETIRED}.ts`, 'export default "";\n');
  write(root, 'data/blog-images-used.json', JSON.stringify({
    [RETIRED]: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Locarno_1.jpg',
    [WINNER]: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Locarno_1.jpg',
  }, null, 2));
  // Ogni file di copertina esiste, anche quello col nome dell'id che nessun
  // `image` dichiara più: è il caso di un articolo passato a una copertina altrui.
  const keys = new Set([RETIRED, WINNER, ...[...swissRows, ...frontaliere].map((r) => r.cover ?? r.id)]);
  for (const key of keys) {
    write(root, `public/images/blog/${key}.webp`, 'RIFF');
    write(root, `public/images/blog/thumbnails/${key}-480w.webp`, 'RIFF');
    if (credited) writeCreditRecord(root, creditFor(`/images/blog/${key}.webp`));
  }
  write(root, 'public/data/journalist-image-catalog.json', `${JSON.stringify([...keys].map((key) => ({ path: `/images/blog/${key}.webp`, words: [key] })))}\n`);
  return root;
}

function retire(root, ...extra) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/retire-article.mjs'), RETIRED, '--winner', WINNER, ...extra], { cwd: root, encoding: 'utf8' });
}

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const catalogPaths = (root) => JSON.parse(fs.readFileSync(path.join(root, 'public/data/journalist-image-catalog.json'), 'utf-8')).map((e) => e.path);
const coverFiles = (key) => [
  `public/images/blog/${key}.webp`,
  `public/images/blog/thumbnails/${key}-480w.webp`,
  `content/image-credits/blog/${key}.json`,
];

function assertCoverKept(root, key) {
  for (const rel of coverFiles(key)) assert.ok(exists(root, rel), `${rel}: la copertina condivisa doveva restare`);
  assert.ok(catalogPaths(root).includes(`/images/blog/${key}.webp`), `voce di catalogo di ${key} rimossa`);
}

function assertCoverGone(root, key) {
  for (const rel of coverFiles(key)) assert.ok(!exists(root, rel), `${rel} esiste ancora`);
  assert.ok(!catalogPaths(root).includes(`/images/blog/${key}.webp`), `voce di catalogo di ${key} ancora presente`);
}

test('il ritiro cancella il credito della copertina insieme alla copertina', () => {
  const root = corpusTree();
  try {
    const dry = retire(root, '--dry-run');
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, new RegExp(`content/image-credits/blog/${RETIRED}\\.json {2}\\(credito della copertina\\)`), 'il piano elenca il credito accanto agli asset');
    assert.ok(exists(root, `content/image-credits/blog/${RETIRED}.json`), '--dry-run non cancella niente');

    const result = retire(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const rel of [
      `public/images/blog/${RETIRED}.webp`,
      `public/images/blog/thumbnails/${RETIRED}-480w.webp`,
      `content/image-credits/blog/${RETIRED}.json`,
    ]) assert.ok(!exists(root, rel), `${rel} esiste ancora`);
    for (const rel of [
      `public/images/blog/${WINNER}.webp`,
      `content/image-credits/blog/${WINNER}.json`,
    ]) assert.ok(exists(root, rel), `${rel}: la copertina del vincitore e il suo credito restano`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una copertina senza credito si ritira come prima', () => {
  const root = corpusTree({ credited: false });
  try {
    const result = retire(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /credito della copertina/);
    assert.ok(!exists(root, `public/images/blog/${RETIRED}.webp`));
    assert.ok(!exists(root, 'content/image-credits/blog'), 'nessun record creato');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('la voce di catalogo della copertina ritirata se ne va con la copertina', () => {
  const root = corpusTree();
  try {
    const result = retire(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assertCoverGone(root, RETIRED);
    assertCoverKept(root, WINNER);
    assert.doesNotMatch(result.stdout, /conservata/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una copertina condivisa nella stessa sezione resta, e il dry-run lo dice', () => {
  const root = corpusTree({ swiss: [{ id: 'gemella-ch', cover: RETIRED }] });
  try {
    const dry = retire(root, '--dry-run');
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, new RegExp(`copertina ${RETIRED} conservata: usata da gemella-ch`));
    assert.doesNotMatch(dry.stdout, /credito della copertina/, 'il piano non accoda il credito di una copertina in uso');

    const result = retire(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assertCoverKept(root, RETIRED);
    assert.ok(!exists(root, `content/blog-body-ch/it/${RETIRED}.ts`), 'il resto del ritiro avviene comunque');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una copertina condivisa con un articolo dell\'altra sezione resta', () => {
  const root = corpusTree({ frontaliere: [{ id: 'gemella-frontaliere', cover: RETIRED }] });
  try {
    const result = retire(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`copertina ${RETIRED} conservata: usata da gemella-frontaliere`));
    assertCoverKept(root, RETIRED);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ritirare chi riusa la copertina di un altro non tocca nulla dell\'altro', () => {
  // Il caso reale: `laccordo-…` dichiara `image: '/images/blog/a2-giornico-….webp'`.
  const root = corpusTree({ covers: { [RETIRED]: WINNER } });
  try {
    const dry = retire(root, '--dry-run');
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, new RegExp(`copertina ${WINNER} conservata: usata da ${WINNER}`));

    const result = retire(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assertCoverKept(root, WINNER);
    // Il file col nome del ritirato non lo usa nessuno: se ne va come prima.
    assertCoverGone(root, RETIRED);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
