#!/usr/bin/env node
/**
 * Refresh the events dataset from the live site (issue #4974 item 3, REWIRE set).
 *
 * WHY THIS EXISTS
 *
 * `generate-events-digest-article.mjs` reads `data/events.json` — 1300+ upcoming
 * Ticino/frontier events, assembled in the SITE repo by a pipeline that crawls
 * tio.ch, guidle, myswitzerland and geneve.ch. That crawling does not move here:
 * it is a site data pipeline with no corpus involvement (§0.2 of the site repo's
 * docs/articles-generator-migration.md), and only the one digest step moves.
 *
 * Which leaves the digest needing a file this repo does not and should not own.
 * Vendoring a copy would be stale within a day — the dataset changes on every
 * crawl. Reading the site's checkout would invert the one-way architecture the
 * whole migration exists to establish. So the site publishes the dataset it
 * already assembles (assemble-events-dataset.mjs writes public/data/events.json
 * in the same call that writes data/events.json) and this repo fetches it. Same
 * shape as the border-wait REWIRE, same direction: nanako pulls a public
 * artifact, exactly as the site pulls nanako's published JSON.
 *
 * WHY THIS ONE IS A HARD GATE
 *
 * refresh-border-wait-averages.mjs soft-fails, because the averages are a
 * cosmetic overlay with editorial defaults behind them. This is the opposite:
 * the dataset IS the digest's content. `loadEventsDataset()` treats a missing
 * file as zero events, and the digest happily renders "no events this weekend"
 * from that — which would OVERWRITE a correct digest with an empty one on the
 * evergreen URL. An unreachable publisher must stop the run, not quietly produce
 * a worse article. Same reasoning as refresh-border-wait-window.mjs.
 *
 * Usage:
 *   node generator/scripts/refresh-events-dataset.mjs           # fetch + write
 *   node generator/scripts/refresh-events-dataset.mjs --check   # verify, no write
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = 'events.json';
const ENV_URL = process.env.EVENTS_DATASET_URL;

/**
 * NOT same-origin. The site's offload step pushes every dist/data file to the CDN
 * and deletes the same-origin copy, so /data/<f> 404s. Same-origin is still tried
 * as a fallback for a deploy that ran without CDN_BASE. First 200 wins.
 */
const SOURCES = ENV_URL
  ? [ENV_URL]
  : [
      `https://cdn.frontaliereticino.ch/data/${FILE}`,
      `https://frontaliereticino.ch/data/${FILE}`,
    ];

// Written where events-utils.mjs's EVENTS_DATASET_PATH expects it: the repo
// root's data/, not generator/data/. Gitignored — this is a fetched cache, and
// committing 1.9 MB of other-repo data on every run would be noise in the corpus.
const CACHE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  FILE,
);

const CHECK_ONLY = process.argv.includes('--check');

const log = (msg) => console.log(`[refresh-events-dataset] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[refresh-events-dataset] ${msg}`);
  process.exit(1);
};

/** Retries only the transient classes; a 404 is a real absence and fails now. */
async function get(url) {
  let lastErr;
  for (let i = 1; i <= 4; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) {
        const body = await res.text();
        if (body.length > 0) return body;
        lastErr = new Error('empty body');
      } else {
        const err = new Error(`HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429) throw err;
        lastErr = err;
      }
    } catch (err) {
      if (/HTTP 4\d\d/.test(err.message)) throw err;
      lastErr = err;
    }
    if (i < 4) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
  }
  throw lastErr;
}

let raw;
let SOURCE;
{
  const errors = [];
  for (const url of SOURCES) {
    try {
      raw = await get(url);
      SOURCE = url;
      break;
    } catch (err) {
      errors.push(`  ${url}: ${err.message}`);
    }
  }
  if (raw === undefined) {
    fail(`no source reachable —\n${errors.join('\n')}`);
  }
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  fail(`${SOURCE} did not return JSON: ${err.message}`);
}

// Shape gate. A 200 carrying an HTML error page, or a truncated write caught
// mid-deploy, must not be cached over a good copy — the digest cannot tell the
// difference and would render an empty weekend from it.
const events = Array.isArray(payload?.events) ? payload.events : null;
if (!events) fail(`${SOURCE} has no events[] array — refusing`);
if (events.length === 0) fail(`${SOURCE} carries zero events — refusing to cache an empty dataset`);
if (typeof payload.schemaVersion !== 'number') {
  fail(`${SOURCE} has no numeric schemaVersion — refusing an unrecognised shape`);
}

const dated = events.filter((e) => e && typeof e.startDate === 'string' && e.startDate).length;
if (dated === 0) fail(`${SOURCE}: not one event carries a startDate — refusing`);

if (CHECK_ONLY) {
  log(`--check: ${events.length} events (${dated} dated) from ${SOURCE}, wrote nothing`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, raw, 'utf-8');
log(`${events.length} events (${dated} dated) from ${SOURCE} → ${path.relative(process.cwd(), CACHE)}`);
