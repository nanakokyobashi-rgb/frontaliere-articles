/**
 * Daily-brief data shaping (Bollettino del Frontaliere). Run with `node --test`.
 *
 * The cases below pin the degradation rules, because those are what keep a
 * broken crawler from either (a) taking down the whole edition or (b) letting
 * a stale number get published as today's news. Fixtures, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeValue,
  decodeFields,
  shapeBorderWait,
  shapeFuel,
  shapeExchange,
  shapeJobs,
  buildDailyBrief,
  BORDER_WAIT_MIN_CROSSINGS,
} from '../scripts/lib/daily-brief-data.mjs';

const NOW = Date.parse('2026-08-08T05:00:00Z');
const TODAY = '2026-08-08';
const FRESH = '2026-08-08T04:30:00.000Z';

function crossing(slug, waitMinutes, overrides = {}) {
  return {
    slug,
    crossingName: slug[0].toUpperCase() + slug.slice(1),
    waitTimeMinutes: waitMinutes,
    status: 'green',
    direction: 'Entrambi',
    lastUpdate: FRESH,
    ...overrides,
  };
}

function manyCrossings(n, { worstWait = 47 } = {}) {
  const docs = [crossing('brogeda', worstWait, { status: 'red' })];
  for (let i = 1; i < n; i++) docs.push(crossing(`valico-${String(i).padStart(3, '0')}`, i % 7 === 0 ? 5 : 0));
  return docs;
}

// ---------------------------------------------------------------- decode

test('decodes the Firestore REST value envelope, including nesting', () => {
  assert.equal(decodeValue({ integerValue: '47' }), 47);
  assert.equal(decodeValue({ doubleValue: 1.0695 }), 1.0695);
  assert.equal(decodeValue({ stringValue: 'Brogeda' }), 'Brogeda');
  assert.equal(decodeValue({ timestampValue: FRESH }), FRESH);
  assert.deepEqual(
    decodeFields({
      points: {
        arrayValue: {
          values: [{ mapValue: { fields: { date: { stringValue: TODAY }, rate: { doubleValue: 1.07 } } } }],
        },
      },
    }),
    { points: [{ date: TODAY, rate: 1.07 }] },
  );
});

// ---------------------------------------------------------------- borderWait

test('borderWait: ranks fresh crossings, worst first, and counts the zeros', () => {
  const block = shapeBorderWait(manyCrossings(40), { nowMs: NOW });
  assert.equal(block.available, true);
  assert.equal(block.count, 40);
  assert.equal(block.worst.name, 'Brogeda');
  assert.equal(block.worst.waitMinutes, 47);
  assert.equal(block.crossings[0].slug, 'brogeda');
  assert.ok(block.zeroWaitCount > 0);
});

test('borderWait: drops stale individual crossings, degrades under the minimum', () => {
  const docs = manyCrossings(BORDER_WAIT_MIN_CROSSINGS + 5);
  // Age all but 10 beyond the per-doc cutoff.
  for (let i = 10; i < docs.length; i++) docs[i].lastUpdate = '2026-08-06T04:30:00.000Z';
  const block = shapeBorderWait(docs, { nowMs: NOW });
  assert.equal(block.available, false);
  assert.match(block.reason, /only 10 fresh crossings/);
});

test('borderWait: degrades when even the newest update is too old', () => {
  const docs = manyCrossings(40).map((d) => ({ ...d, lastUpdate: '2026-08-07T20:00:00.000Z' }));
  const block = shapeBorderWait(docs, { nowMs: NOW });
  assert.equal(block.available, false);
  assert.match(block.reason, /newest crossing update/);
});

// ---------------------------------------------------------------- fuel

const FUEL_META = {
  generatedAt: FRESH,
  summary: {
    municipalityCount: 518,
    cheaperItalyCount: 66,
    cheaperSwissCount: 71,
    tieCount: 9,
    cheapestSwissStation: { name: 'Alpina', sp95PriceChf: 1.42, sp95PriceEur: 1.519, nearestMunicipality: 'Curon Venosta (BZ)' },
  },
  rankings: {
    cheapestItalyMunicipalities: [
      { municipality: 'Livigno', province: 'SO', minPriceEur: 1.528, cheapestStation: { stationName: 'TOTAL ERG' } },
      { municipality: 'Como', province: 'CO', minPriceEur: 1.899 },
    ],
    bestCrossBorderSavings: [
      { municipality: 'Livigno', province: 'SO', cheaperCountry: 'IT', italyPriceEur: 1.528, swissPriceEur: 2.033, swissPriceChf: 1.9, saving50LEur: 25.25 },
    ],
  },
};

test('fuel: shapes rankings and summary from the metadata doc', () => {
  const block = shapeFuel(FUEL_META, { nowMs: NOW });
  assert.equal(block.available, true);
  assert.equal(block.municipalityCount, 518);
  assert.equal(block.cheapestItaly[0].municipality, 'Livigno');
  assert.equal(block.bestSavings[0].saving50LEur, 25.25);
  assert.equal(block.cheapestSwissStation.sp95PriceChf, 1.42);
});

test('fuel: degrades on stale generatedAt and on missing doc', () => {
  assert.equal(shapeFuel({ ...FUEL_META, generatedAt: '2026-08-05T12:00:00Z' }, { nowMs: NOW }).available, false);
  assert.equal(shapeFuel(null, { nowMs: NOW }).available, false);
});

// ---------------------------------------------------------------- exchange

const EXCHANGE_DOC = {
  source: 'frankfurter',
  points: [
    { date: '2026-07-30', rate: 1.062 },
    { date: '2026-08-01', rate: 1.064 },
    { date: '2026-08-07', rate: 1.068 },
    { date: '2026-08-08', rate: 1.0695 },
  ],
};

test('exchange: latest rate, 1-day and 7-day deltas', () => {
  const block = shapeExchange(EXCHANGE_DOC, { todayIso: TODAY });
  assert.equal(block.available, true);
  assert.equal(block.rate, 1.0695);
  assert.equal(block.delta1d, 0.0015);
  assert.equal(block.rate7dAgo, 1.064); // latest point at or before 2026-08-01
  assert.equal(block.delta7d, 0.0055);
});

test('exchange: degrades when the series stops too many days ago', () => {
  const stale = { points: [{ date: '2026-07-30', rate: 1.06 }, { date: '2026-08-01', rate: 1.06 }] };
  const block = shapeExchange(stale, { todayIso: TODAY });
  assert.equal(block.available, false);
  assert.match(block.reason, /old/);
});

// ---------------------------------------------------------------- jobs

const JOBS_STATS = {
  generatedAt: FRESH,
  totals: { activeJobs: 22645, activeCompanies: 857, todayAdded: 12, last7d: { added: 4869 } },
  history: [
    { date: '2026-08-06', totalJobs: 22100, added: 512 },
    { date: '2026-08-07', totalJobs: 22645, added: 591 },
  ],
};

test('jobs: uses yesterday from the history series, keeps the live partial', () => {
  const block = shapeJobs(JOBS_STATS, { nowMs: NOW, todayIso: TODAY });
  assert.equal(block.available, true);
  assert.equal(block.activeJobs, 22645);
  assert.equal(block.yesterdayAdded, 591);
  assert.equal(block.todayAdded, 12);
  assert.equal(block.last7dAdded, 4869);
});

test('jobs: degrades on stale generatedAt and on zero totals', () => {
  assert.equal(shapeJobs({ ...JOBS_STATS, generatedAt: '2026-08-05T00:00:00Z' }, { nowMs: NOW, todayIso: TODAY }).available, false);
  assert.equal(shapeJobs({ generatedAt: FRESH, totals: {} }, { nowMs: NOW, todayIso: TODAY }).available, false);
});

// ---------------------------------------------------------------- assembly

test('buildDailyBrief: counts available blocks, keeps degraded ones as notes', () => {
  const brief = buildDailyBrief({
    todayIso: TODAY,
    nowMs: NOW,
    borderWaitDocs: manyCrossings(40),
    fuelMetadata: null, // fetch failed → block degrades, edition survives
    exchangeDoc: EXCHANGE_DOC,
    jobsStats: JOBS_STATS,
  });
  assert.equal(brief.schemaVersion, 1);
  assert.equal(brief.dateIso, TODAY);
  assert.equal(brief.counts.availableBlocks, 3);
  assert.equal(brief.counts.crossings, 40);
  assert.equal(brief.counts.fuelMunicipalities, 0);
  assert.equal(brief.blocks.fuel.available, false);
  assert.ok(brief.blocks.fuel.reason);
});

test('buildDailyBrief: refuses a malformed todayIso outright', () => {
  assert.throws(() => buildDailyBrief({ todayIso: 'oggi' }), /YYYY-MM-DD/);
});
