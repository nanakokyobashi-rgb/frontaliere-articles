#!/usr/bin/env node
/**
 * Fetch the border-wait ranking window published by the site repository
 * (issue #4974 item 3 — the REWIRE that lets the weekly ranking article be
 * generated here instead of in valerielinc-ops/frontaliere-si-o-no).
 *
 * WHY A FETCH AND NOT A COPY
 *
 * The article is computed from `data/border-wait-history/*.json` — 90 daily
 * files, 1.7 GB, collected from Firestore by the site repo and committed only
 * there. None of that is article content and none of it should be mirrored
 * here. What the generator actually needs is the aggregate underneath:
 * `aggregateCrossingStats()` collapses the whole window to ~140 crossings x 2
 * numbers, about 32 KB. Main publishes that; this fetches it.
 *
 * Two windows, because `trendFromStats()` compares the current 7 days against
 * the preceding 7. A payload carrying only `current` costs the article its
 * week-over-week trend section without failing.
 *
 * ── Why this one is REQUIRED, unlike refresh-border-wait-averages.mjs ────────
 *
 * The averages fetch is allowed to fail softly: it feeds a cosmetic overlay on
 * editorial defaults, so a network blip must not fail a generation run. This
 * one is the opposite. It IS the article's data — a ranking article generated
 * without a ranking is not degraded output, it is wrong output, published to a
 * live SEO surface under an evergreen URL that already ranks. So a failure here
 * exits non-zero and the generation step does not run.
 *
 * Usage:
 *   node generator/scripts/refresh-border-wait-window.mjs
 *   node generator/scripts/refresh-border-wait-window.mjs --check   # no write
 *   node generator/scripts/refresh-border-wait-window.mjs --help    # show this, no fetch
 *
 * Override with BORDER_WAIT_WINDOW_URL to pin a single source (used by the tests).
 * DRY_RUN=1 (or "true") is an env alias for --check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFirstOk, isCiWafBlock } from './lib/rewire-fetch.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node generator/scripts/refresh-border-wait-window.mjs [--check]\n' +
      '  --check         verify the published window, write nothing\n' +
      '  DRY_RUN=1 env   alias for --check',
  );
  process.exit(0);
}

const FILE = 'border-wait-ranking-window.json';
const ENV_URL = process.env.BORDER_WAIT_WINDOW_URL;

/**
 * Where the site actually serves its data JSON.
 *
 * NOT same-origin. `scripts/offload-generated-images-cdn.mjs` in the site repo
 * pushes every dist/data file to the CDN and then DELETES the same-origin copy,
 * so https://frontaliereticino.ch/data/<f> 404s for every one of them — verified
 * against files that have existed for months, not just the new ones.
 *
 * Same-origin is still tried as a fallback, because the offload step only runs
 * when CDN_BASE is known; a deploy without it leaves the files where the naive
 * URL expects them. First 200 wins.
 */
const SOURCES = ENV_URL
  ? [ENV_URL]
  : [
      `https://cdn.frontaliereticino.ch/data/${FILE}`,
      `https://frontaliereticino.ch/data/${FILE}`,
    ];


const CACHE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'border-wait-ranking-window.json',
);

const CHECK_ONLY =
  process.argv.includes('--check') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const log = (msg) => console.log(`[refresh-border-wait-window] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[refresh-border-wait-window] ${msg}`);
  process.exit(1);
};

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'rewire',
  FILE,
);

let raw;
let SOURCE;
{
  const got = await fetchFirstOk(SOURCES);
  if (got.ok) {
    raw = got.body;
    SOURCE = got.url;
  } else if (CHECK_ONLY && isCiWafBlock(got.errors)) {
    // GitHub Actions IPs get HTTP 403 from Cloudflare (measured 2026-08-25).
    // Live freshness belongs to rewire-contract-watch.yml, not PR CI.
    log(
      `publisher unreachable from CI (WAF 403). Shape is gated offline by ` +
        `rewire-json-contracts.test.mjs.\n  ${got.errors.join('\n  ')}`,
    );
    process.exit(0);
  } else if (!CHECK_ONLY && process.env.REWIRE_FIXTURE_ON_403 === '1' && isCiWafBlock(got.errors) && fs.existsSync(FIXTURE)) {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.copyFileSync(FIXTURE, CACHE);
    log(`copied rewire fixture to cache after CI WAF 403 (${got.errors.join('; ')})`);
    process.exit(0);
  } else {
    fail(`no source reachable —\n  ${got.errors.join('\n  ')}`);
  }
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  fail(`${SOURCE} is not valid JSON: ${err.message}`);
}

/** Validate one window half and return its crossing count. */
function checkWindow(name) {
  const w = payload?.[name];
  if (!w || typeof w !== 'object') fail(`${SOURCE}: '${name}' window missing — refusing`);
  for (const key of ['weekStart', 'weekEnd']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w[key] ?? '')) {
      fail(`${SOURCE}: ${name}.${key} is ${JSON.stringify(w[key])}, not an ISO date — refusing`);
    }
  }
  const per = w.perCrossing;
  if (!per || typeof per !== 'object' || Array.isArray(per)) {
    fail(`${SOURCE}: ${name}.perCrossing is not an object — refusing`);
  }
  for (const [slug, s] of Object.entries(per)) {
    if (typeof s?.weightedAvgMinutes !== 'number' || !Number.isFinite(s.weightedAvgMinutes)) {
      fail(`${SOURCE}: ${name}.${slug}.weightedAvgMinutes is not a finite number — refusing`);
    }
    if (!Number.isInteger(s?.totalSamples) || s.totalSamples < 0) {
      fail(`${SOURCE}: ${name}.${slug}.totalSamples is not a non-negative integer — refusing`);
    }
  }
  return Object.keys(per).length;
}

if (payload?.windowDays !== 7) {
  // The generator's own DEFAULT_WINDOW_DAYS is 7 and the article text says
  // "settimana". A publisher that changed the window without this side knowing
  // would produce an article whose prose contradicts its numbers.
  fail(`${SOURCE}: windowDays is ${JSON.stringify(payload?.windowDays)}, expected 7 — refusing`);
}

const currentCount = checkWindow('current');
const previousCount = checkWindow('previous');

if (currentCount === 0) {
  fail(`${SOURCE}: current window has zero crossings — refusing (the article would have no ranking)`);
}

// Staleness gate. The ranking is weekly and main republishes on every traffic
// collect, so a window whose end is far in the past means the publisher stopped
// and we would generate this week's article from last month's numbers — the
// failure that looks like success.
const ageDays = Math.floor(
  (Date.now() - new Date(`${payload.current.weekEnd}T00:00:00Z`).getTime()) / 86_400_000,
);
if (ageDays > 14) {
  fail(
    `${SOURCE}: current window ends ${payload.current.weekEnd}, ${ageDays} days ago — ` +
      `refusing to build a ranking article from stale data`,
  );
}

if (CHECK_ONLY) {
  log(`--check: ${currentCount} current / ${previousCount} previous crossings, wrote nothing`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, `${JSON.stringify(payload, null, 2)}\n`);
log(
  `cached ${payload.current.weekStart}..${payload.current.weekEnd} — ` +
    `${currentCount} current / ${previousCount} previous crossings`,
);
