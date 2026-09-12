import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSectionFeeds,
  RSS_SECTIONS,
} from '../../engine/rssFeeds.mjs';
import {
  collectSeoEntryIds,
  collectSeoEntryMetadata,
} from '../../scripts/lib/corpus-floors.mjs';

const LATEST_ID = 'uss-stipendi-minimo-2027';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function longEntry(id, date) {
  return [
    `  'blog-${id}': {`,
    `    "headline": "Headline ${id}",`,
    `    "description": "Description ${id}",`,
    `    "padding": "${'x'.repeat(7000)}",`,
    `    "datePublished": "${date}",`,
    '  },',
  ].join('\n');
}

test('usa il successore e la fine del sorgente per preservare una coda SEO lunga', () => {
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
    assert.equal(
      collectSeoEntryMetadata(source).get(LATEST_ID)?.datePublished,
      '2026-09-10T10:00:00+00:00',
      'the floor must read fields after the former fixed window as well',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('i pavimenti leggono solo entry reali e il loro span bilanciato', () => {
  const source = [
    'const esempio = `',
    "  'blog-finto': { \"headline\": \"fake template\", \"datePublished\": \"1900-01-01\" },",
    '`;',
    'export const SEO = {',
    '  /*',
    "    'blog-commento': { \"headline\": \"fake comment\", \"datePublished\": \"1900-01-01\" },",
    '  */',
    "  'blog-reale': {",
    '    nested: { braces: true },',
    '    "headline": "Headline reale",',
    '    "datePublished": "2026-09-12T10:00:00+00:00",',
    '  },',
    '};',
    '',
  ].join('\n');

  const metadata = collectSeoEntryMetadata(source);
  assert.deepEqual([...metadata.keys()], ['reale']);
  assert.equal(metadata.get('reale')?.headline, 'Headline reale');
  assert.equal(metadata.get('reale')?.datePublished, '2026-09-12T10:00:00+00:00');
});

test('il producer RSS usa gli stessi span lessicali e bilanciati del floor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-lexical-'));
  try {
    fs.mkdirSync(path.join(root, 'content', 'seo'), { recursive: true });
    const source = [
      'const esempio = `',
      "  'blog-finto-template': { \"headline\": \"Fake template\", \"datePublished\": \"1900-01-01\" },",
      '`;',
      "const fakeString = '\\",
      "  \\'blog-finto-stringa\\': { \"headline\": \"Fake string\", \"datePublished\": \"1900-01-01\" },\\",
      "';",
      'export const SEO = {',
      '  /*',
      "    'blog-finto-commento': { \"headline\": \"Fake comment\", \"datePublished\": \"1900-01-01\" },",
      '  */',
      "\t'blog-reale-rss': {",
      '    "headline": "Headline reale RSS",',
      '    "datePublished": "2026-09-12T10:00:00+00:00",',
      '    nested: { braces: true },',
      '  },',
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
    const feed = result.feeds.find(([name]) => name === 'rss.xml')?.[1] ?? '';

    assert.equal(result.articleCount, 1);
    assert.match(feed, /reale-rss/);
    assert.match(feed, /Headline reale RSS/);
    assert.doesNotMatch(feed, /blog-finto-(?:template|stringa|commento)/);
    assert.doesNotMatch(feed, /Fake (?:template|string|comment)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RSS e floor falliscono chiusi su una entry reale con graffe sbilanciate', () => {
  const source = [
    'export const SEO = {',
    "  'blog-malformato': {",
    '    "headline": "Non chiuso",',
    '    nested: { missing: true,',
    '};',
  ].join('\n');

  assert.throws(() => collectSeoEntryMetadata(source), /graffe sbilanciate/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-unbalanced-'));
  try {
    fs.mkdirSync(path.join(root, 'content', 'seo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'content', 'seo', 'seo-blog.ts'), source);
    assert.throws(
      () => buildSectionFeeds({
        fs,
        path,
        rootDir: root,
        section: { ...RSS_SECTIONS[0], seoFiles: ['seo-blog.ts'] },
        layout: { seoDir: 'content/seo', localesDir: 'content', slugDir: 'content' },
        repairSerpSnippet: (text) => text,
      }),
      /graffe sbilanciate/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validator e renderer leggono fino alla chiusura bilanciata della entry SEO', () => {
  const createArticle = fs.readFileSync(
    path.join(REPO_ROOT, 'generator', 'scripts', 'create-article.mjs'),
    'utf8',
  );
  const ogRenderer = fs.readFileSync(
    path.join(REPO_ROOT, 'engine', 'ogPagesPlugin.ts'),
    'utf8',
  );
  const descriptors = fs.readFileSync(
    path.join(REPO_ROOT, 'engine', 'shared', 'articleSectionDescriptors.ts'),
    'utf8',
  );

  assert.match(createArticle, /findSeoEntryMatches\(src, data\.id, corpusPath\(seoFile\)\)/);
  assert.match(createArticle, /src\.slice\(index, closeIdx \+ 1\)/);
  assert.doesNotMatch(createArticle, /Math\.min\(start \+ 3000/);
  assert.match(ogRenderer, /const e = pos\[i\]\.end;/);
  assert.doesNotMatch(ogRenderer, /Math\.min\(s \+ 3000/);
  assert.match(descriptors, /end: closeIdx \+ 1/);
});
