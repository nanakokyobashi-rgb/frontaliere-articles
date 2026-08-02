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
 *
 * Override the source with BORDER_WAIT_AVERAGES_URL (used by the tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE =
  process.env.BORDER_WAIT_AVERAGES_URL ??
  'https://frontaliereticino.ch/data/border-wait-averages.json';

const CACHE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'border-wait-averages.json',
);

const CHECK_ONLY = process.argv.includes('--check');

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
try {
  const res = await fetch(SOURCE, { redirect: 'follow' });
  if (!res.ok) skip(`${SOURCE} → HTTP ${res.status}`);
  raw = await res.text();
} catch (err) {
  skip(`${SOURCE} unreachable: ${err.message}`);
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
