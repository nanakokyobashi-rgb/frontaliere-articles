import '../../host/cantonSectionsBootstrap.mjs';

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { RSS_SECTIONS } from '../../engine/rssFeeds.mjs';
import { findAllSeoEntryMatches } from '../../engine/shared/seo-entry.mjs';
import {
  assertSeoEntryAbsent,
  findSeoEntryOccurrences,
} from '../../scripts/lib/seo-entry-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEO_DIR = path.join(ROOT, 'content', 'seo');

function seoChunkRank(name) {
  return name === 'seo-blog.ts' ? 1 : Number(name.match(/-(\d+)\.ts$/)?.[1] || 0);
}

function sorted(names) {
  return [...names].sort((left, right) => seoChunkRank(left) - seoChunkRank(right));
}

function sectionFiles(section) {
  const row = RSS_SECTIONS.find(({ id }) => id === section.id);
  assert.ok(row, `active section ${section.id} must have an RSS publisher row`);
  const files = row.seoFiles
    .map((name) => path.join(SEO_DIR, name))
    .filter((file) => {
      const present = readdirSync(path.dirname(file)).includes(path.basename(file));
      // Canton sections may be active with an intentionally empty corpus and
      // therefore have no SEO chunk yet. Historical sections cannot be empty
      // this way: their chunks are required publisher inputs.
      if (!present && !section.id.startsWith('canton-')) {
        assert.fail(`${section.id}: missing active SEO file ${path.basename(file)}`);
      }
      return present;
    });
  for (const file of files) {
    assert.ok(
      readdirSync(path.dirname(file)).includes(path.basename(file)),
      `${section.id}: missing active SEO file ${path.basename(file)}`,
    );
  }
  return files;
}

test('og/RSS/API SEO surfaces contain each active article id once', () => {
  for (const section of RSS_SECTIONS) {
    const files = sectionFiles(section);
    const expected = section.id === 'frontaliere'
      ? sorted(readdirSync(SEO_DIR).filter((name) => /^seo-blog(?:-\d+)?\.ts$/.test(name)))
      : files.map((file) => path.basename(file));
    assert.deepEqual(
      files.map((file) => path.basename(file)),
      expected,
      `${section.id}: active SEO files have drifted from the publisher list`,
    );

    const occurrences = new Map();
    let totalEntries = 0;
    for (const file of files) {
      const matches = findAllSeoEntryMatches(readFileSync(file, 'utf8'), file);
      totalEntries += matches.length;
      for (const { id } of matches) occurrences.set(id, (occurrences.get(id) || 0) + 1);
    }
    const duplicates = [...occurrences.entries()].filter(([, count]) => count > 1);
    const duplicateEntries = duplicates.reduce((sum, [, count]) => sum + count, 0);
    assert.equal(
      duplicates.length,
      0,
      `${section.id}: ${duplicates.length} id SEO duplicati in ${totalEntries} voci ` +
        `(${duplicateEntries} voci nelle collisioni); ogni consumer attivo deve vedere una sola voce`,
    );
  }
});

test('the append-only writer guard catches a duplicate in another SEO chunk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seo-entry-guard-'));
  const first = path.join(root, 'seo-blog.ts');
  const second = path.join(root, 'seo-blog-5.ts');
  const source = "const SEO = {\n  'blog-duplicato': { title: 'x' },\n};\n";
  writeFileSync(first, source);
  writeFileSync(second, source.replace("title: 'x'", "title: 'y'"));

  assert.deepEqual(findSeoEntryOccurrences('duplicato', [first, second]), [
    { file: first, count: 1 },
    { file: second, count: 1 },
  ]);
  assert.throws(
    () => assertSeoEntryAbsent('duplicato', [first, second]),
    /already exists in .*seo-blog\.ts \(1\).*seo-blog-5\.ts \(1\)/,
  );
});
