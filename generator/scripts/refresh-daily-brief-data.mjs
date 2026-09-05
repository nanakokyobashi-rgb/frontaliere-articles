#!/usr/bin/env node
/**
 * Fetch the day's proprietary data and write `public/data/daily-brief.json` —
 * the snapshot the "Bollettino del Frontaliere" daily edition is written from.
 *
 * Sources (all read-only):
 *   - Firestore `trafficCurrent`            → border-wait block (141 crossings)
 *   - Firestore `fuelPrices/metadata`       → fuel block (pre-computed rankings)
 *   - Firestore `exchangeHistory/chf-eur-1m`→ CHF→EUR block
 *   - CDN `data/jobs-stats.json`            → jobs block (public HTTP, no auth)
 *
 * Firestore goes through the REST API with a service-account token from
 * lib/google-service-account-token.mjs — NOT firebase-admin: this repo has no
 * node_modules by design and the REST path is the supported one (same as
 * load-rc-env.mjs). Every source degrades per block (see lib/daily-brief-data);
 * only zero available blocks skips the write, and still exits 0 — a day
 * without data must not break the cron (the article generator then refuses the
 * stale snapshot on its own dateIso check).
 *
 * Usage:
 *   npx -y tsx@4 generator/scripts/refresh-daily-brief-data.mjs
 *   DRY_RUN=1 …    # fetch + print the plan, write nothing
 *   TODAY_ISO=2026-08-08 …   # pin "today" (tests/CI)
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getServiceAccountAccessToken } from './lib/google-service-account-token.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { decodeFields, buildDailyBrief, degradationAlarms, MAX_CONSECUTIVE_DEGRADED_EDITIONS } from './lib/daily-brief-data.mjs';
import { MIN_AVAILABLE_BLOCKS } from './lib/daily-brief-content.mjs';
import { isRetryableRcFetchStatus, rcFetchBackoffMs, RC_FETCH_ATTEMPTS, extractGoogleErrorReason } from './load-rc-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const OUTPUT_PATH = path.join(REPO_ROOT, 'public', 'data', 'daily-brief.json');

const PROJECT_ID = 'frontaliere-ticino';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
export const JOBS_STATS_URL = 'https://cdn.frontaliereticino.ch/data/jobs-stats.json';
const FETCH_TIMEOUT_MS = 30_000;

// Same class of bug as #45/#54/#171 (load-rc-env.mjs's fetchTemplateViaRest):
// a single-attempt fetch against a Google API treats a transient 429/5xx as a
// hard failure, degrading the whole block for what a retry would have solved.
// Shared with load-rc-env.mjs/google-service-account-token.mjs (#263) rather
// than pinned locally, so the per-minute-quota backoff budget stays one value.
const FETCH_ATTEMPTS = RC_FETCH_ATTEMPTS;

async function fetchJson(url, headers = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.ok) return res.json();
    // A 403 needs the body to tell a transient quota rejection apart from a
    // real PERMISSION_DENIED — same reasoning as fetchTemplateViaRest in
    // load-rc-env.mjs (#247/#683).
    const bodyText = await res.text().catch(() => '');
    const reason = extractGoogleErrorReason(bodyText);
    lastErr = new Error(`GET ${url} → HTTP ${res.status}${reason ? ` (${reason})` : ''}`);
    if (!isRetryableRcFetchStatus(res.status, reason)) throw lastErr;
    if (attempt < FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, rcFetchBackoffMs(attempt)));
  }
  throw lastErr;
}

/** List every doc of a root collection (paginated), decoded, with `slug` = doc id. */
async function listCollectionDocs(token, collectionId) {
  const docs = [];
  let pageToken = '';
  do {
    const url = `${FIRESTORE_BASE}/${collectionId}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const page = await fetchJson(url, { Authorization: `Bearer ${token}` });
    for (const doc of page.documents || []) {
      docs.push({ slug: doc.name.split('/').pop(), ...decodeFields(doc.fields) });
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return docs;
}

/** Get a single doc, decoded. Throws on non-404 errors (retrying 429/5xx); 404 → null (degrade). */
async function getDoc(token, docPath) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const res = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (res.ok) {
      const doc = await res.json();
      return decodeFields(doc.fields);
    }
    // Same quota-shaped-as-403 case as fetchJson above.
    const bodyText = await res.text().catch(() => '');
    const reason = extractGoogleErrorReason(bodyText);
    lastErr = new Error(`GET ${docPath} → HTTP ${res.status}${reason ? ` (${reason})` : ''}`);
    if (!isRetryableRcFetchStatus(res.status, reason)) throw lastErr;
    if (attempt < FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, rcFetchBackoffMs(attempt)));
  }
  throw lastErr;
}

function loadServiceAccountCreds() {
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credsPath) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set — cannot read Firestore (this is a config error, not a data outage)');
  }
  return JSON.parse(readFileSync(credsPath, 'utf-8'));
}

/** Fetch one source, degrading to null on failure (logged, never fatal). */
async function tryFetch(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`⚠️  ${label} fetch failed — block will degrade: ${err.message}`);
    return null;
  }
}

/**
 * Yesterday's snapshot, or `null` when there is none to read. The only durable
 * state this pipeline has: it carries the per-block degradation streaks that
 * `degradationAlarms` reads. Unreadable is the same as absent — a snapshot that
 * cannot be parsed must not stop today's refresh, it just restarts the count.
 */
export function readPreviousSnapshot(snapshotPath = OUTPUT_PATH) {
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  } catch {
    return null;
  }
}

export async function collectDailyBrief({ todayIso, nowMs = Date.now(), previous = readPreviousSnapshot() } = {}) {
  const creds = loadServiceAccountCreds();
  const token = await getServiceAccountAccessToken(creds, FIRESTORE_SCOPE);
  const [borderWaitDocs, fuelMetadata, exchangeDoc, jobsStats] = await Promise.all([
    tryFetch('trafficCurrent', () => listCollectionDocs(token, 'trafficCurrent')),
    tryFetch('fuelPrices/metadata', () => getDoc(token, 'fuelPrices/metadata')),
    tryFetch('exchangeHistory/chf-eur-1m', () => getDoc(token, 'exchangeHistory/chf-eur-1m')),
    tryFetch('jobs-stats', () => fetchJson(JOBS_STATS_URL)),
  ]);
  return buildDailyBrief({ todayIso, nowMs, borderWaitDocs, fuelMetadata, exchangeDoc, jobsStats, previous });
}

/** `DEGRADED (3rd edition in a row) — reason`: the streak belongs in the log. */
function degradedLine(block) {
  const n = block.degradedEditions;
  const streak = Number.isFinite(n) && n > 1 ? ` (${n} editions in a row)` : '';
  return `DEGRADED${streak} — ${block.reason}`;
}

function printPlan(brief) {
  const { blocks, counts } = brief;
  console.log(`📋 daily brief ${brief.dateIso} — ${counts.availableBlocks}/4 blocks available`);
  const b = blocks.borderWait;
  console.log(b.available
    ? `  🛃 borderWait: ${b.count} crossings, worst ${b.worst.name} ${b.worst.waitMinutes}min, ${b.zeroWaitCount} at zero`
    : `  🛃 borderWait: ${degradedLine(b)}`);
  const f = blocks.fuel;
  console.log(f.available
    ? `  ⛽ fuel: ${f.municipalityCount ?? '?'} municipalities, cheapest IT ${f.cheapestItaly[0]?.municipality ?? 'n/a'} ${f.cheapestItaly[0]?.minPriceEur ?? ''}€/L, CH cheaper in ${f.cheaperSwissCount ?? '?'}`
    : `  ⛽ fuel: ${degradedLine(f)}`);
  const e = blocks.exchange;
  console.log(e.available
    ? `  💱 exchange: 1 CHF = ${e.rate}€ (${e.lastDate}), Δ1d ${e.delta1d}, Δ7d ${e.delta7d}`
    : `  💱 exchange: ${degradedLine(e)}`);
  const j = blocks.jobs;
  console.log(j.available
    ? `  💼 jobs: ${j.activeJobs} active, +${j.yesterdayAdded ?? '?'} yesterday, +${j.last7dAdded ?? '?'} in 7d`
    : `  💼 jobs: ${degradedLine(j)}`);
  // The edition that will not exist is worth one explicit line. Without it the
  // only trace of a day with no bulletin is `3/4 blocks` above and a commit
  // step that finds nothing staged, both of which look like a normal run.
  if (counts.availableBlocks < MIN_AVAILABLE_BLOCKS) {
    console.warn(`⚠️  NO EDITION TODAY: ${counts.availableBlocks} available blocks, ${MIN_AVAILABLE_BLOCKS} needed — the generator will refuse this snapshot and nothing will be committed.`);
  }
}

/**
 * A block degraded for three editions running is a contract that changed
 * upstream, not a source having a bad morning, and the pipeline has no other
 * way to say so: the snapshot is written, the edition is one section shorter,
 * the run is green, and that repeats until somebody happens to read a bulletin.
 * So the run fails. The snapshot is already on disk when this happens — the
 * streak keeps counting, and a `workflow_dispatch` rerun still renders the
 * edition from it once the alarm has been seen.
 *
 * The red is spent on the edition that CROSSES the threshold, and only that
 * one. This script is the first step of `generate-daily-brief.yml`, so a
 * non-zero exit code skips the generate/guard/commit/push steps that follow:
 * a streak that stayed fatal at `>= threshold` would delete the bulletin —
 * every day, not "one section shorter" — until somebody repaired the source,
 * and the same rerun that is supposed to render the edition would re-enter
 * through this same step and fail again. From the second alarming edition on,
 * the `::error::` annotation still goes out and the run stays green.
 */
export function reportDegradationAlarms(brief, { dryRun, previous = null }) {
  const alarms = degradationAlarms(brief, previous);
  if (alarms.length === 0) return;
  for (const a of alarms) {
    const line = `daily-brief: the ${a.block} block has been degraded for ${a.editions} consecutive editions — ${a.reason}`;
    // In dry mode (the on-push self-test) the alarm is real but it belongs to
    // production, not to the change being tested: reporting it as an error
    // would paint an unrelated push red.
    console.warn(dryRun ? `⚠️  ${line}` : `::error::${line}`);
  }
  if (dryRun) return;
  const crossing = alarms.filter((a) => a.crossed);
  if (crossing.length === 0) {
    console.warn(`⚠️  ${alarms.length} block(s) still degraded past ${MAX_CONSECUTIVE_DEGRADED_EDITIONS} editions — already reported on the edition that crossed the threshold. The run stays green so today's bulletin is still generated and committed.`);
    return;
  }
  console.error(`❌ ${crossing.length} block(s) degraded for ${MAX_CONSECUTIVE_DEGRADED_EDITIONS} editions in a row. That is an upstream shape/contract change, not an outage — the bulletin has been publishing without those sections and nothing was failing. Fix the source or the guard; the snapshot is written, so a rerun renders today's edition.`);
  process.exitCode = 1;
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const todayIso = process.env.TODAY_ISO || new Date().toISOString().slice(0, 10);
  // Read once and hand the same snapshot to both: it carries the streaks the
  // brief counts forward AND the streaks the alarm compares against to tell
  // the edition that crosses the threshold from the ones after it.
  const previous = readPreviousSnapshot();
  const brief = await collectDailyBrief({ todayIso, previous });
  printPlan(brief);

  if (dryRun) {
    console.log('DRY_RUN — no files written.');
    reportDegradationAlarms(brief, { dryRun, previous });
    return;
  }
  if (brief.counts.availableBlocks === 0) {
    // All four sources down: leave yesterday's snapshot in place. The article
    // generator refuses it via dateIso, the cron commits nothing, stays green.
    console.warn('⚠️  0/4 blocks available — NOT writing daily-brief.json (previous snapshot left untouched).');
    reportDegradationAlarms(brief, { dryRun, previous });
    return;
  }
  writeJsonAtomic(OUTPUT_PATH, brief);
  console.log(`✅ wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${brief.counts.availableBlocks}/4 blocks).`);
  // After the write, never before: the alarm sets a non-zero exit code, and the
  // snapshot must still land so the streak advances and the edition remains
  // renderable from it.
  reportDegradationAlarms(brief, { dryRun, previous });
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}
