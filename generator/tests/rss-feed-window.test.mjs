import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSectionFeeds,
  RSS_SECTIONS,
  SEO_ENTRY_WINDOW,
} from '../../engine/rssFeeds.mjs';
import {
  collectSeoEntryIds,
  SEO_ENTRY_WINDOW as FLOOR_SEO_ENTRY_WINDOW,
} from '../../scripts/lib/corpus-floors.mjs';

const LATEST_ID = 'uss-stipendi-minimo-2027';

function longEntry(id, date) {
  return [
    `  'blog-${id}': {`,
    `    "headline": "Headline ${id}",`,
    `    "description": "Description ${id}",`,
    `    "padding": "${'x'.repeat(4300)}",`,
    `    "datePublished": "${date}",`,
    '  },',
  ].join('\n');
}

test('preserva il blocco con successore e include l articolo SEO piu recente', () => {
  assert.equal(SEO_ENTRY_WINDOW, FLOOR_SEO_ENTRY_WINDOW);
  assert.ok(SEO_ENTRY_WINDOW > 5093, 'la soglia deve superare il massimo misurato con margine');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-window-'));
  try {
    fs.mkdirSync(path.join(root, 'content', 'seo'), { recursive: true });
    const source = [
      'export const SEO = {',
      longEntry('precedente', '2026-09-09T10:00:00+00:00'),
      longEntry(LATEST_ID, '2026-09-10T10:00:00+00:00'),
      '};',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'content', 'seo', 'seo-blog.ts'), source);

    const section = { ...RSS_SECTIONS[0], seoFiles: ['seo-blog.ts'] };
    const result = buildSectionFeeds({
      fs,
      path,
      rootDir: root,
      section,
      layout: { seoDir: 'content/seo', localesDir: 'content', slugDir: 'content' },
      repairSerpSnippet: (text) => text,
    });
    const feed = result.feeds.find(([name]) => name === 'rss.xml')?.[1];

    assert.match(feed, new RegExp(LATEST_ID));
    assert.match(feed, /Headline precedente/);
    assert.equal(collectSeoEntryIds(source).size, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
