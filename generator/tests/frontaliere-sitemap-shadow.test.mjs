/**
 * Frontaliere sitemap canonical-override shadowing (issue #138 item 1). `node --test`.
 *
 * ## The defect
 *
 * `valerielinc-ops/frontaliere-si-o-no#5500` extended the swiss-section
 * canonical-override mechanism to the frontaliere section and consolidated
 * three near-duplicate "piastrellista" articles onto one winner
 * (`frontaliere-piastrellista-ticino-stipendio-requisiti`). The site side was
 * closed, but `scripts/build-api.mjs` — the SOURCE that publishes
 * `sitemap-blog.xml` — kept emitting `<url>` blocks for the two shadowed
 * variants. Their pages stay live on purpose (repo anti-cut rule: no
 * removal, no noindex), but a sitemap `<loc>` whose own page canonicalises
 * elsewhere is a hard CI gate failure downstream ("Sitemap `<loc>` URLs MUST
 * self-canonicalize") — the frontaliere sitemap was shipping exactly that.
 *
 * The swiss section already had the equivalent fix: `build-api.mjs` reads
 * `content/swiss-article-canonical-overrides.json` and folds its keys into
 * `buildSitemap`'s `shadowed` set. `engine/shared/frontaliere-article-canonical-overrides.json`
 * carries the same shape (a flat `overrides` object, shadowed slug -> winner
 * URL) and arrived in this repo via `mirror-articles-engine.yml`, but nothing
 * read it.
 *
 * ## Why this imports scripts/lib/build-sitemap.mjs and not scripts/build-api.mjs
 *
 * `build-api.mjs` dynamically `import()`s this repo's `.ts` content files
 * using extensionless relative specifiers, which only resolve under `tsx`
 * (see that file's own header). `.github/workflows/tests.yml` runs this test
 * file under a bare `node --test` and is deliberately dependency-free — no
 * `npm ci`, no network — because it is the check-run every PR's auto-merge
 * waits on regardless of which path the PR touches. `buildSitemap` itself has
 * no such dependency (see scripts/lib/build-sitemap.mjs), so it was moved out
 * to be importable here directly, with no behaviour change and no tsx
 * subprocess.
 *
 * Measured effect on the live corpus (2026-08-10, `npx -y tsx@4
 * scripts/build-api.mjs`): sitemap-blog.xml went from 3166 to 3164 `<url>`
 * blocks after this fix — the two shadowed piastrellista variants, and only
 * those.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSitemap } from '../../scripts/lib/build-sitemap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OVERRIDES_PATH = path.join(ROOT, 'engine', 'shared', 'frontaliere-article-canonical-overrides.json');

// The pair the fix was measured against. Pinned literally (not re-derived
// from the override file) so a future edit to that file cannot quietly make
// this test vacuous — same posture as the site's own
// swiss-article-canonical-overrides.test.ts, which pins its three pairs the
// same way.
const WINNER_SLUG = 'frontaliere-piastrellista-ticino-stipendio-requisiti';
const SHADOWED_SLUGS = ['lavoro-piastrellista-ticino-frontaliere', 'piastrellista-frontaliere-ticino-guadagno'];

test('engine/shared/frontaliere-article-canonical-overrides.json still shadows the known piastrellista pair', () => {
  const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8')).overrides ?? {};
  for (const slug of SHADOWED_SLUGS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(overrides, slug),
      `${slug} is no longer a key in the overrides file — this test's fixture is now testing nothing`,
    );
    assert.match(overrides[slug], /^https:\/\/frontaliereticino\.ch\//);
    assert.ok(
      overrides[slug].includes(`/${WINNER_SLUG}/`),
      `${slug} does not point at the expected winner ${WINNER_SLUG}`,
    );
  }
  assert.equal(overrides[WINNER_SLUG], undefined, 'the winner slug must not shadow itself');
});

// A tiny fixture registry, independent of the corpus's live content (which
// changes every ~15 minutes via the publishing pipeline). Three articles:
// the two shadowed piastrellista variants, the winner, and one unrelated
// control article that must be unaffected either way.
const meta = {
  'blog.article.shadowed-1.title': 'Shadowed 1',
  'blog.article.shadowed-2.title': 'Shadowed 2',
  'blog.article.winner.title': 'Winner',
  'blog.article.control.title': 'Control',
};
const slugMap = {
  'shadowed-1': { it: SHADOWED_SLUGS[0] },
  'shadowed-2': { it: SHADOWED_SLUGS[1] },
  winner: { it: WINNER_SLUG },
  control: { it: 'un-articolo-qualunque' },
};
const entries = [
  { id: 'shadowed-1', date: '2026-08-09' },
  { id: 'shadowed-2', date: '2026-08-09' },
  { id: 'winner', date: '2026-08-09' },
  { id: 'control', date: '2026-08-09' },
];

test('buildSitemap drops canonical-shadowed frontaliere slugs from sitemap-blog.xml, keeps the winner and unrelated pages', () => {
  const shadowed = new Set(SHADOWED_SLUGS);
  const { xml, count } = buildSitemap(entries, 'frontaliere', slugMap, meta, shadowed);

  for (const slug of SHADOWED_SLUGS) {
    assert.ok(
      !xml.includes(`<loc>https://frontaliereticino.ch/articoli-frontaliere/${slug}/</loc>`),
      `sitemap-blog.xml must not list the shadowed page /${slug}/ as a <loc>`,
    );
  }
  assert.ok(
    xml.includes(`<loc>https://frontaliereticino.ch/articoli-frontaliere/${WINNER_SLUG}/</loc>`),
    'the self-canonical winner must stay listed',
  );
  assert.ok(
    xml.includes('<loc>https://frontaliereticino.ch/articoli-frontaliere/un-articolo-qualunque/</loc>'),
    'an article with no override entry must be unaffected',
  );
  assert.equal(count, entries.length - SHADOWED_SLUGS.length, 'exactly the shadowed pair is de-listed, nothing else');
});

test('buildSitemap with an empty shadow set (pre-fix behaviour) lists all four — proves the fixture actually exercises the filter', () => {
  const { xml, count } = buildSitemap(entries, 'frontaliere', slugMap, meta, new Set());
  for (const slug of SHADOWED_SLUGS) {
    assert.ok(xml.includes(`<loc>https://frontaliereticino.ch/articoli-frontaliere/${slug}/</loc>`));
  }
  assert.equal(count, entries.length);
});

// Regression guard for the actual defect: buildSitemap works fine when given
// the right `shadowed` set, but the bug was that scripts/build-api.mjs never
// built one for the frontaliere call. A source-text check, not an import of
// build-api.mjs itself — that file runs top-level side-effecting code
// (reads content/, writes dist/api/) the moment it is imported, which is not
// something a unit test should trigger. Same posture as this repo's other
// build-api.mjs contract tests (see meta-localized-seo-description.test.mjs).
test('build-api.mjs reads the frontaliere override file and feeds it into the frontaliere buildSitemap call', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-api.mjs'), 'utf-8');

  assert.ok(
    src.includes("'engine', 'shared', 'frontaliere-article-canonical-overrides.json'") ||
      src.includes('engine/shared/frontaliere-article-canonical-overrides.json'),
    "build-api.mjs no longer reads engine/shared/frontaliere-article-canonical-overrides.json — " +
      'the frontaliere sitemap will list shadowed pages again',
  );

  // The frontaliere buildSitemap(...) call must NOT go back to passing only
  // retiredDailyEditions — that was exactly the pre-fix state.
  const callMatch = src.match(/buildSitemap\(\s*ARTICLES,\s*'frontaliere'[^)]*\)/s);
  assert.ok(callMatch, 'could not find the frontaliere buildSitemap(...) call to inspect');
  assert.doesNotMatch(
    callMatch[0],
    /buildSitemap\(\s*ARTICLES,\s*'frontaliere',\s*blogSlugs\.BLOG_SLUGS,\s*metaIt,\s*retiredDailyEditions\s*\)/,
    'the frontaliere call passes ONLY retiredDailyEditions again — canonical-shadowed slugs would leak back into sitemap-blog.xml',
  );
});
