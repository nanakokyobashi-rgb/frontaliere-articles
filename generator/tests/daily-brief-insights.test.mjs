import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyBriefInsights } from '../scripts/lib/daily-brief-insights.mjs';
import { shapeSearchDemand, fetchSearchDemand } from '../scripts/lib/daily-brief-demand.mjs';
import { fuelQuoteIsFresh, shapeFuel } from '../scripts/lib/daily-brief-data.mjs';
import { buildDailyBriefArticle } from '../scripts/lib/daily-brief-content.mjs';
import { enrichArticleInternalLinks } from '../scripts/lib/contextual-article-links.mjs';

const now = Date.now();
const day = n => new Date(now - n * 86400000).toISOString().slice(0, 10);
const history = Array.from({ length: 14 }, (_, i) => ({ date: day(i + 1), added: i < 7 ? 10 : 5 }));

test('compares complete closed weeks, never a partial day or an incomplete baseline', () => {
  const input = { blocks: { jobs: { available: true } }, todayIso: day(0), jobsStats: { history: [...history, { date: day(0), added: 999 }], leaders: { topCompaniesActive: [{ name: 'Employer', count: 8 }] } } };
  const result = buildDailyBriefInsights(input).jobs;
  assert.equal(result.currentWeekAdded, 70);
  assert.equal(result.previousWeekAdded, 35);
  assert.equal(result.weeklyChange, 35);
  assert.equal(result.weeklyChangePct, 100);
  input.jobsStats.history = history.slice(0, 13);
  assert.equal(buildDailyBriefInsights(input).jobs.previousWeekAdded, null);
  assert.equal(buildDailyBriefInsights(input).jobs.weeklyChange, null);
});

test('FX illustration uses the observed rate and refuses an absent weekly change', () => {
  const input = { todayIso: day(0), blocks: { exchange: { available: true, rate: 1.07, delta7d: -0.01, lastDate: day(1) } } };
  assert.equal(buildDailyBriefInsights(input).exchange.salaryValueEur, 4280);
  assert.equal(buildDailyBriefInsights(input).exchange.weeklySalaryChangeEur, -40);
  input.blocks.exchange.delta7d = null;
  assert.equal(buildDailyBriefInsights(input).exchange.weeklySalaryChangeEur, null);
});

test('crossing comparison needs the same crossing and consecutive editions', () => {
  const input = { todayIso: day(0), blocks: { borderWait: { available: true, worst: { slug: 'crossing', name: 'Crossing', waitMinutes: 20 } } }, previousSnapshot: { dateIso: day(1), blocks: { borderWait: { available: true, crossings: [{ slug: 'crossing', waitMinutes: 10 }] } } } };
  assert.equal(buildDailyBriefInsights(input).borderWait.changeMinutes, 10);
  input.previousSnapshot.dateIso = day(2);
  assert.equal(buildDailyBriefInsights(input).borderWait, undefined);
});

test('a fresh fuel aggregate cannot make an explicit old quote fresh', () => {
  assert.equal(fuelQuoteIsFresh({ updatedAt: `${day(20)}T00:00:00Z` }, now), false);
  assert.equal(fuelQuoteIsFresh({ updatedAt: `${day(-1)}T00:00:00Z` }, now), false);
  const [y, m, d] = day(1).split('-');
  assert.equal(fuelQuoteIsFresh({ updatedAt: `${d}/${m}/${y} 08:00:00` }, now), true);
  const fuel = shapeFuel({ generatedAt: new Date(now - 1000).toISOString(), rankings: { cheapestItalyMunicipalities: [
    { municipality: 'Old', minPriceEur: 1, cheapestStation: { updatedAt: `${day(20)}T00:00:00Z` } },
    { municipality: 'Fresh', minPriceEur: 2, cheapestStation: { updatedAt: `${day(1)}T00:00:00Z`, dieselPriceEur: 2.1 } },
  ] } }, { nowMs: now });
  assert.equal(fuel.cheapestItaly.length, 1);
  assert.equal(fuel.cheapestItaly[0].dieselPriceEur, 2.1);
});

test('search demand publishes predefined aggregates, never raw user input', () => {
  const demand = shapeSearchDemand({ startDate: day(9), endDate: day(3), gscAvailable: true, ga4Available: true,
    gscRows: [{ keys: ['net salary PRIVATE_USER_INPUT'], impressions: 30 }],
    ga4Rows: [{ dimensionValues: [{ value: 'PRIVATE_USER_INPUT' }, { value: 'job-board' }], metricValues: [{ value: '12' }] }],
  });
  assert.equal(demand.available, true);
  assert.equal(demand.topics.find(t => t.theme === 'salary').impressions, 30);
  assert.equal(demand.topics.find(t => t.theme === 'jobs').searches, 12);
  assert.doesNotMatch(JSON.stringify(demand), /PRIVATE_USER_INPUT/);
});

test('one failed audience source is optional and never takes down the edition', async () => {
  const result = await fetchSearchDemand({}, day(0), { tokenImpl: async () => 'fixture', fetchImpl: async url => {
    if (url.includes('analyticsdata')) throw new Error('unavailable');
    return { ok: true, json: async () => ({ rows: [{ keys: ['diesel prices'], impressions: 100 }] }) };
  } });
  assert.equal(result.available, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.sources, { gsc: true, ga4: false });
  assert.equal(result.endDate, day(3));
});

test('each locale renders observed demand and a number-first daily headline', () => {
  const blocks = { jobs: { available: true, yesterdayAdded: 40, last7dAdded: 70, activeJobs: 100, activeCompanies: 5 }, exchange: { available: true, rate: 1.07, delta1d: 0, delta7d: null, lastDate: day(1) } };
  const searchDemand = shapeSearchDemand({ startDate: day(9), endDate: day(3), gscAvailable: true, ga4Available: false, gscRows: [{ keys: ['diesel prices'], impressions: 100 }] });
  const insights = buildDailyBriefInsights({ blocks, todayIso: day(0), jobsStats: { history }, searchDemand });
  const article = buildDailyBriefArticle({ dateIso: day(0), blocks, insights });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.ok(article.content[locale].title.indexOf('40') < article.content[locale].title.indexOf(String(new Date(now).getUTCFullYear())));
    assert.match(article.content[locale].body4, /Google Search Console/);
    assert.match(article.content[locale].body4, /100/);
    assert.doesNotMatch(article.content[locale].body4, /PRIVATE_USER_INPUT/);
  }
});

test('the generator links relevant multilingual prose with one shared budget', () => {
  const data = { content: { en: { body1: 'Net salary and pension.', body2: 'Net salary again.', body3: 'Health insurance.' }, fr: { body1: 'Le salaire net.', body2: 'En attente.' } } };
  enrichArticleInternalLinks(data, { bodySections: content => content, isPending: (_, locale, field) => locale === 'fr' && field === 'body2' });
  assert.match(data.content.en.body1, /nav:calculator/);
  assert.doesNotMatch(data.content.en.body2, /nav:calculator/);
  assert.equal(data.content.fr.body2, 'En attente.');
  assert.equal(Object.hasOwn(data.content.fr, 'body3'), false);
});
