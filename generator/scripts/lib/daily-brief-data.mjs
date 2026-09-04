/**
 * Daily-brief data shaping — the pure half of refresh-daily-brief-data.mjs.
 *
 * Turns the four raw sources of the "Bollettino del Frontaliere" (Firestore
 * `trafficCurrent`, Firestore `fuelPrices/metadata`, Firestore
 * `exchangeHistory/chf-eur-1m`, the CDN `jobs-stats.json`) into the
 * `public/data/daily-brief.json` payload. No I/O here: the fetch layer lives
 * in the refresh script, so `node --test` can exercise every degradation rule
 * with fixtures.
 *
 * Degradation is per block, never per file: a stale or missing source turns
 * its block into `{ available: false, reason }` and the edition drops that
 * section with a note — one broken crawler must not take down the whole daily
 * edition (same discipline as manifest.json's counts: a consumer can refuse a
 * truncated set *before* using it, per block).
 */

const HOUR_MS = 60 * 60 * 1000;

/** A block whose source is fresh no longer than this is publishable. */
export const BORDER_WAIT_MAX_AGE_MS = 6 * HOUR_MS;
/** Individual crossings older than this are dropped before ranking. */
export const BORDER_WAIT_DOC_MAX_AGE_MS = 24 * HOUR_MS;
/**
 * Fewer fresh crossings than this means the collector is mid-outage: a "top
 * waits" ranking over a sliver of the border would be wrong, not just thin.
 */
export const BORDER_WAIT_MIN_CROSSINGS = 30;
export const FUEL_MAX_AGE_MS = 48 * HOUR_MS;
/** FX has weekend gaps; five calendar days tolerates Fri→Wed without lying. */
export const EXCHANGE_MAX_AGE_DAYS = 5;
export const JOBS_MAX_AGE_MS = 48 * HOUR_MS;
/**
 * `jobs-stats.json` carries two independent clocks and only one of them is the
 * corpus. `generatedAt` is stamped by the stats aggregator, which runs on its
 * own schedule and re-emits a payload whether or not new job data landed —
 * so it stays fresh across a frozen corpus and the block above never degrades.
 * `history` is the corpus clock: one row per day, sourced from the data that
 * was actually pushed.
 *
 * Measured, not hypothetical: on 2026-08-30 the series carried a row that was
 * a field-for-field replay of 2026-08-29 (`totalJobs` 22943, `added` 33,
 * `updated` 22557, `removed` 3), then caught up with a +5982 spike on 09-01.
 * `generatedAt` was fresh throughout, so the edition published a carried-over
 * "new listings yesterday" figure as fact. Same silent-staleness shape as
 * a tolerated push-contention loss upstream: nothing fails, the number is just
 * old (#744).
 *
 * `shapeExchange` already keys on the data's own advance (the last point's
 * `date`) rather than on a producer timestamp; these two rules give the jobs
 * block the same property.
 */
/**
 * The newest CLOSED history day may lag `todayIso` by at most this many days.
 *
 * The healthy baseline is **1**, not 0: the tail of the raw series is the day
 * in progress, which the guard scopes out, so on a corpus that is advancing
 * normally the newest closed day is always yesterday. A lag of 2 therefore
 * already means the closed row for D-1 never landed — the same state in which
 * `shapeJobs` would have no `yesterdayAdded` to headline with. So 1 is both
 * the tightest and the only honest value: raising it buys nothing but extra
 * calendar days of a frozen corpus published as fact.
 */
export const JOBS_HISTORY_MAX_LAG_DAYS = 1;
/** Counters compared field-for-field to detect a replayed (frozen) day. */
const JOBS_HISTORY_COUNTERS = ['totalJobs', 'added', 'updated', 'removed'];
/** Counters that must move on a day the crawler actually ran. */
const JOBS_HISTORY_MOVEMENT_COUNTERS = ['added', 'updated', 'removed'];

/**
 * Canonical `YYYY-MM-DD`. Both date series here are ordered and windowed with
 * string comparison (`a.date.localeCompare(b.date)`, `date < todayIso`), which
 * is only sound on zero-padded days: a row emitted as `2026-8-6` sorts AFTER
 * `2026-08-08` and would silently fall out of every window, making the guards
 * fail *open*. So the shape is validated, and a violation is a signal rather
 * than something to drop quietly.
 */
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `Number(null)` is 0 and `Number('')` is 0, so a counter the aggregator emits
 * as null would read as a real zero — the same "0 published as a fact" shape
 * the zero-day rule below exists to stop. Only actual numbers (and numeric
 * strings) count.
 */
function toFiniteNumber(value) {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value)
      : NaN;
  return Number.isFinite(n) ? n : NaN;
}

/** UTC-midnight ms for a canonical day string, `NaN` for anything else. */
function isoDayMs(value) {
  return ISO_DAY_RE.test(value ?? '') ? Date.parse(`${value}T00:00:00Z`) : NaN;
}

/** Decode a single Firestore REST value into plain JS. */
export function decodeValue(v) {
  if (v == null || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}

/** Decode a Firestore REST `fields` map into a plain object. */
export function decodeFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function unavailable(reason) {
  return { available: false, reason };
}

const round = (n, digits = 0) => {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/**
 * Border-wait block from decoded `trafficCurrent` docs.
 * @param {Array<{slug: string, waitTimeMinutes?: number, crossingName?: string,
 *   status?: string, direction?: string, lastUpdate?: string}>} docs
 */
export function shapeBorderWait(docs, { nowMs = Date.now() } = {}) {
  if (!Array.isArray(docs) || docs.length === 0) return unavailable('trafficCurrent returned no documents');
  const rows = [];
  let newestMs = 0;
  for (const d of docs) {
    const wait = Number(d?.waitTimeMinutes);
    const updatedMs = Date.parse(d?.lastUpdate || '');
    if (!Number.isFinite(wait) || wait < 0) continue;
    if (!Number.isFinite(updatedMs) || nowMs - updatedMs > BORDER_WAIT_DOC_MAX_AGE_MS) continue;
    newestMs = Math.max(newestMs, updatedMs);
    rows.push({
      slug: d.slug,
      name: d.crossingName || d.slug,
      waitMinutes: Math.round(wait),
      status: d.status || null,
      direction: d.direction || null,
    });
  }
  if (rows.length < BORDER_WAIT_MIN_CROSSINGS) {
    return unavailable(`only ${rows.length} fresh crossings (min ${BORDER_WAIT_MIN_CROSSINGS})`);
  }
  if (nowMs - newestMs > BORDER_WAIT_MAX_AGE_MS) {
    return unavailable(`newest crossing update is ${Math.round((nowMs - newestMs) / HOUR_MS)}h old (max ${BORDER_WAIT_MAX_AGE_MS / HOUR_MS}h)`);
  }
  rows.sort((a, b) => b.waitMinutes - a.waitMinutes || a.name.localeCompare(b.name));
  const worst = rows[0];
  return {
    available: true,
    updatedAt: new Date(newestMs).toISOString(),
    count: rows.length,
    zeroWaitCount: rows.filter((r) => r.waitMinutes === 0).length,
    worst: { slug: worst.slug, name: worst.name, waitMinutes: worst.waitMinutes },
    crossings: rows,
  };
}

/** Fuel block from the decoded `fuelPrices/metadata` doc (summary + rankings). */
export function shapeFuel(meta, { nowMs = Date.now() } = {}) {
  if (!meta || typeof meta !== 'object') return unavailable('fuelPrices/metadata missing');
  const generatedMs = Date.parse(meta.generatedAt || '');
  if (!Number.isFinite(generatedMs)) return unavailable('fuelPrices/metadata has no generatedAt');
  if (nowMs - generatedMs > FUEL_MAX_AGE_MS) {
    return unavailable(`fuel data is ${Math.round((nowMs - generatedMs) / HOUR_MS)}h old (max ${FUEL_MAX_AGE_MS / HOUR_MS}h)`);
  }
  const summary = meta.summary || {};
  const rankings = meta.rankings || {};
  const cheapestItaly = (Array.isArray(rankings.cheapestItalyMunicipalities) ? rankings.cheapestItalyMunicipalities : [])
    .map((m) => ({
      municipality: m?.municipality ?? null,
      province: m?.province ?? null,
      minPriceEur: round(m?.minPriceEur, 3),
      stationName: m?.cheapestStation?.stationName ?? null,
    }))
    .filter((m) => m.municipality && m.minPriceEur != null)
    .slice(0, 5);
  const bestSavings = (Array.isArray(rankings.bestCrossBorderSavings) ? rankings.bestCrossBorderSavings : [])
    .map((m) => ({
      municipality: m?.municipality ?? null,
      province: m?.province ?? null,
      cheaperCountry: m?.cheaperCountry ?? null,
      italyPriceEur: round(m?.italyPriceEur, 3),
      swissPriceEur: round(m?.swissPriceEur, 3),
      swissPriceChf: round(m?.swissPriceChf, 3),
      saving50LEur: round(m?.saving50LEur, 2),
    }))
    .filter((m) => m.municipality && m.saving50LEur != null)
    .slice(0, 3);
  if (cheapestItaly.length === 0 && bestSavings.length === 0) {
    return unavailable('fuel rankings are empty');
  }
  const cheapestSwiss = summary.cheapestSwissStation || null;
  return {
    available: true,
    generatedAt: meta.generatedAt,
    municipalityCount: Number(summary.municipalityCount) || 0,
    cheaperItalyCount: Number(summary.cheaperItalyCount) || 0,
    cheaperSwissCount: Number(summary.cheaperSwissCount) || 0,
    tieCount: Number(summary.tieCount) || 0,
    cheapestItaly,
    bestSavings,
    cheapestSwissStation: cheapestSwiss
      ? {
          name: cheapestSwiss.name ?? null,
          sp95PriceChf: round(cheapestSwiss.sp95PriceChf, 3),
          sp95PriceEur: round(cheapestSwiss.sp95PriceEur, 3),
          nearestMunicipality: cheapestSwiss.nearestMunicipality ?? null,
        }
      : null,
  };
}

/**
 * Exchange block from the decoded `exchangeHistory/chf-eur-1m` doc.
 * `todayIso` (not wall-clock) drives staleness so tests and TODAY_ISO runs agree.
 */
export function shapeExchange(doc, { todayIso } = {}) {
  if (!doc || typeof doc !== 'object') return unavailable('exchangeHistory/chf-eur-1m missing');
  const rawPoints = Array.isArray(doc.points) ? doc.points : [];
  // Same reason as the jobs history: the series is ordered and windowed with
  // string comparison, so a non-canonical day is a finding, not a row to drop.
  const nonCanonical = rawPoints.filter((p) => p && typeof p === 'object' && !ISO_DAY_RE.test(p.date ?? ''));
  if (nonCanonical.length > 0) {
    const sample = JSON.stringify(nonCanonical[0]?.date ?? null);
    return unavailable(`${nonCanonical.length} exchange point(s) carry a date that is not YYYY-MM-DD (first: ${sample})`);
  }
  const points = rawPoints
    .filter((p) => p && Number.isFinite(Number(p.rate)))
    .map((p) => ({ date: p.date, rate: Number(p.rate) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 2) return unavailable(`only ${points.length} exchange points`);
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const todayMs = isoDayMs(todayIso);
  const lastMs = isoDayMs(last.date);
  if (!Number.isFinite(todayMs)) return unavailable('todayIso missing/invalid');
  const ageDays = (todayMs - lastMs) / (24 * HOUR_MS);
  if (ageDays > EXCHANGE_MAX_AGE_DAYS) {
    return unavailable(`latest exchange point (${last.date}) is ${Math.round(ageDays)}d old (max ${EXCHANGE_MAX_AGE_DAYS}d)`);
  }
  const weekAgoIso = new Date(lastMs - 7 * 24 * HOUR_MS).toISOString().slice(0, 10);
  const weekAgo = [...points].reverse().find((p) => p.date <= weekAgoIso) || null;
  return {
    available: true,
    rate: round(last.rate, 4),
    lastDate: last.date,
    prevRate: round(prev.rate, 4),
    prevDate: prev.date,
    delta1d: round(last.rate - prev.rate, 4),
    rate7dAgo: weekAgo ? round(weekAgo.rate, 4) : null,
    delta7d: weekAgo ? round(last.rate - weekAgo.rate, 4) : null,
    source: doc.source ?? null,
    pointCount: points.length,
  };
}

/**
 * Corpus-advance check over the `history` series. Returns a degradation reason
 * when the corpus has visibly stopped moving, or `null` when it has advanced
 * (or when the series carries too little signal to judge — in that case the
 * `generatedAt` guard remains the only one, as before).
 *
 * Only CLOSED days are read. The aggregator seeds a `history` row for the day
 * in progress that mirrors the live partials in `totals`, so the raw tail of
 * the series is always "today": comparing it against `todayIso` would make the
 * lag rule inert, and comparing it field-for-field against a full day would put
 * two non-homogeneous quantities side by side. Scoping to `date < todayIso` is
 * the same idiom `windowFileNames` uses for the border-wait window, which ends
 * the day BEFORE `todayIso` for this reason.
 */
export function jobsCorpusFrozenReason(stats, { todayIso } = {}) {
  const todayMs = isoDayMs(todayIso);
  if (!Number.isFinite(todayMs)) return null;
  const history = Array.isArray(stats?.history) ? stats.history : [];

  // A row whose date is not canonical cannot be ordered against the others.
  // Dropping it would empty the window and return "corpus fine" — the exact
  // silent-staleness shape this guard exists to close — so a format change is
  // reported as a finding instead.
  const malformed = history.filter((h) => !h || typeof h !== 'object' || !ISO_DAY_RE.test(h.date ?? ''));
  if (malformed.length > 0) {
    const sample = JSON.stringify(malformed[0]?.date ?? null);
    return `jobs history carries ${malformed.length} row(s) whose date is not YYYY-MM-DD (first: ${sample}) — the corpus-advance guard cannot read the series`;
  }

  const rows = history
    .filter((h) => h.date < todayIso)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) return null;

  const newest = rows[rows.length - 1];
  // Both operands are UTC midnight of a canonical day, so the quotient is a
  // whole number of civil days; `Math.floor` keeps it that way even if a row
  // ever carried a time component, where rounding up would degrade a corpus
  // that had in fact advanced.
  const lagDays = Math.floor((todayMs - isoDayMs(newest.date)) / (24 * HOUR_MS));
  if (lagDays > JOBS_HISTORY_MAX_LAG_DAYS) {
    return `jobs history stops at ${newest.date}, ${lagDays}d before ${todayIso} (max ${JOBS_HISTORY_MAX_LAG_DAYS}d) — corpus is not advancing`;
  }

  // The zero-day rule is decided on the movement counters ALONE, and before the
  // four-field completeness check that only the replay rule needs. Requiring
  // `totalJobs`/`updated`/`removed` up front would return "corpus fine" on a
  // row that carries just `totalJobs` and `added` — the very shape this
  // module's own healthy fixture uses — so the rule would be inert on the
  // producer shape it is most likely to meet, and `added: 0` would headline the
  // edition as "0 new listings yesterday".
  const movement = JOBS_HISTORY_MOVEMENT_COUNTERS
    .map((key) => ({ key, value: toFiniteNumber(newest[key]) }))
    .filter(({ value }) => Number.isFinite(value));

  // With the lag rule satisfied the newest closed row IS D-1, the row whose
  // `added` the section headlines with. A D-1 carrying no readable movement
  // counter at all says nothing about whether the crawler ran, so the guard
  // degrades rather than passing an unjudged corpus (`NaN === 0` is false, so
  // staying silent here would be failing open by accident rather than by
  // decision).
  if (movement.length === 0) {
    return `jobs history day ${newest.date} carries no readable added/updated/removed — the corpus-advance guard cannot tell whether the crawler ran`;
  }

  // A CLOSED day on which nothing was added, updated or removed is not an idle
  // day on this corpus — it has thousands of daily updates — it is a crawler
  // that did not run. Publishing it would put "0 new listings yesterday" in the
  // edition as a fact, which is worse than dropping the section. Judged on the
  // counters the row actually carries: an absent counter is not a zero.
  if (movement.every(({ value }) => value === 0)) {
    const carried = movement.map(({ key }) => key).join('/');
    return `jobs history day ${newest.date} closed with ${carried} all at 0 — the crawler did not run, that is not a quiet day`;
  }

  // A row can be present, and moving, and still be a replay of the previous
  // day. With the all-zero case handled above, a field-for-field match of every
  // counter on a day that moved is implausible as a coincidence. This is the
  // one rule that needs all four counters on BOTH rows: without them there is
  // nothing to compare, so it abstains instead of degrading.
  if (rows.length < 2) return null;
  const prev = rows[rows.length - 2];
  const pairs = JOBS_HISTORY_COUNTERS.map((key) => [toFiniteNumber(newest[key]), toFiniteNumber(prev[key])]);
  if (!pairs.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b))) return null;
  const replayed = pairs.every(([a, b]) => a === b);
  if (replayed) {
    return `jobs history day ${newest.date} replays ${prev.date} field-for-field — corpus did not advance`;
  }
  return null;
}

/** Jobs block from the CDN `jobs-stats.json` payload. */
export function shapeJobs(stats, { nowMs = Date.now(), todayIso } = {}) {
  if (!stats || typeof stats !== 'object') return unavailable('jobs-stats.json missing');
  const generatedMs = Date.parse(stats.generatedAt || '');
  if (!Number.isFinite(generatedMs)) return unavailable('jobs-stats.json has no generatedAt');
  if (nowMs - generatedMs > JOBS_MAX_AGE_MS) {
    return unavailable(`jobs stats are ${Math.round((nowMs - generatedMs) / HOUR_MS)}h old (max ${JOBS_MAX_AGE_MS / HOUR_MS}h)`);
  }
  const totals = stats.totals || {};
  const activeJobs = toFiniteNumber(totals.activeJobs);
  if (!Number.isFinite(activeJobs) || activeJobs <= 0) return unavailable('jobs stats carry no activeJobs total');
  const frozenReason = jobsCorpusFrozenReason(stats, { todayIso });
  if (frozenReason) return unavailable(frozenReason);
  // The morning cron runs before the day has accumulated: "yesterday" from the
  // history series is the honest daily number, todayAdded is the live partial.
  let yesterdayAdded = null;
  if (todayIso && Array.isArray(stats.history)) {
    const yesterdayIso = new Date(isoDayMs(todayIso) - 24 * HOUR_MS).toISOString().slice(0, 10);
    const entry = stats.history.find((h) => h?.date === yesterdayIso);
    const added = toFiniteNumber(entry?.added);
    if (Number.isFinite(added)) yesterdayAdded = added;
    // The headline of the section IS this number. If the aggregator appends
    // yesterday's closed row only after the 05:05 cron, the block would go out
    // `available: true` with the figure missing — degrade instead, the same way
    // a stale row degrades.
    if (yesterdayAdded === null) {
      return unavailable(`jobs history has no closed row for ${yesterdayIso} — no "new listings yesterday" figure to publish`);
    }
  }
  return {
    available: true,
    generatedAt: stats.generatedAt,
    activeJobs,
    activeCompanies: Number.isFinite(toFiniteNumber(totals.activeCompanies)) ? toFiniteNumber(totals.activeCompanies) : null,
    todayAdded: Number.isFinite(toFiniteNumber(totals.todayAdded)) ? toFiniteNumber(totals.todayAdded) : null,
    yesterdayAdded,
    last7dAdded: Number.isFinite(toFiniteNumber(totals?.last7d?.added)) ? toFiniteNumber(totals.last7d.added) : null,
  };
}

/**
 * Assemble the full daily-brief payload. Raw inputs, one per source; each may
 * be null (fetch failed) — the corresponding block degrades on its own.
 */
export function buildDailyBrief({ todayIso, nowMs = Date.now(), borderWaitDocs, fuelMetadata, exchangeDoc, jobsStats }) {
  if (!todayIso || !/^\d{4}-\d{2}-\d{2}$/.test(todayIso)) {
    throw new Error(`buildDailyBrief: todayIso must be YYYY-MM-DD, got ${JSON.stringify(todayIso)}`);
  }
  const blocks = {
    borderWait: shapeBorderWait(borderWaitDocs, { nowMs }),
    fuel: shapeFuel(fuelMetadata, { nowMs }),
    exchange: shapeExchange(exchangeDoc, { todayIso }),
    jobs: shapeJobs(jobsStats, { nowMs, todayIso }),
  };
  const availableBlocks = Object.values(blocks).filter((b) => b.available).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    dateIso: todayIso,
    counts: {
      availableBlocks,
      crossings: blocks.borderWait.available ? blocks.borderWait.count : 0,
      fuelMunicipalities: blocks.fuel.available ? blocks.fuel.municipalityCount : 0,
      exchangePoints: blocks.exchange.available ? blocks.exchange.pointCount : 0,
      jobsActive: blocks.jobs.available ? blocks.jobs.activeJobs : 0,
    },
    blocks,
  };
}
