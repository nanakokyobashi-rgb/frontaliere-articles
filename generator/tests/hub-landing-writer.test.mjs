/**
 * The hub-landing writer must be able to CREATE, not only refresh. Run with
 * `node --test`.
 *
 * Between 2026-07-29 and 2026-08-05 nobody wrote `/articoli-svizzera/` or its
 * three locale twins. Not a bug on either side — a gap between them:
 *
 *   - main is not on the serving path for these prefixes. Its
 *     `scripts/lib/deploy-shard-sections.sh` excludes both article sections
 *     from the shard push loop unconditionally, so whatever that build emits
 *     for them never reaches the shard the Worker serves.
 *   - this repo would not write them. `refresh-hub-landing.mjs` could only
 *     SWAP an existing `ssg-article-grid`, and the live svizzera landing (from
 *     main's generic fallback branch, emitted before its hub branch existed)
 *     carried no marker. It logged "nothing to refresh", counted the page as
 *     absent, and exited 0 — and `EXPECT_GRID` excused the section from the
 *     non-zero exit, so the run was green every time.
 *
 * 617 articles behind 9 KB of copy, four locales, nothing red. These tests pin
 * the two properties that make that state unreachable. They are source-level
 * on purpose: `engine/articlesHubCards.ts` is TypeScript and this suite runs
 * under a bare `node --test`, so behavioural coverage of the engine lives in
 * main's vitest (`tests/articles-hub-cards.test.ts`), where the module is the
 * source of truth. What can only be checked HERE is that this repo's writer
 * actually reaches for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS_SECTIONS } from '../../scripts/lib/corpus-sections.mjs';
import { patchHubLandingMetadata, SWISS_HUB_ROOT_SEO_IT } from '../../scripts/lib/hub-landing-meta.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const writer = readFileSync(path.join(ROOT, 'scripts', 'refresh-hub-landing.mjs'), 'utf-8');
const engine = readFileSync(path.join(ROOT, 'engine', 'articlesHubCards.ts'), 'utf-8');
const flatRedirect = readFileSync(path.join(ROOT, 'engine', 'flatHtmlRedirect.ts'), 'utf-8');

test('the writer goes through the create-or-refresh entry point', () => {
  assert.match(
    writer,
    /ensureArticleHubCards\(html, cards, locale\)/,
    'refresh-hub-landing.mjs must patch through ensureArticleHubCards. '
      + 'replaceArticleHubCards alone returns null on a landing with no marker, '
      + 'and a page this script declines to write is a page nobody writes.',
  );
});

test('the writer applies the fast-publish generic-image fallback map to cards', () => {
  assert.match(writer, /argOf\('--released-articles-file', ''\)/);
  assert.match(writer, /imagePostcondition\?\.releasedArticles/);
  assert.match(writer, /rewriteGenericImageRefs\(rewriteBlogImageRefs\(cards\), RELEASED_ARTICLES\)/);
});

test('the writer does not fall back to refresh-only', () => {
  // A regression to `replaceArticleHubCards` would restore the exact silent
  // no-op: null on a marker-less page, "nothing to refresh", exit 0.
  assert.ok(
    !/\breplaceArticleHubCards\b/.test(writer),
    'refresh-hub-landing.mjs still references replaceArticleHubCards — that is the '
      + 'refresh-only path that left /articoli-svizzera/ unwritten for a week.',
  );
});

test('no section is excused from having its landing written', () => {
  // Since C1 the sections come from the core: the --expect-grid default is
  // EVERY active section with a Pages shard, not a hand-written list.
  assert.match(
    writer,
    /argOf\('--expect-grid', SHARD_SECTIONS\.map\(\(section\) => section\.section\)\.join\(','\)\)/,
    "could not find the --expect-grid default (every shard section) in refresh-hub-landing.mjs",
  );
  assert.match(writer, /const SHARD_SECTIONS = CORPUS_SECTIONS\.filter\(\(section\) => section\.shardKey\);/);
  const expected = CORPUS_SECTIONS.filter((section) => section.shardKey).map((section) => section.section).sort();
  assert.deepEqual(
    expected,
    ['frontaliere', 'svizzera'],
    'Both sections must be in EXPECT_GRID. Excusing one is what turned "this section '
      + 'wrote nothing" from a non-zero exit into a green run.',
  );
});

test('the writer covers both sections in the first place', () => {
  // The loop visits SECTIONS, derived from the same SHARD_SECTIONS as EXPECT_GRID,
  // so EXPECT_GRID can never name a section the loop does not visit.
  assert.match(writer, /const SECTIONS = SHARD_SECTIONS\.map\(\(section\) => \(\{\s*name: section\.section,/);
  assert.match(writer, /for \(const section of SECTIONS\)/);
  // A section requested by name that has no Pages shard is an error, not a green no-op.
  assert.match(writer, /refusing to report a no-op as a refresh/);
});

test('the mirrored engine exposes create-or-refresh and keeps its fail-closed contract', () => {
  // engine/ is mirrored from main's packages/articles/engine — this asserts the
  // mirror actually carries the version the writer above depends on, which a
  // manual `workflow_dispatch` mirror can silently lag behind.
  assert.match(engine, /export function ensureArticleHubCards\(/);
  assert.match(
    engine,
    /export const ARTICLE_HUB_SHELL_NAV_OPEN = '<nav class="s-eazYqN">';/,
    'the insert anchor must stay the literal main\'s template emits',
  );
  assert.match(
    engine,
    /export const ARTICLE_HUB_GRID_OPEN = '<div class="ssg-article-grid">';/,
    'the grid marker must stay the literal both emitters agree on',
  );
});

test('the mirrored flat redirect scanner parses unquoted attribute values before self-closing', () => {
  assert.match(flatRedirect, /function isSelfClosingStartTag\(html: string, nameEnd: number, end: number\)/);
  assert.match(
    flatRedirect,
    /selfClosing: !closing && (?:HTML_VOID_ELEMENTS\.has\(name\)\s+&&\s+)?isSelfClosingStartTag\(html, nameEnd, end\)/,
  );
  assert.match(
    flatRedirect,
    /html\[index\] !== '>'|!\/\\s\/\.test\(html\[cursor\]\)/,
    'the unquoted value scanner must consume `/` before deciding self-closing',
  );
  assert.match(flatRedirect, /function skipRawTextElement\(html(?:: string)?, afterOpening: number, name: string\)/);
  assert.match(flatRedirect, /function skipTemplateElement\(html(?:: string)?, afterOpening: number\)/);
  assert.match(
    flatRedirect,
    /function maskInactiveMarkup\(html = ''(?:, options: \{ maskRcdata\?: boolean \} = \{\})?\)/,
  );
  assert.match(flatRedirect, /maskInactiveMarkup\(indexHtml(?:, \{ maskRcdata: true \})?\)/);
  assert.match(flatRedirect, /unquoted attribute(?:-value state| value)|unquoted value/);
});


test('the writer upgrades the stale Italian Switzerland landing head', () => {
  const stale = '<head>'
    + '<title>Articoli Svizzera | Frontaliere Ticino</title>'
    + '<meta name="description" content="Informazioni utili per frontalieri Svizzera-Italia: articoli svizzera.">'
    + '<meta property="og:title" content="Articoli Svizzera | Frontaliere Ticino">'
    + '<meta property="og:description" content="Informazioni utili per frontalieri: articoli svizzera.">'
    + '</head>';
  const patched = patchHubLandingMetadata(stale, 'svizzera', 'it');
  assert.match(patched, new RegExp(`<title>${SWISS_HUB_ROOT_SEO_IT.title}</title>`));
  assert.match(patched, new RegExp(`name="description" content="${SWISS_HUB_ROOT_SEO_IT.description}`));
  assert.match(patched, new RegExp(`property="og:title" content="${SWISS_HUB_ROOT_SEO_IT.title}`));
  assert.match(patched, new RegExp(`property="og:description" content="${SWISS_HUB_ROOT_SEO_IT.ogDescription}`));
  assert.equal(patchHubLandingMetadata(patched, 'svizzera', 'it'), patched, 'patch must be idempotent');
  assert.equal(patchHubLandingMetadata(stale, 'frontaliere', 'it'), stale, 'other sections pass through');
});

test('the metadata patch changes only the active head title', () => {
  const stale = '<!-- <title>Articoli Svizzera | Frontaliere Ticino</title> -->'
    + '<head><template><title>Articoli Svizzera | Frontaliere Ticino</title></template>'
    + '<script>const fake = "<title>Articoli Svizzera | Frontaliere Ticino</title>";</script>'
    + '<title>Articoli Svizzera | Frontaliere Ticino</title></head>';
  const patched = patchHubLandingMetadata(stale, 'svizzera', 'it');
  assert.equal((patched.match(/<title>Articoli sulla Svizzera 2026 \| Frontaliere Ticino<\/title>/g) || []).length, 1);
  assert.equal((patched.match(/<title>Articoli Svizzera \| Frontaliere Ticino<\/title>/g) || []).length, 3);
});

test('the metadata patch scans one real head and leaves inactive/body metadata alone', () => {
  const staleTitle = 'Articoli Svizzera | Frontaliere Ticino';
  const staleDescription = 'Informazioni utili per frontalieri Svizzera-Italia: articoli svizzera.';
  const staleOgDescription = 'Informazioni utili per frontalieri: articoli svizzera.';
  const stale = '<!-- <head><title>' + staleTitle + '</title>'
    + '<meta name="description" content="' + staleDescription + '"></head> -->'
    + '<template data-src=/foo/><head><title>' + staleTitle + '</title>'
    + '<meta name="description" content="' + staleDescription + '"></head></template>'
    + '<head><script>const fake = "</head><meta name=description content=\\"' + staleDescription + '\\">";</script>'
    + '<title>' + staleTitle + '</title>'
    + '<meta name="description" content="' + staleDescription + '">'
    + '<meta property="og:title" content="' + staleTitle + '">'
    + '<meta property="og:description" content="' + staleOgDescription + '">'
    + '<meta data-name="description" data-content="' + staleDescription + '"></head>'
    + '<body><meta name="description" content="' + staleDescription + '"></body>';
  const patched = patchHubLandingMetadata(stale, 'svizzera', 'it');
  assert.equal((patched.match(/<title>Articoli sulla Svizzera 2026 \| Frontaliere Ticino<\/title>/g) || []).length, 1);
  assert.ok(patched.includes('<meta name="description" content="' + SWISS_HUB_ROOT_SEO_IT.description + '">'));
  assert.ok(patched.includes('<meta property="og:title" content="' + SWISS_HUB_ROOT_SEO_IT.title + '">'));
  assert.ok(patched.includes('<meta property="og:description" content="' + SWISS_HUB_ROOT_SEO_IT.ogDescription + '">'));
  assert.ok(patched.includes('<meta data-name="description" data-content="' + staleDescription + '">'));
  assert.ok(patched.includes('<body><meta name="description" content="' + staleDescription + '"></body>'));
});
