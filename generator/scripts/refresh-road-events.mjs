#!/usr/bin/env node
/**
 * Refresh the per-canton road events dataset (chiusure, cantieri, traffico,
 * trasporto pubblico) from the site's CDN — plan P9c, consumer half.
 *
 * The site collects it (`scripts/collect-road-events.mjs` there: ASTRA DATEX II
 * traffic situations + cantonal mobility/police feeds) and publishes
 * `road-events.json` next to the other data artefacts. This repo reads it over
 * HTTP, never by import: the contract is `road-events` in
 * generator/tests/lib/rewire-contracts.mjs, pinned by
 * generator/tests/rewire-json-contracts.test.mjs.
 *
 * Failure mode: SOFT on reachability, HARD on shape. No generator reads the
 * cache yet (the per-canton mobility hubs come with P11), so an unreachable
 * CDN keeps the existing cache and exits 0. A document that arrives and is
 * not the dataset — wrong schema, a BFS half-canton code instead of the URL
 * group, a type outside the four, a stale snapshot — exits 1 and is never
 * cached: caching garbage is the failure that would be hard to see later.
 *
 * Usage:
 *   node generator/scripts/refresh-road-events.mjs
 *   node generator/scripts/refresh-road-events.mjs --check   # verify, write nothing
 *   node generator/scripts/refresh-road-events.mjs --help
 *
 * ROAD_EVENTS_URL pins a single source (used by the tests). DRY_RUN=1 is an
 * env alias for --check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFirstOk } from './lib/rewire-fetch.mjs';
// The 24 canton URL groups are the one source of truth for `canton`: a code
// outside them (CH, DE, a typo) would reach no hub. Imported, not copied, so
// the set cannot drift; the contract test copies relative imports with the script.
import cantonUrlSlugs from '../data/canton-url-slugs.json' with { type: 'json' };

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node generator/scripts/refresh-road-events.mjs [--check]\n' +
      '  --check         verify the published dataset, write nothing\n' +
      '  DRY_RUN=1 env   alias for --check',
  );
  process.exit(0);
}

const FILE = 'road-events.json';
const ENV_URL = process.env.ROAD_EVENTS_URL;
// CDN first, same-origin fallback: same reasoning as refresh-border-wait-window.mjs.
const SOURCES = ENV_URL
  ? [ENV_URL]
  : [`https://cdn.frontaliereticino.ch/data/${FILE}`, `https://frontaliereticino.ch/data/${FILE}`];

const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', FILE);
const CHECK_ONLY =
  process.argv.includes('--check') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

/** The site republishes every 3 hours; two days without a new snapshot means it stopped. */
const MAX_AGE_HOURS = 48;
/** Clock skew tolerated on generatedAt; beyond it a future date would pass the age gate forever. */
const MAX_FUTURE_SKEW_HOURS = 1;
const TYPES = new Set(['chiusura', 'cantiere', 'traffico', 'tp']);
const CANTON_GROUPS = new Set(Object.keys(cantonUrlSlugs.cantons ?? {}));
const HALF_CANTONS = new Set(Object.values(cantonUrlSlugs.cantonGroups ?? {}).flatMap((g) => g.members ?? []));

const log = (msg) => console.log(`[refresh-road-events] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[refresh-road-events] ${msg}`);
  process.exit(1);
};

const isIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

const got = await fetchFirstOk(SOURCES);
if (!got.ok) {
  log(`no source reachable — keeping the existing cache\n  ${got.errors.join('\n  ')}`);
  process.exit(0);
}
const SOURCE = got.url;

let payload;
try {
  payload = JSON.parse(got.body);
} catch (err) {
  fail(`${SOURCE} is not valid JSON: ${err.message}`);
}

if (payload?.schemaVersion !== 1) {
  fail(`${SOURCE}: schemaVersion is ${JSON.stringify(payload?.schemaVersion)}, expected 1 — refusing`);
}
if (!isIso(payload.generatedAt)) fail(`${SOURCE}: generatedAt is not an ISO date — refusing`);
if (!Array.isArray(payload.events)) fail(`${SOURCE}: has no events[] array — refusing`);
if (payload.events.length === 0) fail(`${SOURCE}: carries zero events — refusing`);

const ageHours = (Date.now() - Date.parse(payload.generatedAt)) / 3_600_000;
if (ageHours < -MAX_FUTURE_SKEW_HOURS) {
  fail(`${SOURCE}: generatedAt ${payload.generatedAt} is in the future — refusing (a stuck clock would pass the age gate forever)`);
}
if (ageHours > MAX_AGE_HOURS) {
  fail(`${SOURCE}: generatedAt ${payload.generatedAt} is ${Math.round(ageHours)}h old — refusing stale road events`);
}

const seenIds = new Set();
payload.events.forEach((e, i) => {
  const at = `events[${i}]`;
  if (typeof e?.id !== 'string' || !e.id) fail(`${SOURCE}: ${at}.id missing — refusing`);
  if (seenIds.has(e.id)) fail(`${SOURCE}: ${at}.id ${JSON.stringify(e.id)} is duplicated — refusing`);
  seenIds.add(e.id);
  if (HALF_CANTONS.has(e.canton)) {
    fail(`${SOURCE}: ${at}.canton is the half-canton ${e.canton}, not its URL group — refusing`);
  }
  if (!CANTON_GROUPS.has(e.canton)) {
    fail(`${SOURCE}: ${at}.canton ${JSON.stringify(e.canton)} is not one of the 24 canton URL groups — refusing`);
  }
  if (!TYPES.has(e.type)) fail(`${SOURCE}: ${at}.type ${JSON.stringify(e.type)} is not one of ${[...TYPES].join('|')} — refusing`);
  if (typeof e.title !== 'string' || !e.title.trim()) fail(`${SOURCE}: ${at}.title is empty — refusing`);
  if (e.url !== null && !/^https:\/\//.test(String(e.url))) fail(`${SOURCE}: ${at}.url is not https or null — refusing`);
  for (const k of ['validFrom', 'validTo']) {
    if (e[k] !== null && !isIso(e[k])) fail(`${SOURCE}: ${at}.${k} is not an ISO date or null — refusing`);
  }
  if (e.validFrom && e.validTo && Date.parse(e.validFrom) > Date.parse(e.validTo)) {
    fail(`${SOURCE}: ${at}.validFrom is after validTo — refusing`);
  }
  if (typeof e.source !== 'string' || !e.source) fail(`${SOURCE}: ${at}.source missing — refusing`);
  if (!isIso(e.observedAt)) fail(`${SOURCE}: ${at}.observedAt is not an ISO date — refusing`);
});

const cantons = new Set(payload.events.map((e) => e.canton));
if (CHECK_ONLY) {
  log(`--check: ${payload.events.length} events in ${cantons.size} cantons, wrote nothing`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(CACHE), { recursive: true });
// temp + rename: a kill mid-write must not leave a truncated cache behind.
const tmp = `${CACHE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
fs.renameSync(tmp, CACHE);
log(`cached ${payload.events.length} events in ${cantons.size} cantons (generated ${payload.generatedAt})`);
