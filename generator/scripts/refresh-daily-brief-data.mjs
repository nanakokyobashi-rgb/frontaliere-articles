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
 * stale snapshot on its own dateIso check). The degradation streaks are kept
 * OUT of that skipped write, in `data/daily-brief-degradation.json`, so a total
 * blackout still counts its days (#885).
 *
 * Usage:
 *   npx -y tsx@4 generator/scripts/refresh-daily-brief-data.mjs
 *   DRY_RUN=1 …    # fetch + print the plan, write nothing
 *   TODAY_ISO=2026-08-08 …   # pin "today" (tests/CI)
 */
import path from 'node:path';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getServiceAccountAccessToken } from './lib/google-service-account-token.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { decodeFields, buildDailyBrief, degradationAlarms, degradationState, MAX_CONSECUTIVE_DEGRADED_EDITIONS } from './lib/daily-brief-data.mjs';
import { MIN_AVAILABLE_BLOCKS } from './lib/daily-brief-content.mjs';
import { isRetryableRcFetchStatus, rcFetchBackoffMs, RC_FETCH_ATTEMPTS, extractGoogleErrorReason } from './load-rc-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const OUTPUT_PATH = path.join(REPO_ROOT, 'public', 'data', 'daily-brief.json');
/**
 * The durable per-block degradation streaks. A sidecar and not the snapshot
 * because the snapshot is NOT written on the 0/4-blocks branch — see
 * `degradationState` in lib/daily-brief-data.mjs for the whole reasoning. It
 * lives under `data/` (producer bookkeeping), never under `public/data/`:
 * nothing in the published surface should have to know it exists.
 */
export const DEGRADATION_STATE_PATH = path.join(REPO_ROOT, 'data', 'daily-brief-degradation.json');

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
 * Yesterday's snapshot, or `null` when there is none to read. It carries a copy
 * of the per-block degradation streaks, and is the fallback source for them
 * when the sidecar (`DEGRADATION_STATE_PATH`) is not there yet. Unreadable is
 * the same as absent — a snapshot that cannot be parsed must not stop today's
 * refresh, it just restarts the count.
 */
export function readPreviousSnapshot(snapshotPath = OUTPUT_PATH) {
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * The streaks the last edition recorded, from the sidecar — falling back to the
 * previous snapshot when there is no sidecar yet (the first run after #885
 * landed, or one that lost the file), so the counts carry over instead of
 * restarting. Unreadable is the same as absent on both, for the same reason as
 * above: a bookkeeping file must never stop a refresh.
 *
 * The returned value is a snapshot-shaped carrier — `dateIso` plus
 * `blocks.<name>.degradedEditions` — which is all `buildDailyBrief` and
 * `degradationAlarms` ever read from `previous`.
 */
export function readDegradationState(statePath = DEGRADATION_STATE_PATH, snapshotPath = OUTPUT_PATH) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (state && typeof state === 'object') return state;
  } catch { /* absent or corrupt — fall through to the snapshot */ }
  return readPreviousSnapshot(snapshotPath);
}

/** Persist today's streaks. Written on EVERY non-dry run, 0/4 blocks included. */
export function writeDegradationState(brief, statePath = DEGRADATION_STATE_PATH) {
  writeJsonAtomic(statePath, degradationState(brief));
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
 * So the crossing is announced — loudly, on the run and in its summary — and
 * the count that produced it is committed with the snapshot.
 *
 * NOT with the exit code, and the reason is structural. This script is the
 * FIRST step of `generate-daily-brief.yml`, and generation, guard, RC and
 * `Commit and push` all sit behind its implicit `if: success()`. A non-zero
 * exit here does not merely skip today's edition: it skips the COMMIT, so the
 * snapshot `writeJsonAtomic` just wrote never leaves the runner. Tomorrow's
 * checkout restores the D-1 snapshot, the streak recomputes to the same value,
 * the crossing reads as new again, and the red repeats every morning forever —
 * exactly the permanent outage the crossing logic was added to avoid, with the
 * bulletin gone as well. A `workflow_dispatch` cannot break the loop either: it
 * checks out the COMMITTED file, not the one the failed run left behind.
 *
 * So the alarm's job is to be impossible to miss, not to be fatal HERE: an
 * `::error::` annotation on the run plus a block in `$GITHUB_STEP_SUMMARY`,
 * while the streak keeps advancing inside a snapshot that actually gets
 * committed. The red itself is spent by a verdict step placed AFTER
 * `Commit and push` in `generate-daily-brief.yml`, which reads the crossing off
 * `DEGRADATION_CROSSED_OUTPUT`: today's edition is pushed first, the streak
 * reaches `main`, tomorrow reads `previous >= threshold` and is green again —
 * the red is spent once, on the crossing edition, without costing a bulletin.
 *
 * A crossing this run will NOT record (`persisted: false` — the dry self-test,
 * which writes nothing at all) is announced and never turned into a verdict:
 * nothing would remember it, so it would fail again tomorrow for the same
 * crossing, forever. The 0/4-blocks branch used to be in that list and is not
 * any more (#885): it skips the SNAPSHOT, but it still writes the streaks to
 * `DEGRADATION_STATE_PATH`, which the commit step carries to `main`.
 */

/**
 * The step-output keys the workflow reads. One source: the gate step in
 * `generate-daily-brief.yml` names them, and the binding between the two ends —
 * which nothing can import across — is pinned by
 * `daily-brief-degradation-alarm.test.mjs`.
 */
export const DEGRADATION_CROSSED_OUTPUT = 'degradation_crossed';
export const DEGRADATION_BLOCKS_OUTPUT = 'degradation_blocks';

/** Append `key=value` to `$GITHUB_OUTPUT`; a no-op outside Actions. */
function publishStepOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  try {
    appendFileSync(file, `${key}=${value}\n`);
  } catch (err) {
    // The crossing is already an ::error:: annotation and a summary block:
    // losing the channel to the gate step must not also lose today's edition.
    console.warn(`⚠️  could not write ${key} to GITHUB_OUTPUT: ${err.message}`);
  }
}

function appendStepSummary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `${text}\n`);
  } catch (err) {
    // A summary that cannot be written must not take the refresh down with it.
    console.warn(`⚠️  could not write the step summary: ${err.message}`);
  }
}

/** Announce every block whose degradation has outlived the threshold. */
export function reportDegradationAlarms(brief, { dryRun, previous = null, persisted = !dryRun }) {
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
  const crossed = alarms.filter((a) => a.crossed);
  const headline = crossed.length > 0
    ? `${crossed.map((a) => a.block).join(', ')} just reached ${MAX_CONSECUTIVE_DEGRADED_EDITIONS} degraded editions in a row`
    : `${alarms.map((a) => a.block).join(', ')} still degraded past ${MAX_CONSECUTIVE_DEGRADED_EDITIONS} editions`;
  console.error(`❌ ${headline}. That is an upstream shape/contract change, not an outage — the bulletin has been publishing without those sections and nothing was failing.`);
  appendStepSummary([
    `### ⚠️ Bollettino: degradazione persistente — ${headline}`,
    '',
    ...alarms.map((a) => `- \`${a.block}\`: ${a.editions} edizioni consecutive — ${a.reason}`),
    '',
    "Non e' un'interruzione della fonte: a questo punto e' un contratto cambiato a monte. Il contatore vive in `data/daily-brief-degradation.json` (`blocks.<nome>.degradedEditions`, ricopiato in `public/data/daily-brief.json` nei giorni con edizione) e continua a salire finche' qualcuno non ripara la fonte o il guard.",
  ].join('\n'));
  if (crossed.length === 0) return;
  if (!persisted) {
    console.warn(`⚠️  this run writes no snapshot, so the crossing is not recorded — announced only, never a verdict: it would repeat identically tomorrow.`);
    return;
  }
  publishStepOutput(DEGRADATION_CROSSED_OUTPUT, 'true');
  publishStepOutput(DEGRADATION_BLOCKS_OUTPUT, crossed.map((a) => a.block).join(', '));
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const todayIso = process.env.TODAY_ISO || new Date().toISOString().slice(0, 10);
  // Read once and hand the same snapshot to both: it carries the streaks the
  // brief counts forward AND the streaks the alarm compares against to tell
  // the edition that crosses the threshold from the ones after it.
  const previous = readDegradationState();
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
    // The STREAKS are written anyway (#885): they are the only reason this
    // branch had a memory hole, and they do not belong to yesterday's payload.
    // Without this, a blackout re-read the same `previous` every morning and
    // the count stuck at 1 forever, so the threshold was never reached.
    writeDegradationState(brief);
    console.warn('⚠️  0/4 blocks available — NOT writing daily-brief.json (previous snapshot left untouched); degradation streaks persisted separately.');
    reportDegradationAlarms(brief, { dryRun, previous });
    return;
  }
  writeJsonAtomic(OUTPUT_PATH, brief);
  writeDegradationState(brief);
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
