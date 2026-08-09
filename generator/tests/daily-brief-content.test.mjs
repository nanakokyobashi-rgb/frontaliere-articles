/**
 * Daily-brief EDITION builder (Bollettino del Frontaliere). Run with `node --test`.
 *
 * Pins the four properties the edition lives or dies by: the title carries a
 * proprietary number of the day; every locale gets a complete body with its
 * hub links; a degraded block turns into a note instead of a hole; and the
 * sitemap retention selector keeps exactly the newest 90 dated editions.
 * (The generator SCRIPT itself is exercised by dry-run-entrypoints in CI,
 * where npm ci provides create-article.mjs's static deps — not here.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import {
  buildDailyBriefArticle,
  pickHeadline,
  pickDailyAuthor,
  dailyBriefSlugs,
  selectRetiredDailyEditions,
  DAILY_EDITION_SITEMAP_KEEP,
  loadSnapshot,
  buildData,
  humanDate,
} from '../scripts/lib/daily-brief-content.mjs';
import { buildDailyBriefSvg } from '../scripts/lib/daily-brief-image.mjs';

const BRIEF = {
  schemaVersion: 1,
  generatedAt: '2026-08-08T05:00:00.000Z',
  dateIso: '2026-08-08',
  counts: { availableBlocks: 4, crossings: 141, fuelMunicipalities: 518, exchangePoints: 32, jobsActive: 22645 },
  blocks: {
    borderWait: {
      available: true,
      updatedAt: '2026-08-08T04:30:00.000Z',
      count: 141,
      zeroWaitCount: 104,
      worst: { slug: 'chiasso-brogeda', name: 'Chiasso Brogeda', waitMinutes: 47 },
      crossings: [
        { slug: 'chiasso-brogeda', name: 'Chiasso Brogeda', waitMinutes: 47, status: 'red', direction: 'Entrambi' },
        { slug: 'gaggiolo', name: 'Gaggiolo', waitMinutes: 20, status: 'yellow', direction: 'Entrambi' },
        { slug: 'ponte-tresa', name: 'Ponte Tresa', waitMinutes: 10, status: 'yellow', direction: 'Entrambi' },
        { slug: 'anieres', name: 'Anières', waitMinutes: 0, status: 'green', direction: 'Entrambi' },
      ],
    },
    fuel: {
      available: true,
      generatedAt: '2026-08-08T04:00:00.000Z',
      municipalityCount: 518,
      cheaperItalyCount: 66,
      cheaperSwissCount: 71,
      tieCount: 9,
      cheapestItaly: [
        { municipality: 'Livigno', province: 'SO', minPriceEur: 1.528, stationName: 'TOTAL ERG' },
        { municipality: 'Como', province: 'CO', minPriceEur: 1.899, stationName: null },
      ],
      bestSavings: [
        { municipality: 'Livigno', province: 'SO', cheaperCountry: 'IT', italyPriceEur: 1.528, swissPriceEur: 2.033, swissPriceChf: 1.9, saving50LEur: 25.25 },
      ],
      cheapestSwissStation: { name: 'Alpina Tankstelle', sp95PriceChf: 1.42, sp95PriceEur: 1.519, nearestMunicipality: 'Curon Venosta (BZ)' },
    },
    exchange: {
      available: true,
      rate: 1.0695,
      lastDate: '2026-08-08',
      prevRate: 1.0695,
      prevDate: '2026-08-07',
      delta1d: 0,
      rate7dAgo: 1.0741,
      delta7d: -0.0046,
      source: 'frankfurter',
      pointCount: 32,
    },
    jobs: {
      available: true,
      generatedAt: '2026-08-08T04:27:00.000Z',
      activeJobs: 22645,
      activeCompanies: 857,
      todayAdded: 12,
      yesterdayAdded: 591,
      last7dAdded: 4869,
    },
  },
};

test('the title leads with the day’s proprietary number, in every locale', () => {
  const article = buildDailyBriefArticle(BRIEF);
  assert.equal(article.id, 'bollettino-frontaliere-2026-08-08');
  assert.match(article.content.it.title, /Chiasso Brogeda 47 minuti/);
  assert.match(article.content.it.title, /8 agosto 2026/);
  assert.match(article.content.en.title, /47-minute queue at Chiasso Brogeda/);
  assert.match(article.content.de.title, /47 Minuten Wartezeit/);
  assert.match(article.content.fr.title, /47 minutes d'attente/);
});

test('every locale gets 4 bodies, its hub links and a 3-question FAQ', () => {
  const article = buildDailyBriefArticle(BRIEF);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const c = article.content[locale];
    for (const key of ['body1', 'body2', 'body3', 'body4']) {
      assert.ok(c[key]?.length > 100, `${locale}.${key} too short`);
      assert.ok(!/<[a-z]+[\s>]/.test(c[key]), `${locale}.${key} contains raw HTML (renders as literal text)`);
    }
    assert.equal(c.faq.length, 3);
    assert.ok(article.imageAlt[locale].length > 20);
  }
  assert.match(article.content.it.body1, /\/traffico-dogane\//);
  assert.match(article.content.it.body2, /\/prezzi-benzina\/oggi\//);
  assert.match(article.content.it.body3, /\/compara-servizi\/cambio-franco-euro\//);
  assert.match(article.content.it.body3, /\/calcola-stipendio\//);
  assert.match(article.content.it.body4, /\/cerca-lavoro-ticino\//);
  assert.match(article.content.de.body1, /\/de\/wartezeit-grenze\//);
  assert.match(article.content.en.body2, /\/en\/gasoline-price-switzerland\/today\//);
  assert.match(article.content.fr.body4, /\/fr\/trouver-emploi-tessin\//);
});

/**
 * THREE descriptive surfaces, three budgets — and the reason the split exists.
 *
 * Until #80 one string was excerpt, meta description and OG description at
 * once, so the tightest of the three constraints governed all of them. The
 * 2026-08-09 edition shipped a 265-char meta description and turned the site's
 * `tests` job red on every branch; the fix that unblocked it cut the excerpt to
 * ~155, which made the READER pay for a Google limit. #81 separates them.
 *
 * What this test pins, per locale:
 *
 *   excerpt         ≥ MIN_EXCERPT. A MINIMUM, deliberately: the failure mode
 *                   this repo has already lived through is someone shortening
 *                   the excerpt to make a SEO test pass. There is no maximum
 *                   the site enforces on it — nothing truncates a card teaser —
 *                   so the only ceiling here is a sanity one.
 *   seoDescription  150–160. Google truncates around 160 and the site hard-fails
 *                   above 170 (`tests/seo-description-length.test.ts`).
 *   ogDescription   200–250. Social cards render far more than a SERP does.
 *
 * Measured across every month at BOTH ends of the date-label width, because the
 * label is interpolated and swings up to 7 characters (`May 1, 2026` →
 * `September 22, 2026`). Checking one date proves nothing about the other 364.
 */
const SURFACE_BUDGETS = {
  excerpt: { min: 200, max: 320 },
  seoDescription: { min: 150, max: 160 },
  ogDescription: { min: 200, max: 250 },
};
/** The site's hard bound on `description`, mirrored so a drift here is loud. */
const SITE_DESCRIPTION_HARD_MAX = 170;

test('the three descriptive surfaces each fit their own budget, every locale, every date', () => {
  assert.ok(
    SURFACE_BUDGETS.seoDescription.max < SITE_DESCRIPTION_HARD_MAX,
    'the SERP budget must leave headroom under the site hard limit',
  );
  for (let month = 1; month <= 12; month++) {
    // '01' = narrowest label, '22' = widest. Both ends, or the band is untested.
    for (const day of ['01', '22']) {
      const dateIso = `2026-${String(month).padStart(2, '0')}-${day}`;
      const article = buildDailyBriefArticle({ ...BRIEF, dateIso });
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const c = article.content[locale];
        for (const [field, { min, max }] of Object.entries(SURFACE_BUDGETS)) {
          const value = c[field];
          assert.equal(typeof value, 'string', `${locale}.${field} is not a string`);
          assert.ok(
            value.length >= min && value.length <= max,
            `${locale}.${field} is ${value.length} chars at ${dateIso} (budget ${min}-${max}): ${value}`,
          );
          // The date has to survive any rewrite: an edition ships every morning,
          // so a template without it gives 365 pages a year one identical text.
          assert.ok(
            value.includes(humanDate(dateIso, locale)),
            `${locale}.${field} dropped its date label at ${dateIso}: ${value}`,
          );
          // A truncated template is the shape this split exists to avoid.
          assert.ok(!/[…]|\.\.\.$/.test(value), `${locale}.${field} looks truncated: ${value}`);
        }
      }
    }
  }
});

/**
 * The regression guard proper. Everything above could pass while the three
 * fields carried the same string — which is precisely the state that produced
 * #79. Assert they are DISTINCT, and that the one the reader sees is the
 * longest of the three.
 */
test('the excerpt never doubles as the meta description again (#79 regression guard)', () => {
  for (const dateIso of ['2026-03-01', '2026-09-22']) {
    const article = buildDailyBriefArticle({ ...BRIEF, dateIso });
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const { excerpt, seoDescription, ogDescription } = article.content[locale];
      assert.notEqual(seoDescription, excerpt, `${locale}: seoDescription is the excerpt again`);
      assert.notEqual(ogDescription, excerpt, `${locale}: ogDescription is the excerpt again`);
      assert.notEqual(seoDescription, ogDescription, `${locale}: SERP and social text collapsed into one`);
      // The reader-facing text is the richest of the three, by construction.
      assert.ok(excerpt.length > ogDescription.length, `${locale}: excerpt is not the richest text`);
      assert.ok(ogDescription.length > seoDescription.length, `${locale}: social text is not richer than the SERP one`);
      // And none of them is a prefix of another: that would be a truncation,
      // not a text written for its surface.
      assert.ok(!excerpt.startsWith(seoDescription), `${locale}: seoDescription is a truncation of the excerpt`);
      assert.ok(!excerpt.startsWith(ogDescription), `${locale}: ogDescription is a truncation of the excerpt`);
    }
  }
});

/**
 * The wiring, at the object the registrar actually receives. `buildData` is
 * where the excerpt used to leak into `seo.description` — one assignment, and
 * the reason a rich excerpt was impossible.
 */
test('buildData feeds seo.description from seoDescription, never from the excerpt', () => {
  const data = buildData(BRIEF);
  const c = buildDailyBriefArticle(BRIEF).content.it;
  assert.equal(data.seo.description, c.seoDescription);
  assert.equal(data.seo.ogDescription, c.ogDescription);
  assert.notEqual(data.seo.description, c.excerpt);
  assert.notEqual(data.seo.ogDescription, c.excerpt);
  // The bound the site enforces on `description`, restated where it is set.
  assert.ok(
    data.seo.description.length <= SITE_DESCRIPTION_HARD_MAX,
    `seo.description is ${data.seo.description.length} chars (site hard max ${SITE_DESCRIPTION_HARD_MAX})`,
  );
});

test('a degraded block becomes a note, never a hole', () => {
  const degraded = structuredClone(BRIEF);
  degraded.blocks.fuel = { available: false, reason: 'stale' };
  degraded.counts.availableBlocks = 3;
  const article = buildDailyBriefArticle(degraded);
  assert.match(article.content.it.body2, /⚠️/);
  assert.match(article.content.it.body2, /\/prezzi-benzina\/oggi\//);
  assert.ok(article.content.it.body2.length > 60);
});

test('headline cascade: queue ≥10min beats jobs beats exchange', () => {
  assert.equal(pickHeadline(BRIEF.blocks).kind, 'borderWait');
  const calm = structuredClone(BRIEF.blocks);
  calm.borderWait.worst.waitMinutes = 5;
  assert.equal(pickHeadline(calm).kind, 'jobs');
  calm.jobs.yesterdayAdded = 3;
  assert.equal(pickHeadline(calm).kind, 'exchange');
  calm.exchange = { available: false };
  assert.equal(pickHeadline(calm).kind, 'fuel');
});

test('pickHeadline is TOTAL over available blocks (PR #51 review finding)', () => {
  // The shapes that used to exhaust the cascade: fuel available with EMPTY
  // cheapestItaly (bestSavings only), jobs available with null yesterdayAdded.
  const variants = {
    borderWait: [null, { available: false }, BRIEF.blocks.borderWait,
      { ...BRIEF.blocks.borderWait, worst: { slug: 's', name: 'S', waitMinutes: 3 } }],
    fuel: [null, { available: false }, BRIEF.blocks.fuel,
      { ...BRIEF.blocks.fuel, cheapestItaly: [] }],
    exchange: [null, { available: false }, BRIEF.blocks.exchange],
    jobs: [null, { available: false }, BRIEF.blocks.jobs,
      { ...BRIEF.blocks.jobs, yesterdayAdded: null },
      { ...BRIEF.blocks.jobs, yesterdayAdded: 3 }],
  };
  const KINDS = new Set(['borderWait', 'jobs', 'jobsTotal', 'exchange', 'fuel', 'fuelSaving']);
  let combos = 0;
  for (const borderWait of variants.borderWait)
    for (const fuel of variants.fuel)
      for (const exchange of variants.exchange)
        for (const jobs of variants.jobs) {
          combos++;
          const blocks = { borderWait, fuel, exchange, jobs };
          const anyAvailable = Object.values(blocks).some((b) => b?.available);
          const h = pickHeadline(blocks);
          if (anyAvailable) {
            assert.ok(h, `null headline despite available blocks: ${Object.entries(blocks).filter(([, b]) => b?.available).map(([k]) => k)}`);
            assert.ok(KINDS.has(h.kind), `unknown kind ${h.kind}`);
          } else {
            assert.equal(h, null);
          }
        }
  assert.equal(combos, 4 * 4 * 3 * 5);
});

test('the review scenario builds an edition instead of throwing (exit-0 contract)', () => {
  const brief = structuredClone(BRIEF);
  brief.blocks.borderWait = { available: false, reason: 'x' };
  brief.blocks.exchange = { available: false, reason: 'x' };
  brief.blocks.fuel.cheapestItaly = [];
  brief.blocks.jobs.yesterdayAdded = 3; // sub-threshold
  brief.counts.availableBlocks = 2;
  const a1 = buildDailyBriefArticle(brief); // used to throw here
  assert.match(a1.content.it.title, /3 nuovi annunci/);
  brief.blocks.jobs.yesterdayAdded = null; // → jobsTotal fallback
  const a2 = buildDailyBriefArticle(brief);
  assert.match(a2.content.it.title, /annunci di lavoro attivi/);
  brief.blocks.jobs = { available: false, reason: 'x' }; // fuel-only, savings-only
  const a3 = buildDailyBriefArticle(brief);
  assert.match(a3.content.it.title, /il pieno giusto vale/);
});

test('title and jobs section never contradict: null yesterdayAdded → totals lead, not the outage note', () => {
  // Second review finding: with the jobsTotal headline the body4 used to fall
  // into jobsDown ("stats not up to date") — a self-contradicting edition.
  // Plausibly the COMMON morning path, not an edge (stats regenerate later).
  const brief = structuredClone(BRIEF);
  brief.blocks.jobs.yesterdayAdded = null;
  const article = buildDailyBriefArticle(brief);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const body4 = article.content[locale].body4;
    assert.ok(!body4.includes('⚠️'), `${locale}.body4 carries the outage note despite jobs.available`);
  }
  assert.match(article.content.it.body4, /22'645|22.645|22645/); // the totals lead
  assert.match(article.content.it.body4, /\/cerca-lavoro-ticino\//); // link still there
});

test('cascade priority among fallbacks is what the comment declares', () => {
  const calm = structuredClone(BRIEF.blocks);
  calm.borderWait.worst.waitMinutes = 3; // sub-threshold queue
  calm.jobs.yesterdayAdded = null;
  calm.exchange = { available: false };
  calm.fuel = { available: false };
  // sub-threshold borderWait beats jobsTotal when both are available
  assert.equal(pickHeadline(calm).kind, 'borderWait');
  calm.borderWait = { available: false };
  // finite-but-sub-threshold jobs beats jobsTotal
  calm.jobs.yesterdayAdded = 2;
  assert.equal(pickHeadline(calm).kind, 'jobs');
  calm.jobs.yesterdayAdded = null;
  assert.equal(pickHeadline(calm).kind, 'jobsTotal');
});

test('loadSnapshot refuses a snapshot whose counter disagrees with its own blocks', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'daily-brief-lie-'));
  const file = path.join(dir, 'daily-brief.json');
  const lying = structuredClone(BRIEF);
  lying.blocks.borderWait = { available: false };
  lying.blocks.fuel = { available: false };
  lying.blocks.exchange = { available: false };
  lying.blocks.jobs = { available: false };
  lying.counts.availableBlocks = 4; // the lie
  writeFileSync(file, JSON.stringify(lying));
  const { brief, reason } = loadSnapshot('2026-08-08', file);
  assert.equal(brief, null);
  assert.match(reason, /inconsistent snapshot/);
});

test('slugs are dated per locale; author rotation is deterministic and rotates', () => {
  const slugs = dailyBriefSlugs('2026-08-08');
  assert.equal(slugs.it, 'bollettino-frontaliere-2026-08-08');
  assert.match(slugs.en, /^cross-border-daily-brief-2026-08-08$/);
  assert.match(slugs.de, /2026-08-08$/);
  assert.match(slugs.fr, /2026-08-08$/);
  const a1 = pickDailyAuthor('2026-08-08');
  assert.equal(pickDailyAuthor('2026-08-08').slug, a1.slug); // deterministic
  const three = new Set(['2026-08-08', '2026-08-09', '2026-08-10'].map((d) => pickDailyAuthor(d).slug));
  assert.equal(three.size, 3); // full rotation over three days
  assert.ok(!three.has('redazione'));
});

test('sitemap retention keeps the newest 90 dated editions, ignores everything else', () => {
  const ids = ['classifica-dogane-ticino', 'eventi-weekend-ticino'];
  const day0 = Date.parse('2026-05-01T00:00:00Z');
  const dates = [];
  for (let i = 0; i < 100; i++) {
    const d = new Date(day0 + i * 86_400_000).toISOString().slice(0, 10);
    dates.push(d);
    ids.push(`bollettino-frontaliere-${d}`);
  }
  const retired = selectRetiredDailyEditions(ids);
  assert.equal(retired.size, 100 - DAILY_EDITION_SITEMAP_KEEP);
  assert.ok(retired.has(`bollettino-frontaliere-${dates[0]}`)); // oldest goes
  assert.ok(!retired.has(`bollettino-frontaliere-${dates[99]}`)); // newest stays
  assert.ok(!retired.has('classifica-dogane-ticino')); // evergreen untouched
});

test('the SVG hero is 1200×675, carries the numbers, and never emoji', () => {
  const svg = buildDailyBriefSvg(BRIEF, { locale: 'it' });
  assert.match(svg, /width="1200" height="675"/);
  assert.match(svg, /47 min/);
  assert.match(svg, /Chiasso Brogeda/);
  assert.match(svg, /1[.,]528/);
  assert.match(svg, /1[.,]0695/);
  assert.match(svg, /\+591/);
  assert.match(svg, /2026-08-08/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(svg), 'emoji in SVG become tofu on CI rasterizers');
});

test('loadSnapshot refuses stale, thin and missing snapshots (exit-0 path)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'daily-brief-'));
  const file = path.join(dir, 'daily-brief.json');
  assert.match(loadSnapshot('2026-08-08', file).reason, /missing/);
  writeFileSync(file, JSON.stringify({ ...BRIEF, dateIso: '2026-08-07' }));
  assert.match(loadSnapshot('2026-08-08', file).reason, /stale/);
  writeFileSync(file, JSON.stringify({ ...BRIEF, counts: { ...BRIEF.counts, availableBlocks: 1 } }));
  assert.match(loadSnapshot('2026-08-08', file).reason, /too thin/);
  writeFileSync(file, JSON.stringify(BRIEF));
  assert.equal(loadSnapshot('2026-08-08', file).reason, null);
});

test('buildData wires the registrar shape: novita, named author, generated hero path', () => {
  const data = buildData(BRIEF);
  assert.equal(data.category, 'novita');
  assert.notEqual(data.author.slug, 'redazione');
  assert.equal(data._generatedImagePath, '/images/blog/bollettino-frontaliere-2026-08-08.webp');
  assert.match(data.seo.keywords, /dogana/); // news-sitemap whitelist token
  assert.equal(data.slugs.it, data.id);
  assert.match(data.seo.breadcrumbName, /8 agosto 2026/);
});
