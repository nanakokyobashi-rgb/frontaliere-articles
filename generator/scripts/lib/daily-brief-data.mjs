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
 *
 * Per-block degradation has no memory, and that is its blind spot: a source
 * that breaks for a morning and a payload that changes shape for good look
 * identical in the snapshot, in the log and in the run's exit code — the
 * edition just quietly gets shorter, every day, forever. `buildDailyBrief`
 * therefore carries a per-block streak forward from the previous snapshot, and
 * `degradationAlarms` is the single place where "absent or differently shaped"
 * stops being a note and becomes something a human is made to read.
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
 * How far back a malformed row can still change the corpus-advance verdict.
 *
 * The format check below is fail-closed on purpose, but its blast radius has to
 * stop where reading stops. Measured on the live payload (2026-09-05):
 * `jobs-stats.json` carries 164 rows back to 2026-03-20, and the guard reads
 * two of them — the newest closed day and its predecessor. Judging the format
 * of all 164 means one legacy archive row, or the partial row for the day in
 * progress that the guard deliberately scopes out, takes the whole jobs block
 * down for a shape nobody reads. Seven days is generous against the two rows
 * actually used and still excludes the archive.
 */
export const JOBS_HISTORY_WINDOW_DAYS = 7;
/**
 * Same reasoning for the exchange series: the block reads the last two points
 * and the newest point at or before `lastDate - 7d`, and refuses anything older
 * than `EXCHANGE_MAX_AGE_DAYS`. Nothing before that horizon is read.
 */
const EXCHANGE_WINDOW_DAYS = EXCHANGE_MAX_AGE_DAYS + 7;
/**
 * A block degraded for this many editions in a row is not a source outage: it
 * is a contract that changed upstream and nobody noticed. See
 * `degradationAlarms`.
 */
export const MAX_CONSECUTIVE_DEGRADED_EDITIONS = 3;

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

/** `toFiniteNumber`, but `null` (not `NaN`) for anything unreadable. */
function finiteOrNull(value) {
  const n = toFiniteNumber(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * UTC-midnight ms for a canonical day string, `NaN` for anything else.
 *
 * "Canonical" has to mean a day that EXISTS, not just the right count of
 * digits. The ISO parser accepts `2026-02-31` and answers March 3, so such a
 * row would sort in February and be measured in March; and where the parser
 * does refuse (`2026-13-40`), the `NaN` used to slip through the lag rule,
 * because `NaN > JOBS_HISTORY_MAX_LAG_DAYS` is false and the guard then
 * answered "corpus fine" off a date that does not exist. The round-trip on
 * `getUTCDate()` closes both.
 */
function isoDayMs(value) {
  if (!ISO_DAY_RE.test(value ?? '')) return NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).getUTCDate() === Number(value.slice(8, 10)) ? ms : NaN;
}

/**
 * The non-canonical rows of a dated series that could still be inside the
 * window the caller actually reads.
 *
 * A non-canonical date is a finding rather than a row to drop, because both
 * series here are ordered and windowed with string comparison and a
 * `2026-8-6` sorts AFTER `2026-08-08`: dropping it would empty the window and
 * return "source fine", which is the exact silent-staleness shape these guards
 * exist to close. But that reasoning only holds for rows the guard reads. A row
 * older than the window cannot reach any verdict, whether it is kept or
 * dropped, so reporting it degrades the block for a shape that is not used.
 *
 * A row can usually still be PLACED even when it cannot be ordered: `2026-8-6`
 * is a real day, it just is not zero-padded. One that places before the window
 * is archive; one that places inside it, or that cannot be placed at all (so it
 * cannot be excluded either), is the finding.
 *
 * The placement is deliberately NOT `Date.parse`: that reads a bare `2026-8-8`
 * as LOCAL midnight, which on a UTC+2 runner lands two hours before the UTC day
 * it names — enough to pull the partial row for the day in progress back inside
 * a window whose upper bound is exactly that boundary. `Date.UTC` on the parsed
 * components places every row on the same clock as `isoDayMs`.
 */
const LOOSE_DAY_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
function placeDayMs(value) {
  const m = LOOSE_DAY_RE.exec(typeof value === 'string' ? value : '');
  if (!m) return NaN;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Out-of-range components are refused, never normalised: `Date.UTC(2026, 12, 40)`
  // cheerfully answers 2027-02-09, which would place `2026-13-40` OUTSIDE the
  // window and let it slip past a check the scoping has to keep fail-closed
  // inside it. A row nobody can place stays a finding.
  if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;
  const ms = Date.UTC(year, month - 1, day);
  return new Date(ms).getUTCDate() === day ? ms : NaN;
}

function nonCanonicalInWindow(rows, { fromMs, toMs = Infinity }) {
  return rows.filter((row) => {
    // Rows that are not objects at all are the caller's business: in the jobs
    // history they are unreadable (and `h.date` would throw), in the exchange
    // series they carry no rate and drop out on their own.
    if (!row || typeof row !== 'object') return false;
    // Readable means "a real day", not "the right number of digits".
    if (Number.isFinite(isoDayMs(row.date))) return false;
    const placedMs = placeDayMs(row.date);
    if (!Number.isFinite(placedMs)) return true;
    return placedMs >= fromMs && placedMs < toMs;
  });
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
    // `decodeValue` returns null both for `nullValue` and for any Firestore
    // type it does not handle, and `Number(null)` is a finite 0: a crossing
    // with no reading would pass the filter below as a real 0-minute wait,
    // inflate `zeroWaitCount` and count toward the minimum-crossings gate.
    const wait = toFiniteNumber(d?.waitTimeMinutes);
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
    // `Number(x) || 0` turned an absent or null counter into a published fact:
    // the edition says "conviene fare il pieno in Svizzera in 0 casi" from a
    // summary that simply did not carry the field. Same class as the null wait
    // read as a 0-minute queue — `null` here means "not measured", and the copy
    // builder drops the sentence rather than asserting a zero.
    municipalityCount: finiteOrNull(summary.municipalityCount),
    cheaperItalyCount: finiteOrNull(summary.cheaperItalyCount),
    cheaperSwissCount: finiteOrNull(summary.cheaperSwissCount),
    tieCount: finiteOrNull(summary.tieCount),
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
  const todayMs = isoDayMs(todayIso);
  // Read before the format check, not after: without a day to measure against
  // there is no window to scope the check to, and the block degrades anyway.
  if (!Number.isFinite(todayMs)) return unavailable('todayIso missing/invalid');
  // Same reason as the jobs history: the series is ordered and windowed with
  // string comparison, so a non-canonical day is a finding, not a row to drop —
  // but only inside the window this block reads. A 1m series carries points the
  // freshness rule and the 7d lookback can never reach; one legacy point at its
  // head must not spend ~30 editions with the exchange block switched off.
  const nonCanonical = nonCanonicalInWindow(rawPoints, { fromMs: todayMs - EXCHANGE_WINDOW_DAYS * 24 * HOUR_MS });
  if (nonCanonical.length > 0) {
    const sample = JSON.stringify(nonCanonical[0]?.date ?? null);
    return unavailable(`${nonCanonical.length} exchange point(s) carry a date that is not YYYY-MM-DD (first: ${sample})`);
  }
  const points = rawPoints
    // Same coercion rule as the border-wait block: a point the producer emits
    // with a null rate must not read as a rate of 0.
    .map((p) => ({ date: p?.date, rate: toFiniteNumber(p?.rate) }))
    // Canonical only, so `last.date` is always orderable and the 7d lookback
    // below always has a real day to subtract from. Every non-canonical point
    // that could reach a verdict has already degraded above; what is left is
    // outside the window, and reading it is what the scoping decided not to do.
    .filter((p) => Number.isFinite(p.rate) && Number.isFinite(isoDayMs(p.date)))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 2) return unavailable(`only ${points.length} exchange points`);
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const lastMs = isoDayMs(last.date);
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
 * (or when the rows it reads carry too little signal to judge — in that case
 * the `generatedAt` guard remains the only one, as before).
 *
 * Abstention is for a series that is READABLE and inconclusive. Missing inputs
 * are not abstention: no `history` and no `todayIso` both degrade, because
 * "nobody could judge" published as "judged fine" is the whole failure this
 * function exists to close.
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
  // No clock, no verdict — and "no verdict" must not read as "corpus fine".
  // This was the last fail-open door left in the guard: `shapeJobs` without a
  // `todayIso` published `activeJobs` and a "new listings yesterday" figure
  // from a corpus nobody had judged. `buildDailyBrief` validates `todayIso`
  // and is the only caller today, so the door is shut before the next caller
  // finds it open — the same reason the `history` case is degraded one level
  // up rather than left to the producer's discretion. `shapeExchange` already
  // degrades on exactly this input.
  if (!Number.isFinite(todayMs)) {
    return `corpus-advance guard has no day to judge against (todayIso ${JSON.stringify(todayIso ?? null)}) — the jobs series is only readable relative to today`;
  }
  // An absent (or non-array) series is not "too little signal to judge": it is
  // NO corpus clock at all, and `generatedAt` — the only clock left — stays
  // fresh across a frozen corpus by construction. Degrading `history: []` while
  // letting `history` missing through would make the whole guard optional at
  // the producer's discretion, which is the fail-open shape this module exists
  // to close.
  if (!Array.isArray(stats?.history)) {
    return 'jobs-stats.json carries no history series — the corpus-advance guard has no clock to judge the corpus with';
  }
  const history = stats.history;

  // A row whose date is not canonical cannot be ordered against the others.
  // Dropping it would empty the window and return "corpus fine" — the exact
  // silent-staleness shape this guard exists to close — so a format change is
  // reported as a finding instead. Scoped to the closed-day window this guard
  // reads (`[today - JOBS_HISTORY_WINDOW_DAYS, today)`): the archive rows at the
  // head of the series and the partial row for the day in progress are outside
  // every verdict below, so their shape cannot make the block wrong.
  const malformed = history
    .filter((h) => !h || typeof h !== 'object')
    .concat(nonCanonicalInWindow(history, {
      fromMs: todayMs - JOBS_HISTORY_WINDOW_DAYS * 24 * HOUR_MS,
      toMs: todayMs,
    }));
  if (malformed.length > 0) {
    const sample = JSON.stringify(malformed[0]?.date ?? null);
    return `jobs history carries ${malformed.length} row(s) whose date is not YYYY-MM-DD (first: ${sample}) — the corpus-advance guard cannot read the series`;
  }

  // Canonical only, so `newest.date` is always orderable and `isoDayMs` below
  // is always finite. Every non-canonical row that could reach a verdict has
  // already degraded above; the ones left are archive outside the window, and
  // reading them is what the scoping just decided not to do.
  const rows = history
    .filter((h) => Number.isFinite(isoDayMs(h.date)) && h.date < todayIso)
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
  // No longer gated on `todayIso`: the guard above now degrades when the clock
  // is missing, so past this line there is always a canonical day, and the
  // `if (todayIso)` that used to wrap this rule was the second half of the same
  // fail-open door.
  const history = Array.isArray(stats.history) ? stats.history : [];
  const yesterdayIso = new Date(isoDayMs(todayIso) - 24 * HOUR_MS).toISOString().slice(0, 10);
  const entry = history.find((h) => h?.date === yesterdayIso);
  const yesterdayAdded = finiteOrNull(entry?.added);
  // The headline of the section IS this number. If the aggregator appends
  // yesterday's closed row only after the 05:05 cron, the block would go out
  // `available: true` with the figure missing — degrade instead, the same way
  // a stale row degrades. `refresh-daily-brief-data.mjs` counts how many
  // editions in a row this happens for: a late append is a morning, a lag that
  // repeats is a broken aggregator.
  if (yesterdayAdded === null) {
    return unavailable(`jobs history has no closed row for ${yesterdayIso} — no "new listings yesterday" figure to publish`);
  }
  return {
    available: true,
    generatedAt: stats.generatedAt,
    activeJobs,
    activeCompanies: finiteOrNull(totals.activeCompanies),
    todayAdded: finiteOrNull(totals.todayAdded),
    yesterdayAdded,
    last7dAdded: finiteOrNull(totals?.last7d?.added),
  };
}

/**
 * How many editions in a row this block has been degraded, counting this one.
 *
 * Per-block degradation is what keeps one broken crawler from taking down the
 * edition, but on its own it has no memory: a source that degrades once is a
 * morning, and a source that degrades every morning is indistinguishable from
 * it in the snapshot, in the log and in the run's exit code. The previous
 * streak therefore has to be durable: it is committed with every edition, in
 * the snapshot AND in the sidecar `degradationState` writes (the sidecar is
 * what survives the 0/4-blocks branch, which skips the snapshot — #885).
 *
 * A same-day rerun (the `workflow_dispatch` path, which rewrites today's
 * edition) inherits the streak instead of adding to it: rerunning the job is
 * not another edition.
 *
 * Two deliberate limits. The unit is EDITIONS, not days: only `dateIso` is
 * compared, so a run that never reached `writeJsonAtomic` (Firestore outage,
 * runner failure) does not advance the count, and three editions can span more
 * than three mornings — the alarm can arrive late, never early. And a snapshot
 * carrying no `degradedEditions` at all counts as 0, so a revert of this code
 * or a hand-edited snapshot silently restarts every streak: the count is a
 * cache of observations, not a ledger, and losing it costs a delay, never a
 * false alarm.
 */
function degradedEditions(block, previousStreak, { sameDay }) {
  if (block.available) return 0;
  return sameDay ? Math.max(previousStreak, 1) : previousStreak + 1;
}

/**
 * The one place that turns "this data is absent or shaped differently" into
 * something a human is made to look at.
 *
 * Every rule in this module degrades its own block, and an edition survives on
 * two of four — which is the point, and also the hole: a payload that changes
 * shape upstream (the aggregator trims `history`, a counter is renamed) makes
 * the block degrade *every* day, forever, while the run stays green and the
 * edition just gets shorter. "Less content, green run" is the failure mode
 * nothing else here can see, because nothing else here remembers yesterday.
 *
 * Three editions is the threshold: a source outage that lasts a morning or two
 * must stay a note in the log, and anything that survives three consecutive
 * runs is not an outage. The caller decides what "made to look at" means —
 * `refresh-daily-brief-data.mjs` announces it and hands the crossing to
 * `generate-daily-brief.yml`, which fails the run on a gate step placed AFTER
 * the commit (a red before it would skip the commit, so the streak would never
 * become durable and the same edition would cross again every morning).
 *
 * `crossed` is the edition on which the streak REACHES the threshold, read off
 * the previous snapshot: it is the only one that may be made fatal. A streak
 * only grows, so `>= threshold` is true every day from then on, and a caller
 * that fails on it would take the whole edition down every morning until a
 * human fixes the source — the exact opposite of the per-block degradation
 * this module exists to guarantee. The alarm still travels on the later days;
 * only its lethality is spent once. With no previous snapshot to compare (its
 * first read, or an unreadable one) the alarm counts as crossing: losing it is
 * worse than repeating it, and the next edition has a snapshot again.
 */
export function degradationAlarms(brief, previous = null) {
  return Object.entries(brief?.blocks || {})
    // Same reader as `previousDegradedEditions` below, deliberately: with one
    // side on `Number()` and the other on `Number.isFinite`, a snapshot whose
    // field round-tripped to the string "3" would raise the alarm and count as
    // a previous streak of 0 — every edition a fresh crossing, forever.
    .filter(([, b]) => !b?.available && blockDegradedEditions(b) >= MAX_CONSECUTIVE_DEGRADED_EDITIONS)
    .map(([block, b]) => ({
      block,
      editions: blockDegradedEditions(b),
      reason: b.reason,
      crossed: previousDegradedEditions(previous, block) < MAX_CONSECUTIVE_DEGRADED_EDITIONS,
    }));
}

/** The streak a block carries; anything unreadable counts as 0. */
function blockDegradedEditions(block) {
  return Number.isFinite(block?.degradedEditions) ? block.degradedEditions : 0;
}

/** The streak the previous snapshot recorded for `block`; absent counts as 0. */
function previousDegradedEditions(previous, block) {
  return blockDegradedEditions(previous?.blocks?.[block]);
}

/**
 * Assemble the full daily-brief payload. Raw inputs, one per source; each may
 * be null (fetch failed) — the corresponding block degrades on its own.
 *
 * `previous` is the snapshot the last edition wrote (`null` on a first run):
 * it carries nothing but the per-block degradation streaks forward.
 */
export function buildDailyBrief({ todayIso, nowMs = Date.now(), borderWaitDocs, fuelMetadata, exchangeDoc, jobsStats, previous = null }) {
  // Same test as everywhere else in the module: a day that exists. The raw
  // regex used to let `2026-02-31` through here and have it refused deeper in,
  // which wrote and committed a snapshot whose `dateIso` is a day nobody has —
  // and build-api.mjs publishes that field.
  if (!Number.isFinite(isoDayMs(todayIso))) {
    throw new Error(`buildDailyBrief: todayIso must be a real YYYY-MM-DD day, got ${JSON.stringify(todayIso)}`);
  }
  const sameDay = previous?.dateIso === todayIso;
  const blocks = {
    borderWait: shapeBorderWait(borderWaitDocs, { nowMs }),
    fuel: shapeFuel(fuelMetadata, { nowMs }),
    exchange: shapeExchange(exchangeDoc, { todayIso }),
    jobs: shapeJobs(jobsStats, { nowMs, todayIso }),
  };
  for (const [name, block] of Object.entries(blocks)) {
    block.degradedEditions = degradedEditions(block, previousDegradedEditions(previous, name), { sameDay });
  }
  const availableBlocks = Object.values(blocks).filter((b) => b.available).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    dateIso: todayIso,
    counts: {
      availableBlocks,
      crossings: blocks.borderWait.available ? blocks.borderWait.count : 0,
      // `?? 0` keeps the counter numeric for the payload's consumers now that an
      // unreadable summary field is `null` rather than a fabricated zero.
      fuelMunicipalities: blocks.fuel.available ? blocks.fuel.municipalityCount ?? 0 : 0,
      exchangePoints: blocks.exchange.available ? blocks.exchange.pointCount : 0,
      jobsActive: blocks.jobs.available ? blocks.jobs.activeJobs : 0,
    },
    blocks,
  };
}

/**
 * The per-block streaks, in the shape `degradationAlarms` and `buildDailyBrief`
 * already read — so the sidecar file that carries them across a day WITHOUT a
 * snapshot is the same reader, not a second one.
 *
 * Why a sidecar at all (#885). The streak used to ride only inside
 * `public/data/daily-brief.json`, and that snapshot is deliberately NOT
 * rewritten on the `0/4 blocks` branch (yesterday's copy is left in place).
 * So a total blackout re-read the same `previous` every morning, recomputed the
 * same streak of 1, and never reached the threshold: the one outage shape the
 * alarm exists for was the one shape it could not see.
 *
 * Writing the empty snapshot instead was the other candidate and is worse: it
 * would overwrite a good snapshot with a 0-block one, and `build-api.mjs`
 * refuses to publish that (`carries no available blocks`) — a bookkeeping
 * counter would take the whole API surface down.
 *
 * Not two sources of truth: this is derived from the same `brief` in the same
 * run, and the sidecar is the ONLY thing read back (the snapshot is a fallback
 * for the run that finds no sidecar yet, e.g. the first one after this lands).
 * `dateIso` rides along because a same-day rerun must inherit the streak
 * instead of adding to it.
 */
export function degradationState(brief) {
  return {
    schemaVersion: 1,
    dateIso: brief.dateIso,
    blocks: Object.fromEntries(
      Object.entries(brief?.blocks || {}).map(([name, b]) => [name, { degradedEditions: blockDegradedEditions(b) }]),
    ),
  };
}

/**
 * Whether `value` can be trusted as a carrier of the per-block streaks —
 * the sidecar ledger or, as its fallback, the previous snapshot.
 *
 * Parsing is not validating, and here the difference is silent. Every reader
 * of the streaks (`previousDegradedEditions` → `blockDegradedEditions`) is
 * deliberately forgiving: anything it cannot read counts as 0. That
 * forgiveness is right for ONE missing block and catastrophic for a whole
 * carrier of the wrong shape — a `[]`, a `{"blocks": 5}`, a half-written
 * hand edit all read as "every streak is 0", so every count restarts, a
 * permanent degradation never crosses the threshold again, and nothing says a
 * word. That is #885 with a different file, which is why the shape is checked
 * once, here, instead of at each read site.
 *
 * The requirements are exactly what `degradationState` writes and the readers
 * need: a real `dateIso` (a same-day rerun must be recognisable, or it
 * double-counts) and a non-empty `blocks` map of per-block objects. Anything
 * else is not "a ledger with holes", it is a different document, and the
 * caller must fall back rather than believe it.
 */
export function isDegradationCarrier(value) {
  if (!isPlainObject(value)) return false;
  if (!Number.isFinite(isoDayMs(value.dateIso))) return false;
  if (!isPlainObject(value.blocks)) return false;
  const entries = Object.entries(value.blocks);
  return entries.length > 0 && entries.every(([, block]) => isPlainObject(block));
}

/** A JSON object, not an array and not null — `typeof x === 'object'` is both. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
