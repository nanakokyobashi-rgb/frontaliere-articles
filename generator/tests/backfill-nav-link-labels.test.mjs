import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  localizeBodySource,
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

const INVENTED_SOURCE = (id) => `const body: Record<string, string> = {\n`
  + `  'blog.article.${id}.body1': '${escapeForSingleQuoteTS(INVENTED_BODY)}',\n`
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
