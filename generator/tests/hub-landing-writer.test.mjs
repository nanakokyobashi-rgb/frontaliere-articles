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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const writer = readFileSync(path.join(ROOT, 'scripts', 'refresh-hub-landing.mjs'), 'utf-8');
const engine = readFileSync(path.join(ROOT, 'engine', 'articlesHubCards.ts'), 'utf-8');

test('the writer goes through the create-or-refresh entry point', () => {
  assert.match(
    writer,
    /ensureArticleHubCards\(html, cards, locale\)/,
    'refresh-hub-landing.mjs must patch through ensureArticleHubCards. '
      + 'replaceArticleHubCards alone returns null on a landing with no marker, '
      + 'and a page this script declines to write is a page nobody writes.',
  );
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
  const m = writer.match(/argOf\('--expect-grid',\s*'([^']*)'\)/);
  assert.ok(m, "could not find the --expect-grid default in refresh-hub-landing.mjs");
  const expected = m[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(
    expected,
    ['frontaliere', 'svizzera'],
    'Both sections must be in EXPECT_GRID. Excusing one is what turned "this section '
      + 'wrote nothing" from a non-zero exit into a green run.',
  );
});

test('the writer covers both sections in the first place', () => {
  for (const name of ['frontaliere', 'svizzera']) {
    assert.ok(
      writer.includes(`name: '${name}'`),
      `SECTIONS is missing "${name}" — EXPECT_GRID cannot catch a section the loop never visits.`,
    );
  }
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
