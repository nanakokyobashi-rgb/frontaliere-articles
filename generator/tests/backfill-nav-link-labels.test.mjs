import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  localizeBodySource,
  parseArgs,
  runBackfill,
} from '../scripts/backfill-nav-link-labels.mjs';
import { escapeForSingleQuoteTS } from '../scripts/lib/article-meta-block.mjs';

const INVENTED_BODY = [
  '## Articolo inventato',
  '',
  'Questa riga resta identica.',
  '',
  '[calcolatore stipendio netto](nav:calculator "target invariato")',
  '[annunci di lavoro](nav:jobs)',
  '[AVS](nav:pension) [LAMal](nav:health) [LPP](nav:pension)',
  '[etichetta sconosciuta](nav:future)',
  '',
].join('\n');

const INVENTED_SOURCE = (id, body = INVENTED_BODY) => `const body: Record<string, string> = {\n`
  + `  'blog.article.${id}.body1': '${escapeForSingleQuoteTS(body)}',\n`
  + `};\n\nexport default body;\n`;

function maskNavLabels(source) {
  return source.replace(/\[([^\]\n]+)\]\((nav:[^)]+)\)/gu, '[LABEL]($2)');
}

function writeFixture(root, locale) {
  for (const bodyRoot of ['content/blog-body', 'content/blog-body-ch']) {
    fs.mkdirSync(path.join(root, bodyRoot, locale), { recursive: true });
  }
  const file = path.join(root, 'content/blog-body', locale, 'invented-nav.ts');
  fs.writeFileSync(file, INVENTED_SOURCE('invented-nav'), 'utf8');
  return file;
}

function writeArticle(root, locale, id, body) {
  const directory = path.join(root, 'content/blog-body', locale);
  fs.mkdirSync(path.join(root, 'content/blog-body-ch', locale), { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${id}.ts`);
  fs.writeFileSync(file, INVENTED_SOURCE(id, body), 'utf8');
  return file;
}

function fileIds(files) {
  return files.map((file) => path.basename(file, '.ts'));
}

const CURSOR_BODIES = Object.freeze({
  'a-first': [
    '[calcolatore stipendio netto](nav:calculator)',
    '[annunci di lavoro](nav:jobs)',
    '[etichetta sconosciuta](nav:future)',
  ].join('\n'),
  'b-second': [
    '[calcolatore stipendio netto](nav:calculator)',
    '[annunci di lavoro](nav:jobs)',
    '[costo della vita](nav:cost-of-living)',
    '[etichetta sconosciuta](nav:future)',
  ].join('\n'),
  'c-third': [
    '[calcolatore stipendio netto](nav:calculator)',
    '[etichetta sconosciuta](nav:future)',
  ].join('\n'),
  'd-fourth': [
    '[annunci di lavoro](nav:jobs)',
    '[etichetta sconosciuta](nav:future)',
  ].join('\n'),
});

const RESUMABLE_BODIES = Object.freeze({
  'a-first': '[calcolatore stipendio netto](nav:calculator)',
  'b-second': '[annunci di lavoro](nav:jobs)',
  'c-third': '[etichetta sconosciuta](nav:future)',
  'd-fourth': '[costo della vita](nav:cost-of-living)',
});

const OFFSET_BODIES = Object.freeze({
  'a-no-label': 'Testo senza link di navigazione.',
  'b-first': '[calcolatore stipendio netto](nav:calculator)',
  'c-second': '[annunci di lavoro](nav:jobs)',
});

const REPORT_BODIES = Object.freeze({
  'a-known': '[calcolatore stipendio netto](nav:calculator)',
  'b-unmapped': '[etichetta sconosciuta](nav:future)',
  'c-plain': 'Testo senza link di navigazione.',
  'd-known': '[annunci di lavoro](nav:jobs)',
});

test('localizza solo le label nav note e preserva ogni altro byte', () => {
  const source = INVENTED_SOURCE('invented-nav');
  for (const [locale, expectedLabel, expectedAcronyms] of [
    ['de', 'Nettolohnrechner', '[AHV](nav:pension) [KVG](nav:health) [BVG](nav:pension)'],
    ['fr', 'calculateur de salaire net', '[AVS](nav:pension) [LAMal](nav:health) [LPP](nav:pension)'],
    ['en', 'net salary calculator', '[AVS](nav:pension) [LAMal](nav:health) [LPP](nav:pension)'],
  ]) {
    const result = localizeBodySource(source, locale);
    assert.match(result.source, new RegExp(`\\[${expectedLabel}\\]\\(nav:calculator "target invariato"\\)`));
    assert.match(result.source, /\[etichetta sconosciuta\]\(nav:future\)/u);
    assert.match(result.source, new RegExp(expectedAcronyms.replace(/[()[\]]/gu, '\\$&')));
    assert.equal(maskNavLabels(result.source), maskNavLabels(source), locale);
    assert.ok(result.substitutions.length > 0, locale);
    assert.equal(result.source.endsWith('\n'), true, locale);
  }
});

test('dry-run non scrive, apply e seconda esecuzione sono idempotenti', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-nav-'));
  try {
    const files = Object.fromEntries(['de', 'fr', 'en'].map((locale) => [locale, writeFixture(root, locale)]));
    const before = Object.fromEntries(Object.entries(files).map(([locale, file]) => [locale, fs.readFileSync(file, 'utf8')]));

    const dryRun = runBackfill({
      root,
      locales: ['de', 'fr', 'en'],
      apply: false,
      logger: () => {},
    });
    assert.equal(dryRun.modifiedFiles.length, 0);
    assert.deepEqual(
      Object.fromEntries(Object.entries(files).map(([locale, file]) => [locale, fs.readFileSync(file, 'utf8')])),
      before,
    );

    const applied = runBackfill({
      root,
      locales: ['de', 'fr', 'en'],
      apply: true,
      logger: () => {},
    });
    assert.equal(applied.modifiedFiles.length, 3);
    assert.equal(applied.reports.every((report) => report.after.left === 1), true);

    const second = runBackfill({
      root,
      locales: ['de', 'fr', 'en'],
      apply: true,
      logger: () => {},
    });
    assert.equal(second.modifiedFiles.length, 0);
    assert.equal(fs.readFileSync(files.de, 'utf8').includes('[AHV](nav:pension)'), true);
    assert.equal(fs.readFileSync(files.fr, 'utf8').includes('[AVS](nav:pension)'), true);
    assert.equal(fs.readFileSync(files.en, 'utf8').includes('[AVS](nav:pension)'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il cursore alfabetico completa i lotti senza saltare articoli dopo il primo apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-nav-cursor-'));
  try {
    for (const [id, body] of Object.entries(RESUMABLE_BODIES)) writeArticle(root, 'de', id, body);

    const first = runBackfill({
      root,
      locales: ['de'],
      apply: true,
      limit: 2,
      logger: () => {},
    });
    assert.deepEqual(fileIds(first.modifiedFiles), ['a-first', 'b-second']);
    assert.equal(first.reports[0].lastExaminedId, 'b-second');
    assert.ok(first.reports[0].before.italianLabels > first.reports[0].after.italianLabels);

    const second = runBackfill({
      root,
      locales: ['de'],
      apply: true,
      limit: 2,
      startAfter: 'b-second',
      logger: () => {},
    });
    assert.deepEqual(fileIds(second.modifiedFiles), ['d-fourth']);
    assert.equal(second.reports[0].examined, 2);
    assert.equal(second.reports[0].modified, 1);
    assert.equal(second.reports[0].unmapped, 1);
    assert.equal(second.reports[0].lastExaminedId, 'd-fourth');
    assert.deepEqual(
      [...first.modifiedFiles, ...second.modifiedFiles].map((file) => path.basename(file, '.ts')).sort(),
      Object.keys(RESUMABLE_BODIES).filter((id) => id !== 'c-third').sort(),
    );
    assert.match(fs.readFileSync(path.join(root, 'content/blog-body/de/c-third.ts'), 'utf8'), /\[etichetta sconosciuta\]\(nav:future\)/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start-after inesistente fallisce prima di qualsiasi scrittura', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-nav-cursor-invalid-'));
  try {
    const file = writeArticle(root, 'de', 'present-article', CURSOR_BODIES['a-first']);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(
      () => runBackfill({
        root,
        locales: ['de'],
        apply: true,
        startAfter: 'missing-article',
        logger: () => {},
      }),
      /id non trovato nel corpus/u,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('l’ordine per hit vieta i cursori start-after e offset', () => {
  assert.throws(
    () => parseArgs(['--order', 'hits', '--start-after', 'present-article']),
    /--order hits.*--start-after.*stabile/u,
  );
  assert.throws(
    () => parseArgs(['--order', 'hits', '--offset', '1']),
    /--order hits.*--offset.*stabile/u,
  );
});

test('offset riprende nello stesso ordine alfabetico anche dopo che i conteggi cambiano', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-nav-offset-'));
  try {
    for (const [id, body] of Object.entries(OFFSET_BODIES)) writeArticle(root, 'de', id, body);
    const result = runBackfill({
      root,
      locales: ['de'],
      apply: true,
      offset: 1,
      limit: 1,
      logger: () => {},
    });
    assert.deepEqual(fileIds(result.modifiedFiles), ['b-first']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il report conta esaminati, modificati, articoli senza mappa e cursore di ripresa', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-nav-report-'));
  const logs = [];
  try {
    for (const [id, body] of Object.entries(REPORT_BODIES)) writeArticle(root, 'de', id, body);
    const result = runBackfill({
      root,
      locales: ['de'],
      apply: true,
      limit: 5,
      logger: (line) => logs.push(line),
    });
    const [report] = result.reports;
    assert.equal(report.examined, 4);
    assert.equal(report.modified, 2);
    assert.equal(report.unmapped, 1);
    assert.equal(report.unmappedLabels, 1);
    assert.equal(report.lastExaminedId, 'd-known');
    assert.deepEqual(fileIds(result.modifiedFiles), ['a-known', 'd-known']);
    assert.match(logs.join('\n'), /esaminati 4; modificati 2; senza voce in mappa 1/u);
    assert.match(logs.join('\n'), /ultimo ID esaminato: d-known/u);
    assert.match(logs.join('\n'), /--start-after d-known/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un’interruzione a metà lotto è riprendibile senza doppie scritture né perdita di label', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-nav-interrupted-'));
  try {
    writeArticle(root, 'de', 'a-first', CURSOR_BODIES['a-first']);
    writeArticle(root, 'de', 'b-second', CURSOR_BODIES['b-second']);
    const firstSuccessfulWrites = [];
    let writeCalls = 0;
    assert.throws(
      () => runBackfill({
        root,
        locales: ['de'],
        apply: true,
        limit: 2,
        writeFile: (filePath, before, after) => {
          writeCalls += 1;
          if (writeCalls === 2) throw new Error('interruzione inventata');
          assert.notEqual(before, after);
          fs.writeFileSync(filePath, after, 'utf8');
          firstSuccessfulWrites.push(filePath);
        },
        logger: () => {},
      }),
      /interruzione inventata/u,
    );
    assert.deepEqual(fileIds(firstSuccessfulWrites), ['a-first']);

    const resumedWrites = [];
    const resumed = runBackfill({
      root,
      locales: ['de'],
      apply: true,
      limit: 2,
      writeFile: (filePath, before, after) => {
        assert.notEqual(before, after);
        fs.writeFileSync(filePath, after, 'utf8');
        resumedWrites.push(filePath);
      },
      logger: () => {},
    });
    assert.deepEqual(fileIds(resumed.modifiedFiles), ['b-second']);
    assert.deepEqual(fileIds(resumedWrites), ['b-second']);
    assert.equal(new Set([...firstSuccessfulWrites, ...resumedWrites]).size, 2);
    assert.match(fs.readFileSync(firstSuccessfulWrites[0], 'utf8'), /\[Nettolohnrechner\]\(nav:calculator\)/u);
    assert.match(fs.readFileSync(resumedWrites[0], 'utf8'), /\[Nettolohnrechner\]\(nav:calculator\)/u);
    assert.match(fs.readFileSync(firstSuccessfulWrites[0], 'utf8'), /\[etichetta sconosciuta\]\(nav:future\)/u);
    assert.match(fs.readFileSync(resumedWrites[0], 'utf8'), /\[etichetta sconosciuta\]\(nav:future\)/u);

    const replayWrites = [];
    const replay = runBackfill({
      root,
      locales: ['de'],
      apply: true,
      limit: 2,
      writeFile: (filePath) => replayWrites.push(filePath),
      logger: () => {},
    });
    assert.equal(replay.modifiedFiles.length, 0);
    assert.equal(replayWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
