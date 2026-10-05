#!/usr/bin/env node
/**
 * Refresh dei parametri previdenziali svizzeri dal sito (pipeline D11 «pensioni»).
 *
 * PERCHE' ESISTE
 *
 * Il sito assembla `data/pension-parameters/<anno>.json` con
 * `scripts/fetch-pension-parameters.mjs`: rendite AVS minima/massima e
 * contributi dai promemoria ufficiali AVS/AI (che dichiarano l'anno di
 * validita'), soglie LPP e massimali 3a derivati per legge e incrociati con
 * UFAS, casse di compensazione AVS e casse pensioni cantonali, imposta sul
 * prelievo di capitale per capoluogo (ESTV). Lo pubblica come
 * `public/data/pension-parameters/latest.json`. Gli hub cantonali «pensioni»
 * e il brief di fattualita' leggono quel dataset invece di cifre scritte a
 * mano nel prompt: le cifre indicizzate (massimale 3a, soglie LPP) erano
 * proprio quelle che il brief svizzero doveva ESCLUDERE per non generare
 * allucinazioni.
 *
 * PERCHE' E' UN HARD GATE
 *
 * Una rendita AVS sbagliata o di un anno vecchio in un evergreen e' il difetto
 * piu' visibile possibile (il sito stesso ha pubblicato 2'450 CHF per il 2026
 * mentre la cifra ufficiale era 2'520). Un publisher irraggiungibile, una forma
 * cambiata o un anno vecchio fermano il run.
 *
 * Uso:
 *   node generator/scripts/refresh-pension-parameters.mjs           # fetch + scrive la cache
 *   node generator/scripts/refresh-pension-parameters.mjs --check   # verifica, non scrive
 *   node generator/scripts/refresh-pension-parameters.mjs --help
 *
 * DRY_RUN=1 (o "true") equivale a --check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFirstOk, isCiWafBlock } from './lib/rewire-fetch.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node generator/scripts/refresh-pension-parameters.mjs [--check]\n' +
      '  --check         verify the published dataset, write nothing\n' +
      '  DRY_RUN=1 env   alias for --check',
  );
  process.exit(0);
}

const FILE = 'pension-parameters/latest.json';
const ENV_URL = process.env.PENSION_PARAMETERS_URL;

const SOURCES = ENV_URL
  ? [ENV_URL]
  : [`https://cdn.frontaliereticino.ch/data/${FILE}`, `https://frontaliereticino.ch/data/${FILE}`];

const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pension-parameters.json');
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'rewire', 'pension-parameters.json');

const CANTONS = [
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE',
  'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
];

const CHECK_ONLY =
  process.argv.includes('--check') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const log = (msg) => console.log(`[refresh-pension-parameters] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[refresh-pension-parameters] ${msg}`);
  process.exit(1);
};

let raw;
let SOURCE;
{
  const got = await fetchFirstOk(SOURCES);
  if (got.ok) {
    raw = got.body;
    SOURCE = got.url;
  } else if (CHECK_ONLY && process.env.REWIRE_SKIP_WAF_403 === '1' && isCiWafBlock(got.errors)) {
    log(`publisher unreachable from CI (WAF 403). Shape is gated offline by rewire-json-contracts.test.mjs.\n${got.errors.join('\n')}`);
    process.exit(0);
  } else if (!CHECK_ONLY && process.env.REWIRE_FIXTURE_ON_403 === '1' && isCiWafBlock(got.errors) && fs.existsSync(FIXTURE)) {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.copyFileSync(FIXTURE, CACHE);
    log('copied rewire fixture to cache after CI WAF 403');
    process.exit(0);
  } else {
    fail(`no source reachable —\n${got.errors.join('\n')}`);
  }
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  fail(`${SOURCE} did not return JSON: ${err.message}`);
}

// ── Gate di forma ──────────────────────────────────────────────────────────
if (payload?.schemaVersion !== 1) fail(`${SOURCE} has schemaVersion ${JSON.stringify(payload?.schemaVersion)}, expected 1 — refusing an unrecognised shape`);
const year = payload.year;
if (!Number.isInteger(year)) fail(`${SOURCE} has no integer year`);
const calendarYear = new Date().getUTCFullYear();
if (year < calendarYear - 1) fail(`${SOURCE}: dataset year ${year} is stale (calendar ${calendarYear}) — refusing`);

const f = payload.federal;
if (!f || typeof f !== 'object') fail(`${SOURCE}: federal block missing`);
const avs = f.avs;
const isAmount = (v) => Number.isInteger(v) && v > 0;
if (!isAmount(avs?.minMonthlyCHF) || !isAmount(avs?.maxMonthlyCHF)) fail(`${SOURCE}: federal.avs min/max monthly pension is not a positive integer`);
// Art. 34 LAVS: la rendita massima e' il doppio della minima. Una coppia che non
// lo rispetta e' un parse sbagliato a monte, non una cifra da pubblicare.
if (avs.maxMonthlyCHF !== avs.minMonthlyCHF * 2) fail(`${SOURCE}: federal.avs max ${avs.maxMonthlyCHF} is not twice min ${avs.minMonthlyCHF}`);
const lpp = f.lpp;
for (const k of ['entryThresholdCHF', 'coordinationDeductionCHF', 'maxInsuredSalaryCHF']) {
  if (!isAmount(lpp?.[k])) fail(`${SOURCE}: federal.lpp.${k} is not a positive integer`);
}
if (lpp.entryThresholdCHF !== Math.round(avs.maxMonthlyCHF * 12 * 0.75)) {
  fail(`${SOURCE}: federal.lpp.entryThresholdCHF ${lpp.entryThresholdCHF} is not 3/4 of the annual maximum AVS pension`);
}
if (!Number.isFinite(lpp.minInterestRatePct) || !Number.isFinite(lpp.minConversionRatePct)) fail(`${SOURCE}: federal.lpp rates are not numbers`);
if (!isAmount(f.pillar3a?.maxWithLppCHF) || !isAmount(f.pillar3a?.maxWithoutLppCHF)) fail(`${SOURCE}: federal.pillar3a maxima are not positive integers`);

const cantons = payload.cantons;
if (!cantons || typeof cantons !== 'object' || Array.isArray(cantons)) fail(`${SOURCE}: cantons is not an object`);
const missing = CANTONS.filter((c) => !cantons[c]);
if (missing.length) fail(`${SOURCE}: cantons missing: ${missing.join(',')}`);
const noFund = CANTONS.filter((c) => !/^https:\/\//.test(cantons[c].compensationFund?.url || '') || !cantons[c].compensationFund?.name);
if (noFund.length) fail(`${SOURCE}: compensationFund name/url missing for ${noFund.join(',')}`);

if (CHECK_ONLY) {
  log(`--check: pension-parameters ${year}, AVS ${avs.minMonthlyCHF}-${avs.maxMonthlyCHF}, 26 cantons from ${SOURCE}, wrote nothing`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
// Scrittura atomica: un run interrotto non lascia una cache a meta'.
const tmp = `${CACHE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, raw, 'utf-8');
fs.renameSync(tmp, CACHE);
log(`pension-parameters ${year}: AVS ${avs.minMonthlyCHF}-${avs.maxMonthlyCHF}, 26 cantons from ${SOURCE} → ${path.relative(process.cwd(), CACHE)}`);
