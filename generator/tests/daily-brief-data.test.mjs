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
  JOBS_HISTORY_MAX_LAG_DAYS,
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

test('exchange: a non-canonical point date degrades instead of being dropped', () => {
  // Twin of the jobs history rule: the series is sorted and windowed with
  // string comparison, so `2026-8-7` would sort past the newest point and skew
  // both the freshness check and the 7d lookback.
  const doc = {
    points: [
      { date: '2026-08-01', rate: 0.945 },
      { date: '2026-8-7', rate: 0.951 },
      { date: '2026-08-07', rate: 0.952 },
    ],
  };
  const block = shapeExchange(doc, { todayIso: TODAY });
  assert.equal(block.available, false);
  assert.match(block.reason, /not YYYY-MM-DD/);
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

test('jobs: degrades when the history series stops advancing, however fresh generatedAt is', () => {
  // The aggregator keeps stamping a current `generatedAt` over a corpus that
  // stopped moving: only the corpus clock can see it.
  const frozen = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-01', totalJobs: 22100, added: 512 },
      { date: '2026-08-04', totalJobs: 22645, added: 591 },
    ],
  };
  const block = shapeJobs(frozen, { nowMs: NOW, todayIso: TODAY });
  assert.equal(block.available, false);
  assert.match(block.reason, /2026-08-04/);
  assert.match(block.reason, /not advancing/);
});

test(`jobs: the healthy lag is exactly ${JOBS_HISTORY_MAX_LAG_DAYS}d — yesterday closed, nothing older`, () => {
  // The day in progress is scoped out, so on a corpus that advances the newest
  // closed row is always D-1. A lag of 2 means the closed row for D-1 never
  // landed, which is also the state with no `yesterdayAdded` to headline with.
  const healthy = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-06', totalJobs: 22100, added: 512 },
      { date: '2026-08-07', totalJobs: 22645, added: 591 },
    ],
  };
  assert.equal(shapeJobs(healthy, { nowMs: NOW, todayIso: TODAY }).available, true);

  const lagging = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-05', totalJobs: 22100, added: 512 },
      { date: '2026-08-06', totalJobs: 22645, added: 591 },
    ],
  };
  const block = shapeJobs(lagging, { nowMs: NOW, todayIso: TODAY });
  assert.equal(block.available, false);
  assert.match(block.reason, /2026-08-06, 2d before 2026-08-08/);
});

test('jobs: a non-canonical date in the series degrades instead of emptying the window', () => {
  // `2026-8-6` sorts after `2026-08-08`: dropping it silently would leave the
  // guard with an empty window and a "corpus fine" verdict.
  const malformed = {
    ...JOBS_STATS,
    history: [
      { date: '2026-8-6', totalJobs: 22100, added: 512 },
      { date: '2026-8-7', totalJobs: 22645, added: 591 },
    ],
  };
  const block = shapeJobs(malformed, { nowMs: NOW, todayIso: TODAY });
  assert.equal(block.available, false);
  assert.match(block.reason, /not YYYY-MM-DD/);
  assert.match(block.reason, /2026-8-6/);

  // A time component is the same class: it is not a closed civil day, and the
  // lag arithmetic on it used to round 2.5d up to a spurious 3d freeze.
  const timestamped = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-06T12:00:00Z', totalJobs: 22100, added: 512 },
      { date: '2026-08-07T12:00:00Z', totalJobs: 22645, added: 591 },
    ],
  };
  assert.match(shapeJobs(timestamped, { nowMs: NOW, todayIso: TODAY }).reason, /not YYYY-MM-DD/);
});

test('jobs: degrades when yesterday\'s closed row has not been appended yet', () => {
  // The aggregator can append D-1 after the 05:05 cron. Before this rule the
  // block went out `available: true` with the figure its headline needs empty.
  const appendedLate = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-06', totalJobs: 22100, added: 512, updated: 21000, removed: 200 },
      { date: TODAY, totalJobs: 22200, added: 12, updated: 300, removed: 4 },
    ],
  };
  const block = shapeJobs(appendedLate, { nowMs: NOW, todayIso: TODAY });
  assert.equal(block.available, false);
  assert.match(block.reason, /stops at 2026-08-06, 2d before/);

  // Same outcome one step further in: the D-1 row is there, so the lag rule is
  // satisfied, but it carries no usable `added`.
  const noFigure = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-06', totalJobs: 22100, added: 512, updated: 21000, removed: 200 },
      { date: '2026-08-07', totalJobs: 22645, added: null, updated: 21500, removed: 210 },
    ],
  };
  const missing = shapeJobs(noFigure, { nowMs: NOW, todayIso: TODAY });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /no closed row for 2026-08-07/);
});

test('jobs: degrades on a day that replays the previous one field-for-field', () => {
  // The measured 2026-08-29 → 2026-08-30 freeze that motivated the guard,
  // shifted onto the fixture clock. The row exists, so a lag check alone
  // would pass it.
  const replayed = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-06', totalJobs: 22943, added: 33, updated: 22557, removed: 3 },
      { date: '2026-08-07', totalJobs: 22943, added: 33, updated: 22557, removed: 3 },
    ],
  };
  const block = shapeJobs(replayed, { nowMs: NOW, todayIso: TODAY });
  assert.equal(block.available, false);
  assert.match(block.reason, /replays 2026-08-06/);
});

test('jobs: the live partial row for today is not read as a closed day', () => {
  // The aggregator seeds a row for the day in progress mirroring `totals`.
  // With that row in the tail, the lag rule would always measure 0 and the
  // replay rule would compare a partial day against a full one.
  const stopped = {
    ...JOBS_STATS,
    totals: { ...JOBS_STATS.totals, activeJobs: 22645, todayAdded: 12 },
    history: [
      { date: '2026-08-01', totalJobs: 22100, added: 512, updated: 21000, removed: 200 },
      { date: '2026-08-04', totalJobs: 22645, added: 591, updated: 21500, removed: 210 },
      { date: TODAY, totalJobs: 22645, added: 12, updated: 300, removed: 4 },
    ],
  };
  const block = shapeJobs(stopped, { nowMs: NOW, todayIso: TODAY });
  assert.equal(block.available, false);
  assert.match(block.reason, /2026-08-04/);
  assert.match(block.reason, /not advancing/);

  // Symmetrically, a partial today that happens to carry over the previous
  // day's counters is not a replay finding: the freeze is judged on closed days.
  const carryOver = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-06', totalJobs: 22352, added: 480, updated: 21900, removed: 228 },
      { date: '2026-08-07', totalJobs: 22645, added: 591, updated: 22100, removed: 298 },
      { date: TODAY, totalJobs: 22645, added: 591, updated: 22100, removed: 298 },
    ],
  };
  assert.equal(shapeJobs(carryOver, { nowMs: NOW, todayIso: TODAY }).available, true);

  // A series whose only row is today carries no closed day at all: the freeze
  // rules have nothing to judge, but the block still has no yesterday figure,
  // so it degrades on that instead of publishing an empty headline.
  const todayOnly = { ...JOBS_STATS, history: [{ date: TODAY, totalJobs: 22645, added: 12, updated: 300, removed: 4 }] };
  const onlyToday = shapeJobs(todayOnly, { nowMs: NOW, todayIso: TODAY });
  assert.equal(onlyToday.available, false);
  assert.match(onlyToday.reason, /no closed row for 2026-08-07/);
});

test('jobs: a replayed pair of closed days is still caught behind a partial today', () => {
  const replayedBehindToday = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-06', totalJobs: 22943, added: 33, updated: 22557, removed: 3 },
      { date: '2026-08-07', totalJobs: 22943, added: 33, updated: 22557, removed: 3 },
      { date: TODAY, totalJobs: 22943, added: 5, updated: 900, removed: 1 },
    ],
  };
  const block = shapeJobs(replayedBehindToday, { nowMs: NOW, todayIso: TODAY });
  assert.equal(block.available, false);
  assert.match(block.reason, /replays 2026-08-06/);
});

test('jobs: a moving corpus stays available, a closed day at zero does not', () => {
  const moving = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-06', totalJobs: 22352, added: 480, updated: 21900, removed: 228 },
      { date: '2026-08-07', totalJobs: 22645, added: 591, updated: 22100, removed: 298 },
    ],
  };
  assert.equal(shapeJobs(moving, { nowMs: NOW, todayIso: TODAY }).available, true);
  // A closed day with every movement counter at zero is a crawler that did not
  // run, not a quiet day — publishing it would print "0 new listings yesterday"
  // as a fact. It is caught before the replay rule, which no longer needs its
  // own `updated > 0` escape hatch.
  const idle = {
    ...JOBS_STATS,
    history: [
      { date: '2026-08-06', totalJobs: 22645, added: 0, updated: 0, removed: 0 },
      { date: '2026-08-07', totalJobs: 22645, added: 0, updated: 0, removed: 0 },
    ],
  };
  const zeroDay = shapeJobs(idle, { nowMs: NOW, todayIso: TODAY });
  assert.equal(zeroDay.available, false);
  assert.match(zeroDay.reason, /all at 0/);
  // A single closed zero day, with no previous row to replay, is caught too.
  const loneZeroDay = {
    ...JOBS_STATS,
    history: [{ date: '2026-08-07', totalJobs: 22645, added: 0, updated: 0, removed: 0 }],
  };
  assert.match(shapeJobs(loneZeroDay, { nowMs: NOW, todayIso: TODAY }).reason, /all at 0/);
  // No `todayIso` (no corpus clock to compare against) keeps the old behaviour.
  assert.equal(shapeJobs(JOBS_STATS, { nowMs: NOW }).available, true);
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
