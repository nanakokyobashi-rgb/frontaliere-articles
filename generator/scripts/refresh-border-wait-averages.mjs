#!/usr/bin/env node
/**
 * Refresh the border-wait averages overlay from the live site (issue #4974
 * item 3, REWIRE set — §5.3 of frontaliere-si-o-no's
 * docs/articles-generator-migration.md).
 *
 * WHY THIS EXISTS
 *
 * `generator/data/borderCrossings.ts` used to statically import
 * `data/border-wait-averages.json`, a file main regenerates daily from a
 * 30-day border-wait history that lives only in main. That import is the last
 * thing in the generator's path that wanted a main-owned repo file. Vendoring
 * a copy would have gone stale immediately; reading it out of main's git tree
 * would have made this repo depend on main's checkout, inverting the one-way
 * architecture the whole migration exists to establish. Fetching it over HTTP
 * from the published site keeps the dependency one-way and read-only: nanako
 * pulls a public artifact, exactly as main pulls nanako's published JSON.
 *
 * WHAT IT IS NOT
 *
 * Not a hard dependency. The averages are a cosmetic overlay on the editorial
 * wait-time defaults already hard-coded in `borderCrossings.ts`, and that file
 * treats a missing cache as "use the defaults". So this script exits 0 and
 * writes nothing when the site is unreachable — a network blip must not fail an
 * article-generation run over a wait-time string. It exits non-zero only when
 * it fetched something and that something was not a usable averages document,
 * because silently caching garbage is the failure that would be hard to see.
 *
 * Usage:
 *   node generator/scripts/refresh-border-wait-averages.mjs
 *   node generator/scripts/refresh-border-wait-averages.mjs --check   # no write
 *   node generator/scripts/refresh-border-wait-averages.mjs --help    # show this, no fetch
 *
 * Override with BORDER_WAIT_AVERAGES_URL to pin a single source (used by the tests).
 * DRY_RUN=1 (or "true") is an env alias for --check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node generator/scripts/refresh-border-wait-averages.mjs [--check]\n' +
      '  --check         verify the published averages, write nothing\n' +
      '  DRY_RUN=1 env   alias for --check',
  );
  process.exit(0);
}

const FILE = 'border-wait-averages.json';
const ENV_URL = process.env.BORDER_WAIT_AVERAGES_URL;

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
  'border-wait-averages.json',
);

const CHECK_ONLY =
  process.argv.includes('--check') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const log = (msg) => console.log(`[refresh-border-wait-averages] ${msg}`);

/** Soft failure: the overlay is optional, so an unreachable site is not an error. */
function skip(msg) {
  log(`${msg} — keeping the existing cache (editorial defaults apply if absent)`);
  process.exit(0);
}

/** Hard failure: we got a document and it was not the one we asked for. */
function fail(msg) {
  console.error(`::error::[refresh-border-wait-averages] ${msg}`);
  process.exit(1);
}

let raw;
let SOURCE;
{
  const errors = [];
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      raw = await res.text();
      SOURCE = url;
      break;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  // Soft: the overlay is cosmetic and borderCrossings.ts falls back to the
  // editorial defaults, so an unreachable publisher must not fail generation.
  if (raw === undefined) skip(`no source reachable —\n  ${errors.join('\n  ')}`);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  fail(`${SOURCE} is not valid JSON: ${err.message}`);
}

// Shape gate. The published file is a flat map of crossing-slug → {morning?,
// evening?} range strings. An HTML error page that came back with a 200 parses
// as neither, and an array or a scalar means the publisher changed shape.
if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
  fail(`${SOURCE} is not a crossing-slug map — refusing to cache it`);
}

const slugs = Object.keys(payload);
if (slugs.length === 0) fail(`${SOURCE} carries zero crossings — refusing`);

for (const slug of slugs) {
  const entry = payload[slug];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`${SOURCE}: '${slug}' is not an object — refusing`);
  }
  for (const window of ['morning', 'evening']) {
    const value = entry[window];
    if (value === undefined) continue;
    // "2-13 min", or "2 min" when p25 == p75 — `formatRange()` in main's
    // compute-border-wait-averages.mjs collapses a degenerate range to the
    // single value rather than printing "2-2 min". Format-checking rather than
    // trusting it keeps a raw number or a localised string from reaching an
    // article body verbatim.
    if (typeof value !== 'string' || !/^\d+(-\d+)? min$/.test(value)) {
      fail(
        `${SOURCE}: '${slug}'.${window} is ${JSON.stringify(value)}, ` +
          `not a "N min" or "N-M min" range`,
      );
    }
  }
}

// Shrink guard, same spirit as main's pull script: the crossing set is stable
// (it tracks physical border posts), so a sharp drop means a truncated publish
// rather than closed borders.
if (fs.existsSync(CACHE)) {
  try {
    const current = JSON.parse(fs.readFileSync(CACHE, 'utf-8'));
    const before = Object.keys(current).length;
    if (slugs.length < before / 2) {
      fail(`would shrink from ${before} to ${slugs.length} crossings — refusing`);
    }
  } catch {
    // An unreadable cache is exactly what we are here to replace.
  }
}

if (CHECK_ONLY) {
  log(`--check: ${slugs.length} crossings validated, wrote nothing`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, `${JSON.stringify(payload, null, 2)}\n`);
log(`cached ${slugs.length} crossings from ${SOURCE}`);
