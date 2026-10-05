#!/usr/bin/env node
/**
 * Vista «servizi» per cantone (P9f, D11): aggregatore dei dataset di servizi
 * che il sito pubblica gia' su cdn.frontaliereticino.ch/data/.
 *
 *   health-premiums.json        premi cassa malati per cantone e regione (UFSP/BAG)
 *   plate-auctions.json         aste delle targhe per cantone (uffici cantonali)
 *   pharmacy-duty-cantons.json  turni farmacia dove esiste una fonte ufficiale leggibile
 *   weather-snapshot.json       meteo delle citta' dello snapshot del sito
 *
 * → `generator/data/canton-services.json` (cache gitignored): per ognuno dei
 *   24 gruppi cantonali un blocco per fonte con `available` e, se manca,
 *   `reason`. Lo leggeranno gli hub `servizi` (P10). Le regole di forma e di
 *   degrado stanno in `lib/canton-services-data.mjs` (modello
 *   `lib/daily-brief-data.mjs`).
 *
 * Morbido sull'irraggiungibile (il blocco degrada), duro su cio' che scarica:
 * un 200 che non e' JSON o un documento con un'altra forma fa uscire 1 senza
 * scrivere — come refresh-border-wait-averages.mjs. Sotto le soglie
 * (`MIN_SOURCES_OK`, `MIN_CANTONS_WITH_BLOCK`) la vista non si scrive e resta
 * la copia precedente.
 *
 * Uso:
 *   node generator/scripts/refresh-canton-services-data.mjs           # fetch + vista
 *   node generator/scripts/refresh-canton-services-data.mjs --check   # verifica le 4 fonti, non scrive
 *
 * Env: HEALTH_PREMIUMS_URL, PLATE_AUCTIONS_URL, PHARMACY_DUTY_CANTONS_URL,
 * WEATHER_SNAPSHOT_URL sostituiscono le sorgenti; DRY_RUN=1 = --check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFirstOk, isCiWafBlock } from './lib/rewire-fetch.mjs';
import {
  CANTON_GROUPS,
  ShapeError,
  assertPharmacyDutyCantonsShape,
  assertPlateAuctionsShape,
  assertPremiumsShape,
  assertWeatherShape,
  buildCantonServices,
  viewThresholdFailures,
} from './lib/canton-services-data.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node generator/scripts/refresh-canton-services-data.mjs [--check]\n' +
      '  --check         verify the four published service datasets, write nothing\n' +
      '  DRY_RUN=1 env   alias for --check',
  );
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '..', 'data', 'canton-services.json');
const CHECK_ONLY = process.argv.includes('--check') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const INPUTS = [
  { key: 'premiums', file: 'health-premiums.json', env: 'HEALTH_PREMIUMS_URL', assertShape: assertPremiumsShape },
  { key: 'plateAuctions', file: 'plate-auctions.json', env: 'PLATE_AUCTIONS_URL', assertShape: assertPlateAuctionsShape },
  { key: 'pharmacyDuties', file: 'pharmacy-duty-cantons.json', env: 'PHARMACY_DUTY_CANTONS_URL', assertShape: assertPharmacyDutyCantonsShape },
  { key: 'weather', file: 'weather-snapshot.json', env: 'WEATHER_SNAPSHOT_URL', assertShape: assertWeatherShape },
];

const log = (msg) => console.log(`[refresh-canton-services-data] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[refresh-canton-services-data] ${msg}`);
  process.exit(1);
};

const inputs = {};
const unreachable = [];
for (const input of INPUTS) {
  const sources = process.env[input.env]
    ? [process.env[input.env]]
    : [`https://cdn.frontaliereticino.ch/data/${input.file}`, `https://frontaliereticino.ch/data/${input.file}`];
  const got = await fetchFirstOk(sources);
  if (!got.ok) {
    const waf = CHECK_ONLY && process.env.REWIRE_SKIP_WAF_403 === '1' && isCiWafBlock(got.errors);
    log(`${input.file}: ${waf ? 'unreachable from CI (WAF 403)' : 'no source reachable'} — block degrades\n  ${got.errors.join('\n  ')}`);
    unreachable.push(input.file);
    inputs[input.key] = null;
    continue;
  }
  let doc;
  try {
    doc = JSON.parse(got.body);
  } catch (err) {
    fail(`${got.url} is not valid JSON: ${err.message}`);
  }
  try {
    input.assertShape(doc);
  } catch (err) {
    if (err instanceof ShapeError) fail(`${got.url}: ${err.message} — refusing the whole view`);
    throw err;
  }
  inputs[input.key] = doc;
}

const view = buildCantonServices(inputs, CANTON_GROUPS);
const summary = `${view.counts.sourcesOk}/4 sources, ${view.counts.cantonsWithBlock}/24 cantons with a block, by block ${JSON.stringify(view.counts.byBlock)}`;
for (const id of view.unmappedWeatherCities) {
  console.log(`::warning::[refresh-canton-services-data] weather city '${id}' has no canton in WEATHER_CITY_CANTON — map it, do not guess`);
}

if (CHECK_ONLY) {
  log(`--check: ${summary}${unreachable.length ? ` (unreachable: ${unreachable.join(', ')})` : ''}, wrote nothing`);
  process.exit(0);
}

const failures = viewThresholdFailures(view);
if (failures.length) {
  log(`${failures.join('; ')} — keeping the existing view`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, `${JSON.stringify(view, null, 2)}\n`, 'utf-8');
log(`${summary} → ${path.relative(process.cwd(), CACHE)}`);
