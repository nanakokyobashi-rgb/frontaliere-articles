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
  const points = (Array.isArray(doc.points) ? doc.points : [])
    .filter((p) => p && typeof p.date === 'string' && Number.isFinite(Number(p.rate)))
    .map((p) => ({ date: p.date, rate: Number(p.rate) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 2) return unavailable(`only ${points.length} exchange points`);
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const todayMs = Date.parse(todayIso || '');
  const lastMs = Date.parse(last.date);
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

/** Jobs block from the CDN `jobs-stats.json` payload. */
export function shapeJobs(stats, { nowMs = Date.now(), todayIso } = {}) {
  if (!stats || typeof stats !== 'object') return unavailable('jobs-stats.json missing');
  const generatedMs = Date.parse(stats.generatedAt || '');
  if (!Number.isFinite(generatedMs)) return unavailable('jobs-stats.json has no generatedAt');
  if (nowMs - generatedMs > JOBS_MAX_AGE_MS) {
    return unavailable(`jobs stats are ${Math.round((nowMs - generatedMs) / HOUR_MS)}h old (max ${JOBS_MAX_AGE_MS / HOUR_MS}h)`);
  }
  const totals = stats.totals || {};
  const activeJobs = Number(totals.activeJobs);
  if (!Number.isFinite(activeJobs) || activeJobs <= 0) return unavailable('jobs stats carry no activeJobs total');
  // The morning cron runs before the day has accumulated: "yesterday" from the
  // history series is the honest daily number, todayAdded is the live partial.
  let yesterdayAdded = null;
  if (todayIso && Array.isArray(stats.history)) {
    const yesterdayIso = new Date(Date.parse(todayIso) - 24 * HOUR_MS).toISOString().slice(0, 10);
    const entry = stats.history.find((h) => h?.date === yesterdayIso);
    if (entry && Number.isFinite(Number(entry.added))) yesterdayAdded = Number(entry.added);
  }
  return {
    available: true,
    generatedAt: stats.generatedAt,
    activeJobs,
    activeCompanies: Number.isFinite(Number(totals.activeCompanies)) ? Number(totals.activeCompanies) : null,
    todayAdded: Number.isFinite(Number(totals.todayAdded)) ? Number(totals.todayAdded) : null,
    yesterdayAdded,
    last7dAdded: Number.isFinite(Number(totals?.last7d?.added)) ? Number(totals.last7d.added) : null,
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
