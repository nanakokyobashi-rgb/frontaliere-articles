/**
 * find-dirty-content-ids.test.mjs — la logica pura del rilevatore di articoli
 * il cui corpus porta ancora un control character C0 (issue #67, dopo #65).
 *
 * PROPRIETA' DIFESE:
 *   - il nome della directory del corpo (`blog-body` / `blog-body-ch`) decide
 *     la sezione (frontaliere/svizzera): sbagliarlo dispatcherebbe il backfill
 *     sulla sezione sbagliata;
 *   - un chunk meta associa l'id alla RIGA (chiave `blog.article.<id>.<campo>`),
 *     non al file: un file con piu' articoli non deve marcarli tutti sporchi
 *     per colpa di uno solo;
 *   - un chunk SEO associa l'id al BLOCCO che lo precede (`'blog-<id>': {`):
 *     una riga sporca prima di qualunque chiave di record non ha un id certo
 *     e va ignorata piuttosto che attribuita al blocco sbagliato;
 *   - l'ordinamento e il cap sono deterministici (sezione, poi id): niente
 *     priorita' di data, e' un backlog storico non un evento fresco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sectionForBodyDir,
  extractMetaArticleId,
  extractSeoBlockKey,
  dirtyIdsInMetaText,
  dirtyIdsInSeoText,
  scanContentForDirtyIds,
  orderAndCap,
} from '../../scripts/find-dirty-content-ids.mjs';

test('sectionForBodyDir mappa le due directory dei corpi, null altrove', () => {
  assert.equal(sectionForBodyDir('blog-body'), 'frontaliere');
  assert.equal(sectionForBodyDir('blog-body-ch'), 'svizzera');
  assert.equal(sectionForBodyDir('blog-meta'), null);
});

test('extractMetaArticleId legge l\'id dalla chiave, ignora righe senza quella forma', () => {
  assert.equal(
    extractMetaArticleId("    'blog.article.trump-intesa-o-inferno.title': 'Trump: ...',"),
    'trump-intesa-o-inferno',
  );
  assert.equal(extractMetaArticleId("    canonicalPath: '/articoli-frontaliere/foo/',"), null);
  assert.equal(extractMetaArticleId(''), null);
});

test('extractSeoBlockKey riconosce blog- e swiss-, non altre chiavi', () => {
  assert.deepEqual(extractSeoBlockKey("  'blog-lavena-ponte-tresa-territorio-poroso': {"), {
    section: 'frontaliere',
    id: 'lavena-ponte-tresa-territorio-poroso',
  });
  assert.deepEqual(extractSeoBlockKey("  'swiss-credito-imposta-frontalieri-2026': {"), {
    section: 'svizzera',
    id: 'credito-imposta-frontalieri-2026',
  });
  assert.equal(extractSeoBlockKey("  title: 'qualcosa',"), null);
});

test('dirtyIdsInMetaText marca solo le righe con un C0 illegale, dedup per id', () => {
  const text = [
    "export default {",
    "  'blog.article.pulito.title': 'Titolo pulito',",
    "  'blog.article.trump-intesa-o-inferno.title': 'Trump: \"Intesa o sar\x170 l\\'inferno\"',",
    "  'blog.article.trump-intesa-o-inferno.excerpt': 'spostato a marted\x088',",
    "};",
  ].join('\n');
  const ids = dirtyIdsInMetaText(text);
  assert.deepEqual([...ids].sort(), ['trump-intesa-o-inferno']);
});

test('dirtyIdsInSeoText attribuisce la riga sporca al blocco che la precede', () => {
  const text = [
    "export default {",
    " 'blog-pulito': {",
    "  title: 'Titolo pulito',",
    " },",
    " 'blog-lavena-ponte-tresa-territorio-poroso': {",
    "  title: 'Il \x083territorio poroso\x083 tra Varese e la Svizzera',",
    " },",
    " 'swiss-credito-imposta-frontalieri-2026': {",
    "  description: 'testo pulito',",
    " },",
    "};",
  ].join('\n');
  const found = dirtyIdsInSeoText(text);
  assert.deepEqual(found, [{ section: 'frontaliere', id: 'lavena-ponte-tresa-territorio-poroso' }]);
});

test('dirtyIdsInSeoText ignora una riga sporca prima di qualunque chiave di record', () => {
  const text = ["export default {", "  title: 'sporco \x08qui',", " 'blog-x': {", "  title: 'pulito',", " },", "};"].join('\n');
  assert.deepEqual(dirtyIdsInSeoText(text), []);
});

test('orderAndCap e\' deterministico (sezione poi id) e rispetta il cap', () => {
  const ids = [
    { section: 'frontaliere', id: 'zebra' },
    { section: 'svizzera', id: 'alfa' },
    { section: 'frontaliere', id: 'alfa' },
  ];
  const { selected, leftover } = orderAndCap(ids, 2);
  assert.deepEqual(selected, [
    { section: 'frontaliere', id: 'alfa' },
    { section: 'frontaliere', id: 'zebra' },
  ]);
  assert.deepEqual(leftover, [{ section: 'svizzera', id: 'alfa' }]);
});

test('orderAndCap con cap non numerico usa il default (10), non lo tronca a zero', () => {
  const ids = Array.from({ length: 3 }, (_, i) => ({ section: 'frontaliere', id: `id-${i}` }));
  const { selected, leftover } = orderAndCap(ids, 'not-a-number');
  assert.equal(selected.length, 3);
  assert.equal(leftover.length, 0);
});

// ── scanContentForDirtyIds: fixture su disco (unico punto che tocca fs) ────

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

test('scanContentForDirtyIds copre le tre superfici e deduplica per (sezione, id)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-content-ids-'));
  try {
    writeTree(root, {
      'content/blog-body/de/hirte-werden-tessin.ts': "export const body = 'Ein Hirte \x00werden';\n",
      'content/blog-body/fr/pulito.ts': "export const body = 'tout va bien';\n",
      'content/blog-body-ch/de/credito-imposta-frontalieri-2026.ts':
        "export const body = 'Text mit C0 \x06 hier';\n",
      'content/blog-meta-it.ts':
        "export default {\n  'blog.article.trump-intesa-o-inferno.title': 'sar\x170',\n};\n",
      'content/blog-meta-en.ts': "export default {\n  'blog.article.pulito.title': 'clean',\n};\n",
      'content/seo/seo-blog-3.ts':
        "export default {\n 'blog-lavena-ponte-tresa-territorio-poroso': {\n  title: 'Il \x083territorio\x083',\n },\n};\n",
    });

    const { ids, totalFiles, totalOccurrences } = scanContentForDirtyIds(root);
    const keys = ids.map((e) => `${e.section}:${e.id}`).sort();
    assert.deepEqual(keys, [
      'frontaliere:hirte-werden-tessin',
      'frontaliere:lavena-ponte-tresa-territorio-poroso',
      'frontaliere:trump-intesa-o-inferno',
      'svizzera:credito-imposta-frontalieri-2026',
    ]);
    assert.equal(totalFiles, 4); // il body pulito e il meta pulito non contano
    assert.ok(totalOccurrences >= 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanContentForDirtyIds su un content/ senza corpi sporchi ritorna vuoto, non lancia', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-content-ids-empty-'));
  try {
    writeTree(root, { 'content/blog-body/it/pulito.ts': "export const body = 'ok';\n" });
    const { ids, totalFiles, totalOccurrences } = scanContentForDirtyIds(root);
    assert.deepEqual(ids, []);
    assert.equal(totalFiles, 0);
    assert.equal(totalOccurrences, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
