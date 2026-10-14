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

test('fuel savings require a matching fresh Italian quote and a fresh explicit Swiss quote', () => {
  const fresh = { municipality: 'Fresh', province: 'ZZ', minPriceEur: 1.7, cheapestStation: { updatedAt: `${day(1)}T00:00:00Z` } };
  const old = { municipality: 'Old', province: 'ZZ', minPriceEur: 1.1, cheapestStation: { updatedAt: `${day(20)}T00:00:00Z` } };
  const saving = { municipality: 'Fresh', province: 'ZZ', cheaperCountry: 'IT', italyPriceEur: 1.7, swissPriceEur: 2.1, saving50LEur: 20, swissStation: { updatedAt: `${day(1)}T00:00:00Z`, sp95PriceEur: 2.1 } };
  const fuel = shapeFuel({ generatedAt: new Date(now - 1000).toISOString(), summary: { municipalityCount: 999, cheaperItalyCount: 888, cheaperSwissCount: 777 }, rankings: {
    cheapestItalyMunicipalities: [fresh, old], bestCrossBorderSavings: [
      { ...saving, municipality: 'Unverifiable' }, { ...saving, municipality: 'Old', italyPriceEur: 1.1 },
      { ...saving, italyPriceEur: 1.5 }, { ...saving, cheaperCountry: 'CH' }, { ...saving, saving50LEur: 80 }, { ...saving, swissStation: { updatedAt: `${day(20)}T00:00:00Z` } }, saving,
    ],
  } }, { nowMs: now });
  assert.equal(fuel.available, true);
  assert.deepEqual(fuel.bestSavings.map(row => row.municipality), ['Fresh']);
  for (const field of ['municipalityCount', 'cheaperItalyCount', 'cheaperSwissCount', 'comparedMunicipalityCount', 'tieCount']) assert.equal(fuel[field], null);
  const article = buildDailyBriefArticle({ dateIso: day(0), blocks: { fuel } });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.doesNotMatch(article.content[locale].body2, /999|888|777|Unverifiable|Old/);
    assert.match(article.content[locale].body2, /Fresh/);
  }
});

test('ISO and date-first fuel observations reject nonexistent civil days', () => {
  const march = Date.parse('2026-03-03T12:00:00Z');
  for (const updatedAt of ['2026-02-29T11:00:00Z', '2026-02-30T11:00:00Z', '2026-02-31T11:00:00Z', '31/02/2026 11:00:00', '03/03/2026 99:00:00']) {
    assert.equal(fuelQuoteIsFresh({ updatedAt }, march), false, updatedAt);
  }
  assert.equal(fuelQuoteIsFresh({ updatedAt: '2028-02-29T11:00:00Z' }, Date.parse('2028-03-01T12:00:00Z')), true);
  const fuel = shapeFuel({ generatedAt: '2026-02-31T11:00:00Z', rankings: { cheapestItalyMunicipalities: [{ municipality: 'Fresh', minPriceEur: 1.7 }] } }, { nowMs: march });
  assert.equal(fuel.available, false, 'aggregate timestamps obey the same civil-date guard');
});

test('HTTP 200 reports with null rows degrade the optional audience block without throwing', async () => {
  const demand = await fetchSearchDemand({}, day(0), { tokenImpl: async () => 'fixture', fetchImpl: async () => ({ ok: true, json: async () => ({ rows: null }) }) });
  assert.equal(demand.available, false);
  assert.equal(demand.partial, true);
  assert.deepEqual(demand.sources, { gsc: false, ga4: false });
  const blocks = { jobs: { available: true }, exchange: { available: true, rate: 1.07 }, fuel: { available: true }, borderWait: { available: true } };
  const before = structuredClone(blocks);
  assert.equal(buildDailyBriefInsights({ todayIso: day(0), blocks, searchDemand: demand }).searchDemand, undefined);
  assert.deepEqual(blocks, before);
});

test('leader labels cannot introduce Markdown syntax into observed tables', () => {
  const insights = buildDailyBriefInsights({ todayIso: day(0), blocks: { jobs: { available: true } }, jobsStats: { leaders: {
    topCompaniesActive: [{ name: 'A*Company* `_Group_`|[Ltd]', count: 10 }, { name: '*_`', count: 9 }],
    topLocationsActive: [{ name: 'Some_Town*`', count: 8 }],
  } } });
  assert.equal(insights.jobs.topCompanies.length, 1);
  for (const row of [...insights.jobs.topCompanies, ...insights.jobs.topLocations]) assert.doesNotMatch(row.name, /[*_`|\[\]<>]/);
});
