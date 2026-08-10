/**
 * RSS `<guid>` stability across slug renames (issue #162, follow-up to #159).
 * `node --test`.
 *
 * `engine/rssFeeds.mjs` used to build `<guid isPermaLink="true">` from the
 * article's current slug — the same value as `<link>`. Renaming a slug (e.g.
 * dropping a placeholder like `slug-traffico-da-record`, tracked in #138 §2)
 * therefore changed the guid too, which re-presents the item as a "new" post
 * to every existing RSS subscriber even though nothing about the article
 * itself changed. `articleId` is permanent for the article's lifetime and
 * never renamed, so the guid is now built from it instead — `<link>` still
 * tracks the current (renameable) slug, since that one has to resolve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSectionFeeds, RSS_SECTIONS } from '../../engine/rssFeeds.mjs';

const SECTION = RSS_SECTIONS.find((s) => s.id === 'frontaliere');
const SEO_FILE = path.join('services/seo', SECTION.seoFiles[0]);
const SLUG_FILE = SECTION.slugFile;
const IT_FEED = SECTION.feedFile('it');

function seoSource(articleId) {
  return `export default {
  'blog-${articleId}': {
    "headline": "Test headline",
    "description": "Test description",
    "datePublished": "2026-08-01T00:00:00.000Z",
    "articleSection": "Notizie",
  },
};
`;
}

function slugSource(articleId, itSlug) {
  return `export const BLOG_SLUGS = {
 '${articleId}': { it: '${itSlug}', en: 'x', de: 'y', fr: 'z' },
};
`;
}

function buildFeedXml(articleId, itSlug) {
  const files = new Map([
    [SEO_FILE, seoSource(articleId)],
    [SLUG_FILE, slugSource(articleId, itSlug)],
  ]);
  const fakeFs = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    readdirSync: () => [],
  };

  const { feeds } = buildSectionFeeds({
    fs: fakeFs,
    path,
    rootDir: '',
    section: SECTION,
    registry: [],
    repairSerpSnippet: (s) => s,
  });

  const [, xml] = feeds.find(([filename]) => filename === IT_FEED);
  return xml;
}

test('guid survives a slug rename (built from articleId, not slug)', () => {
  const before = buildFeedXml('my-article', 'slug-before-rename');
  const after = buildFeedXml('my-article', 'slug-after-rename');

  const guidBefore = before.match(/<guid[^>]*>([^<]+)<\/guid>/)[1];
  const guidAfter = after.match(/<guid[^>]*>([^<]+)<\/guid>/)[1];
  const linkBefore = before.match(/<link>([^<]+)<\/link>/g).at(-1);
  const linkAfter = after.match(/<link>([^<]+)<\/link>/g).at(-1);

  assert.equal(guidBefore, guidAfter, 'guid must not change when only the slug changes');
  assert.match(guidBefore, /my-article/, 'guid should carry the stable articleId');
  assert.doesNotMatch(guidBefore, /slug-before-rename/, 'guid must not carry the slug');

  assert.notEqual(linkBefore, linkAfter, 'link should still track the current slug');
  assert.match(linkBefore, /slug-before-rename/);
  assert.match(linkAfter, /slug-after-rename/);

  assert.match(before, /<guid isPermaLink="false">/, 'guid is no longer a real permalink');
});
