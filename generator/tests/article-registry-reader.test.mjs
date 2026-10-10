import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readTopLevelBoolean,
  readTopLevelString,
  scanTopLevelArticleRecords,
} from '../../scripts/lib/article-registry-reader.mjs';
import { readRegistryEntries } from '../scripts/lib/registry-article-type.mjs';
import { readRegistryCantons, registryEntrySpans } from '../scripts/lib/registry-canton-field.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('lo scanner legge solo i campi top-level di ogni riga del registro', () => {
  const src = `
    const fake = "{ id: 'fake', image: '/images/blog/fake.webp' }";
    // { id: 'commento', image: '/images/blog/commento.webp' }
    const RAW = [
      {
        id: 'reale',
        metadata: {
          image: '/images/blog/nested.webp',
          note: "image: '/images/blog/stringa.webp' }",
        },
        title: "testo con image: '/images/blog/stringa-2.webp' e }",
        image: '/images/blog/reale.webp',
        hasCalculator: true,
      },
      {
        id: "secondo",
        nested: { hasCalculator: true, image: '/images/blog/nested-2.webp' },
        image: "/images/blog/secondo.webp",
        hasCalculator: false,
      },
    ];
  `;

  const records = scanTopLevelArticleRecords(src);
  assert.deepEqual(records.map(({ id }) => id), ['reale', 'secondo']);
  assert.equal(readTopLevelString(records[0], 'image'), '/images/blog/reale.webp');
  assert.equal(readTopLevelString(records[1], 'image'), '/images/blog/secondo.webp');
  assert.equal(readTopLevelBoolean(records[0], 'hasCalculator'), true);
  assert.equal(readTopLevelBoolean(records[1], 'hasCalculator'), false);
});

test('tutti i reader del registry usano lo scanner condiviso', () => {
  const callers = [
    'scripts/build-blog-index.mjs',
    'scripts/backfill-image-credits.mjs',
    'generator/scripts/create-article.mjs',
    'generator/scripts/lib/registry-article-type.mjs',
    'generator/scripts/lib/registry-canton-field.mjs',
  ];
  for (const relative of callers) {
    const src = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(src, /article-registry-reader\.mjs/, relative);
    assert.doesNotMatch(src, /matchAll\(\/image:/, relative);
    assert.doesNotMatch(src, /matchAll\(\/\\{\\s\*id:/, relative);
  }
});

test('i reader di articleType e canton non si fermano su una graffa annidata', () => {
  const src = `const RAW = [{
    id: 'reale',
    metadata: { id: 'annidato', date: '1900-01-01', canton: ['VS'] },
    date: '2026-10-10',
    image: '/images/blog/reale.webp',
    articleType: 'news',
    canton: ['TI'],
  }, {
    id: 'secondo',
    date: '2026-10-09',
    image: '/images/blog/secondo.webp',
  }];`;

  assert.deepEqual(readRegistryEntries(src), [
    { id: 'reale', date: '2026-10-10', articleType: 'news', verifiedAt: undefined },
    { id: 'secondo', date: '2026-10-09', articleType: undefined, verifiedAt: undefined },
  ]);
  assert.equal(registryEntrySpans(src).length, 2);
  assert.deepEqual([...readRegistryCantons(src)], [['reale', ['TI']]]);
});
