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
import { decodeFields, buildDailyBrief } from './lib/daily-brief-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const OUTPUT_PATH = path.join(REPO_ROOT, 'public', 'data', 'daily-brief.json');

const PROJECT_ID = 'frontaliere-ticino';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
export const JOBS_STATS_URL = 'https://cdn.frontaliereticino.ch/data/jobs-stats.json';
const FETCH_TIMEOUT_MS = 30_000;

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
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

/** Get a single doc, decoded. Throws on non-404 errors; 404 → null (degrade). */
async function getDoc(token, docPath) {
  const res = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${docPath} → HTTP ${res.status}`);
  const doc = await res.json();
  return decodeFields(doc.fields);
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

export async function collectDailyBrief({ todayIso, nowMs = Date.now() } = {}) {
  const creds = loadServiceAccountCreds();
  const token = await getServiceAccountAccessToken(creds, FIRESTORE_SCOPE);
  const [borderWaitDocs, fuelMetadata, exchangeDoc, jobsStats] = await Promise.all([
    tryFetch('trafficCurrent', () => listCollectionDocs(token, 'trafficCurrent')),
    tryFetch('fuelPrices/metadata', () => getDoc(token, 'fuelPrices/metadata')),
    tryFetch('exchangeHistory/chf-eur-1m', () => getDoc(token, 'exchangeHistory/chf-eur-1m')),
    tryFetch('jobs-stats', () => fetchJson(JOBS_STATS_URL)),
  ]);
  return buildDailyBrief({ todayIso, nowMs, borderWaitDocs, fuelMetadata, exchangeDoc, jobsStats });
}

function printPlan(brief) {
  const { blocks, counts } = brief;
  console.log(`📋 daily brief ${brief.dateIso} — ${counts.availableBlocks}/4 blocks available`);
  const b = blocks.borderWait;
  console.log(b.available
    ? `  🛃 borderWait: ${b.count} crossings, worst ${b.worst.name} ${b.worst.waitMinutes}min, ${b.zeroWaitCount} at zero`
    : `  🛃 borderWait: DEGRADED — ${b.reason}`);
  const f = blocks.fuel;
  console.log(f.available
    ? `  ⛽ fuel: ${f.municipalityCount} municipalities, cheapest IT ${f.cheapestItaly[0]?.municipality ?? 'n/a'} ${f.cheapestItaly[0]?.minPriceEur ?? ''}€/L, CH cheaper in ${f.cheaperSwissCount}`
    : `  ⛽ fuel: DEGRADED — ${f.reason}`);
  const e = blocks.exchange;
  console.log(e.available
    ? `  💱 exchange: 1 CHF = ${e.rate}€ (${e.lastDate}), Δ1d ${e.delta1d}, Δ7d ${e.delta7d}`
    : `  💱 exchange: DEGRADED — ${e.reason}`);
  const j = blocks.jobs;
  console.log(j.available
    ? `  💼 jobs: ${j.activeJobs} active, +${j.yesterdayAdded ?? '?'} yesterday, +${j.last7dAdded ?? '?'} in 7d`
    : `  💼 jobs: DEGRADED — ${j.reason}`);
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const todayIso = process.env.TODAY_ISO || new Date().toISOString().slice(0, 10);
  const brief = await collectDailyBrief({ todayIso });
  printPlan(brief);

  if (dryRun) {
    console.log('DRY_RUN — no files written.');
    return;
  }
  if (brief.counts.availableBlocks === 0) {
    // All four sources down: leave yesterday's snapshot in place. The article
    // generator refuses it via dateIso, the cron commits nothing, stays green.
    console.warn('⚠️  0/4 blocks available — NOT writing daily-brief.json (previous snapshot left untouched).');
    return;
  }
  writeJsonAtomic(OUTPUT_PATH, brief);
  console.log(`✅ wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${brief.counts.availableBlocks}/4 blocks).`);
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
