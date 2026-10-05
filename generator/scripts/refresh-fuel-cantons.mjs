#!/usr/bin/env node
/**
 * Refresh the per-canton fuel price dataset from the live site (P9b of the
 * canton-sections programme, decision D11: category data is produced by the
 * category's own pipeline on the site and READ here, never re-crawled).
 *
 * WHAT IT FETCHES
 *
 * `fuel-prices-cantons.json`, written by the site's
 * `scripts/build-fuel-cantons-dataset.mjs` in the daily run of
 * `update-fuel-prices.yml`: one flat record per (canton URL group, side,
 * fuel) — `canton`, `side` (CH|FR|AT|IT|DE), `fuel` (sp95|diesel),
 * `currency`, `avg`, `min`, `stations`, `observedAt`, `source`. The canton
 * hubs (P10) will read the cache this writes; nothing in the generator reads
 * it yet.
 *
 * WHY SOFT
 *
 * Same reasoning as refresh-border-wait-averages.mjs: the figures will be an
 * optional data block in a hub, with editorial copy behind them. An
 * unreachable publisher (including the 404 before the site's first daily
 * build) keeps the existing cache and exits 0. It exits non-zero only when it
 * fetched something and that something was not a usable dataset — caching
 * garbage is the failure that would be hard to see. A dataset whose
 * `generatedAt` is older than MAX_AGE_DAYS is refused too: the site writes it
 * daily, so a stale one means the publisher stopped.
 *
 * Usage:
 *   node generator/scripts/refresh-fuel-cantons.mjs           # fetch + write
 *   node generator/scripts/refresh-fuel-cantons.mjs --check   # verify, no write
 *   node generator/scripts/refresh-fuel-cantons.mjs --help    # show this, no fetch
 *
 * FUEL_CANTONS_URL pins a single source (used by the tests).
 * DRY_RUN=1 (or "true") is an env alias for --check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFirstOk } from './lib/rewire-fetch.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node generator/scripts/refresh-fuel-cantons.mjs [--check]\n' +
      '  --check         verify the published dataset, write nothing\n' +
      '  DRY_RUN=1 env   alias for --check',
  );
  process.exit(0);
}

const FILE = 'fuel-prices-cantons.json';
const ENV_URL = process.env.FUEL_CANTONS_URL;

/**
 * NOT same-origin first: the site's offload step moves every dist/data file to
 * the CDN and deletes the same-origin copy. Same-origin stays as a fallback
 * for a deploy that ran without CDN_BASE. First 200 wins.
 */
const SOURCES = ENV_URL
  ? [ENV_URL]
  : [
      `https://cdn.frontaliereticino.ch/data/${FILE}`,
      `https://frontaliereticino.ch/data/${FILE}`,
    ];

// Gitignored fetched cache, next to the other REWIRE caches.
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', FILE);

const SUPPORTED_SCHEMA = 1;
const SIDES = new Set(['CH', 'FR', 'AT', 'IT', 'DE']);
const FUELS = new Set(['sp95', 'diesel']);
const CURRENCIES = new Set(['CHF', 'EUR']);
// Per-litre plausibility: outside this a unit changed (cents, thousandths).
const PRICE_MIN = 0.5;
const PRICE_MAX = 5;
const MAX_AGE_DAYS = 7;

const CHECK_ONLY =
  process.argv.includes('--check') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const log = (msg) => console.log(`[refresh-fuel-cantons] ${msg}`);

/** Soft failure: nothing reachable, keep what we have. */
function skip(msg) {
  log(`${msg} — keeping the existing cache`);
  process.exit(0);
}

/** Hard failure: we got a document and it was not the one we asked for. */
function fail(msg) {
  console.error(`::error::[refresh-fuel-cantons] ${msg}`);
  process.exit(1);
}

let raw;
let SOURCE;
{
  const got = await fetchFirstOk(SOURCES);
  if (!got.ok) skip(`no source reachable —\n  ${got.errors.join('\n  ')}`);
  raw = got.body;
  SOURCE = got.url;
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  fail(`${SOURCE} is not valid JSON: ${err.message}`);
}

if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
  fail(`${SOURCE} is not a dataset object — refusing`);
}
if (payload.schemaVersion !== SUPPORTED_SCHEMA) {
  fail(`${SOURCE} has schemaVersion ${JSON.stringify(payload.schemaVersion)}, expected ${SUPPORTED_SCHEMA} — refusing an unrecognised shape`);
}

const generatedMs = Date.parse(payload.generatedAt);
if (!Number.isFinite(generatedMs)) fail(`${SOURCE}: generatedAt ${JSON.stringify(payload.generatedAt)} is not a date`);
const ageDays = (Date.now() - generatedMs) / 86_400_000;
if (ageDays > MAX_AGE_DAYS) {
  fail(`${SOURCE}: generatedAt is ${Math.floor(ageDays)} days ago — refusing stale data (publisher stopped?)`);
}

const cantons = Array.isArray(payload.cantons) ? payload.cantons : null;
if (!cantons || cantons.length !== 24 || !cantons.every((c) => typeof c === 'string' && c)) {
  fail(`${SOURCE}: cantons is not the list of the 24 canton URL groups — refusing`);
}
const knownCantons = new Set(cantons);

const records = Array.isArray(payload.records) ? payload.records : null;
if (!records) fail(`${SOURCE} has no records[] array — refusing`);
if (records.length === 0) fail(`${SOURCE} carries zero records — refusing to cache an empty dataset`);

const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v >= PRICE_MIN && v <= PRICE_MAX;
for (const [i, r] of records.entries()) {
  const at = `${SOURCE}: records[${i}]`;
  if (!r || typeof r !== 'object') fail(`${at} is not an object`);
  if (!knownCantons.has(r.canton)) fail(`${at}.canton ${JSON.stringify(r.canton)} is not one of the 24 groups`);
  if (!SIDES.has(r.side)) fail(`${at}.side ${JSON.stringify(r.side)} is not CH|FR|AT|IT|DE`);
  if (!FUELS.has(r.fuel)) fail(`${at}.fuel ${JSON.stringify(r.fuel)} is not sp95|diesel`);
  if (!CURRENCIES.has(r.currency)) fail(`${at}.currency ${JSON.stringify(r.currency)} is not CHF|EUR`);
  if ((r.side === 'CH') !== (r.currency === 'CHF')) fail(`${at}: side ${r.side} priced in ${r.currency}`);
  if (!isPrice(r.avg)) fail(`${at}.avg ${JSON.stringify(r.avg)} is not a per-litre price`);
  if (!isPrice(r.min)) fail(`${at}.min ${JSON.stringify(r.min)} is not a per-litre price`);
  if (r.min > r.avg) fail(`${at}: min ${r.min} is above avg ${r.avg}`);
  if (!Number.isInteger(r.stations) || r.stations < 1) fail(`${at}.stations ${JSON.stringify(r.stations)} is not a positive integer`);
  if (!Number.isFinite(Date.parse(r.observedAt))) fail(`${at}.observedAt ${JSON.stringify(r.observedAt)} is not a date`);
  if (typeof r.source !== 'string' || !r.source.trim()) fail(`${at}.source is empty`);
}

const withData = new Set(records.map((r) => r.canton)).size;

if (CHECK_ONLY) {
  log(`--check: ${records.length} records over ${withData} cantons from ${SOURCE}, wrote nothing`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, raw, 'utf-8');
log(`${records.length} records over ${withData} cantons from ${SOURCE} → ${path.relative(process.cwd(), CACHE)}`);
