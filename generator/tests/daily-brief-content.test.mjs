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
