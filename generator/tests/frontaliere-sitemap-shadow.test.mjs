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

// Same class of defect, second surface: `collect()` (build-api.mjs) emits
// sitemap-news-candidates.xml for BOTH sections and applied no shadowing at
// all — a canonical-shadowed article still inside the 48h Google News window
// would list its own now-superseded page as a news candidate, the same
// self-canonical violation this file's sitemap-blog.xml tests guard against.
// Source-text check for the same reason as above: build-api.mjs cannot be
// imported by a unit test.
test('build-api.mjs feeds the shadow sets into both collect(...) calls that build sitemap-news-candidates.xml', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-api.mjs'), 'utf-8');

  const frontaliereCall = src.match(/collect\(\s*ARTICLES,\s*'frontaliere'[^)]*\)/s);
  assert.ok(frontaliereCall, 'could not find the frontaliere collect(...) call to inspect');
  assert.match(
    frontaliereCall[0],
    /,\s*frontaliereSitemapShadow\s*\)/,
    'the frontaliere collect(...) call no longer passes frontaliereSitemapShadow — canonical-shadowed ' +
      'frontaliere pages could leak back into sitemap-news-candidates.xml while still inside the 48h window',
  );

  const svizzeraCall = src.match(/collect\(\s*SWISS_ARTICLES,\s*'svizzera'[^)]*\)/s);
  assert.ok(svizzeraCall, 'could not find the svizzera collect(...) call to inspect');
  assert.match(
    svizzeraCall[0],
    /,\s*shadowedSwissSlugs\s*\)/,
    'the svizzera collect(...) call no longer passes shadowedSwissSlugs — canonical-shadowed swiss pages ' +
      'could leak back into sitemap-news-candidates.xml while still inside the 48h window',
  );
});

// ── The other half of the contract: where the shadowing deliberately STOPS ──
//
// The two tests below pin a NEGATIVE, which is unusual and is the point. The
// shadowing rule is narrow — "a sitemap <loc> whose page canonicalises elsewhere
// is a hard CI gate failure" (scripts/audit-sitemap-canonicals.mjs,
// scripts/validate-sitemap-pages.mjs) — and it applies to sitemaps only. RSS and
// news-ticker-live.json are not sitemaps and no gate reads them.
//
// Without these tests that scope lives only in a `_doc` string inside two JSON
// files that no reader parses, so it reads as an oversight from the code alone:
// PR #152's own automated review raised "filter the RSS registries" and "filter
// the ticker input" as two 🔴 Important findings on exactly that reading. Pinning
// the boundary turns a decision nobody can see into one that fails loudly when
// changed by accident — and tells whoever changes it on purpose where to go.
const SWISS_OVERRIDES_PATH = path.join(ROOT, 'content', 'swiss-article-canonical-overrides.json');

test('both canonical-override files still declare the sitemap-only scope (RSS explicitly excluded)', () => {
  const frontaliereDoc = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8'))._doc ?? '';
  const swissDoc = JSON.parse(fs.readFileSync(SWISS_OVERRIDES_PATH, 'utf-8'))._doc ?? '';

  assert.match(
    swissDoc,
    /RSS[\s\S]{0,40}?is NOT touched/i,
    'content/swiss-article-canonical-overrides.json no longer documents that RSS is out of scope — ' +
      'if the policy really changed, update scripts/build-api.mjs (and engine/rssFeeds.mjs, which owns ' +
      'the item list for BOTH callers) in the same change; if it did not, restore the sentence',
  );
  // ...and the news sitemap explicitly IS in scope. This is the line that gives
  // the round-1 fix of this PR (shadowing sitemap-news-candidates.xml) a written
  // mandate, and it is what separates that surface from RSS and the ticker: a
  // news sitemap is a sitemap.
  assert.match(
    swissDoc,
    /sitemap-news\.xml/i,
    'the swiss override file no longer names the news sitemap as a de-listing target — that sentence is ' +
      'the stated basis for shadowing sitemap-news-candidates.xml in scripts/build-api.mjs',
  );
  assert.match(
    frontaliereDoc,
    /RSS is NOT touched/i,
    'engine/shared/frontaliere-article-canonical-overrides.json no longer documents that RSS is out of ' +
      'scope — same instruction as above. NB: this file is mirrored from the site ' +
      '(packages/articles/engine/shared/), so it is edited THERE, not here',
  );
  // The positive half of the same sentence: the sitemap IS in scope. If this
  // disappears, the four sitemap tests above are asserting a rule nothing claims.
  assert.match(
    frontaliereDoc,
    /not advertised in a sitemap/i,
    'the frontaliere override file no longer states that shadowed slugs are de-listed from the sitemap — ' +
      'the shadowing tests above would be pinning behaviour with no stated contract behind it',
  );
});

test('build-api.mjs passes the UNFILTERED registries to the RSS builder and to the ticker (sitemap-only scope)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-api.mjs'), 'utf-8');

  const rssCall = src.match(/buildAllRssFeeds\(\{[\s\S]*?\n\}\);/);
  assert.ok(rssCall, 'could not find the buildAllRssFeeds({...}) call to inspect');
  assert.match(
    rssCall[0],
    /registries:\s*\{\s*frontaliere:\s*ARTICLES,\s*svizzera:\s*SWISS_ARTICLES\s*\}/,
    'the RSS registries are no longer the raw ARTICLES/SWISS_ARTICLES. Filtering them HERE is a ' +
      'caller-side divergence: engine/rssFeeds.mjs is the single implementation shared with the site ' +
      '(its header forbids a second copy for exactly this reason), and both override files document ' +
      'RSS as out of scope. Change the `_doc` and the engine module, not this call site',
  );

  const tickerCall = src.match(/computeTickerArticles\(\s*fs,\s*path,\s*ROOT,[^,]+,/);
  assert.ok(tickerCall, 'could not find the computeTickerArticles(...) call to inspect');
  assert.match(
    tickerCall[0],
    /ROOT,\s*ARTICLES,/,
    'the ticker no longer receives the raw ARTICLES. news-ticker-live.json has THREE producers that all ' +
      'call computeTickerArticles with an unfiltered registry — the site build (vite.config.ts), the ' +
      "site's fast-publish (scripts/publish-article-chunks.mjs, CDN key data/news-ticker-live.json) and " +
      'this script; producers 2 and 3 write the same payload for the same consumer, so filtering only ' +
      "here makes the homepage's top-5 depend on which one wrote last. The filter belongs inside " +
      'computeTickerArticles, which is edited on the site (packages/articles/engine)',
  );
});
