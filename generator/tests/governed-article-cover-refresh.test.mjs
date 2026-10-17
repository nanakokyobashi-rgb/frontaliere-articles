import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PHARMACY_GUIDE_IDS } from '../scripts/lib/pharmacy-evergreen-guides-content.mjs';
import {
  STATIC_FALLBACK_IMAGE,
  STATIC_FALLBACK_IMAGE_ALT,
} from '../scripts/lib/blog-image-registry.mjs';
import { refreshGovernedArticleCover } from '../scripts/lib/governed-article-cover-refresh.mjs';

const RANKING_ID = 'classifica-dogane-ticino';

function registrySource(ids) {
  return [
    'export const ARTICLES = [',
    ...ids.flatMap((id) => [
      '  {',
      `    id: '${id}',`,
      "    image: '/images/blog/legacy-cover.webp',",
      '  },',
    ]),
    '];',
    '',
  ].join('\n');
}

function seoEntry(id) {
  return [
    `  'blog-${id}': {`,
    '    structuredData: {',
    '      "image": {',
    '        "@type": "ImageObject",',
    '        "url": `${BASE_URL}/images/blog/legacy-cover.webp`,',
    '        "width": 1200,',
    '        "height": 675,',
    '        "caption": "Legacy cover"',
    '      },',
    '      "datePublished": "2026-10-01T12:00:00+00:00"',
    '    }',
    '  },',
  ].join('\n');
}

function seoSource(ids) {
  return [
    "const BASE_URL = 'https://frontaliereticino.ch';",
    'const BLOG_SEO_METADATA = {',
    ...ids.map(seoEntry),
    '};',
    'export default BLOG_SEO_METADATA;',
    '',
  ].join('\n');
}

function write(root, relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test('governed cover refresh migrates the existing ranking and all five pharmacy IDs idempotently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-cover-refresh-'));
  const ids = [RANKING_ID, ...PHARMACY_GUIDE_IDS];
  const frontRegistry = write(root, 'content/blog-articles-data.ts', registrySource([RANKING_ID]));
  const swissRegistry = write(root, 'content/swiss-articles-data.ts', registrySource(PHARMACY_GUIDE_IDS));
  const frontSeo = write(root, 'content/seo/seo-blog-5.ts', seoSource([RANKING_ID]));
  const swissSeo = write(root, 'content/seo/seo-blog-ch.ts', seoSource(PHARMACY_GUIDE_IDS));
  const staged = new Map();
  const writes = [];
  const readFile = (file) => staged.get(file) ?? fs.readFileSync(file, 'utf8');
  const writeFile = (file, content) => {
    writes.push(file);
    staged.set(file, content);
  };

  try {
    const refreshAll = () => ids.map((articleId) => {
      const pharmacy = PHARMACY_GUIDE_IDS.includes(articleId);
      return refreshGovernedArticleCover({
        repoRoot: root,
        articleId,
        imagePath: STATIC_FALLBACK_IMAGE,
        caption: pharmacy ? STATIC_FALLBACK_IMAGE_ALT.it : 'Classifica dei valichi ticinesi',
        section: pharmacy ? 'svizzera' : 'frontaliere',
        registryFiles: pharmacy
          ? [{ path: 'data/swiss-articles-data.ts', section: 'svizzera' }]
          : ['data/blog-articles-data.ts'],
        readFile,
        writeFile,
      });
    });

    const first = refreshAll();
    assert.ok(first.every((result) => result.changed));
    assert.equal(writes.length, 12, 'ogni ID governa registry e JSON-LD');
    assert.equal(staged.size, 4, 'le modifiche restano staged nei due registry e nei due file SEO');

    const second = refreshAll();
    assert.ok(second.every((result) => !result.changed), 'un secondo passaggio non deve riscrivere');
    assert.equal(writes.length, 12, 'il passaggio idempotente non deve invocare il writer');

    for (const file of [frontRegistry, swissRegistry]) {
      const source = staged.get(file);
      assert.equal((source.match(new RegExp(STATIC_FALLBACK_IMAGE.replaceAll('/', '\\/'), 'g')) || []).length,
        file === frontRegistry ? 1 : PHARMACY_GUIDE_IDS.length);
    }
    for (const file of [frontSeo, swissSeo]) {
      const source = staged.get(file);
      assert.equal((source.match(/\$\{BASE_URL\}\/images\/places\/lugano-view\.webp/g) || []).length,
        file === frontSeo ? 1 : PHARMACY_GUIDE_IDS.length);
    }
    assert.ok(staged.get(swissSeo).includes(JSON.stringify(STATIC_FALLBACK_IMAGE_ALT.it)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('governed cover refresh fails closed before staging when an existing SEO entry is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-cover-fail-closed-'));
  let writes = 0;
  try {
    write(root, 'content/blog-articles-data.ts', registrySource([RANKING_ID]));
    write(root, 'content/seo/seo-blog-5.ts', seoSource([]));
    assert.throws(
      () => refreshGovernedArticleCover({
        repoRoot: root,
        articleId: RANKING_ID,
        imagePath: STATIC_FALLBACK_IMAGE,
        caption: 'Classifica dei valichi ticinesi',
        registryFiles: ['data/blog-articles-data.ts'],
        writeFile: () => { writes += 1; },
      }),
      /has no SEO entry/u,
    );
    assert.equal(writes, 0, 'preflight deve impedire una migrazione parziale del registry');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
