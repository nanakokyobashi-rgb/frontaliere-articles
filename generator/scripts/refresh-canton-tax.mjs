#!/usr/bin/env node
/**
 * Refresh del dataset fiscale per cantone dal sito (pipeline D11 «fisco»).
 *
 * PERCHE' ESISTE
 *
 * Il sito assembla `data/canton-tax/<anno>.json` da fonti ufficiali ESTV
 * (onere fiscale nei 26 capoluoghi, aliquote dell'imposta alla fonte per
 * cantone, pagine cantonali) con `scripts/fetch-canton-tax-data.mjs` e lo
 * pubblica come `public/data/canton-tax/latest.json`. Gli hub cantonali e il
 * brief di fattualita' degli articoli cantonali LEGGONO quel dataset (D11):
 * non ricrawlano ESTV da qui. Stessa direzione degli altri REWIRE: il corpus
 * tira un artefatto pubblico del sito, mai un import.
 *
 * PERCHE' E' UN HARD GATE
 *
 * Un hub fiscale cantonale senza dati non deve sovrascrivere quello buono, e
 * una cifra fiscale sbagliata in un evergreen cantonale e' esattamente il
 * difetto che ha fatto bocciare al fact-check 94 evergreen svizzeri su 110.
 * Un publisher irraggiungibile, una forma cambiata o un anno vecchio fermano
 * il run invece di consegnare numeri non verificati.
 *
 * Uso:
 *   node generator/scripts/refresh-canton-tax.mjs           # fetch + scrive la cache
 *   node generator/scripts/refresh-canton-tax.mjs --check   # verifica, non scrive
 *   node generator/scripts/refresh-canton-tax.mjs --help
 *
 * DRY_RUN=1 (o "true") equivale a --check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFirstOk, isCiWafBlock } from './lib/rewire-fetch.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node generator/scripts/refresh-canton-tax.mjs [--check]\n' +
      '  --check         verify the published dataset, write nothing\n' +
      '  DRY_RUN=1 env   alias for --check',
  );
  process.exit(0);
}

const FILE = 'canton-tax/latest.json';
const ENV_URL = process.env.CANTON_TAX_URL;

/** Stessa regola degli altri REWIRE: CDN prima, same-origin come ripiego. */
const SOURCES = ENV_URL
  ? [ENV_URL]
  : [`https://cdn.frontaliereticino.ch/data/${FILE}`, `https://frontaliereticino.ch/data/${FILE}`];

/** Cache gitignored: e' un dato di un altro repo, non si committa qui. */
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'canton-tax.json');
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'rewire', 'canton-tax.json');

/** I 26 cantoni: il dataset li copre tutti per l'onere, per contratto. */
const CANTONS = [
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE',
  'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
];
/** Soglia del produttore (validate-canton-tax-data.mjs): tariffe alla fonte per almeno 24 cantoni. */
const MIN_WITHHOLDING_CANTONS = 24;

const CHECK_ONLY =
  process.argv.includes('--check') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const log = (msg) => console.log(`[refresh-canton-tax] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[refresh-canton-tax] ${msg}`);
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
// Un publisher fermo e' il fallimento che sembra un successo: cifre di due anni
// fa presentate come attuali. Il produttore riscrive latest.json appena ESTV
// pubblica l'anno nuovo; oltre un anno di ritardo e' un guasto.
const calendarYear = new Date().getUTCFullYear();
if (year < calendarYear - 1) fail(`${SOURCE}: dataset year ${year} is stale (calendar ${calendarYear}) — refusing`);
const brackets = payload.burden?.incomeBracketsCHF;
if (!Array.isArray(brackets) || brackets.length < 2 || brackets.some((v) => !Number.isFinite(v))) {
  fail(`${SOURCE}: burden.incomeBracketsCHF is not a list of incomes`);
}
const cantons = payload.cantons;
if (!cantons || typeof cantons !== 'object' || Array.isArray(cantons)) fail(`${SOURCE}: cantons is not an object`);
const missing = CANTONS.filter((c) => !cantons[c]);
if (missing.length) fail(`${SOURCE}: cantons missing: ${missing.join(',')}`);
for (const code of CANTONS) {
  const row = cantons[code].burdenPct?.[String(year)];
  if (!Array.isArray(row) || row.length !== brackets.length || row.some((v) => !Number.isFinite(v) || v <= 0 || v >= 50)) {
    fail(`${SOURCE}: ${code} burdenPct ${year} is not ${brackets.length} percentages in (0,50)`);
  }
  // Al reddito piu' alto nessun capoluogo svizzero sta sotto il 5% (minimo
  // misurato 13,43% nel 2026, 250k): un valore piu' basso e' un cambio di unita'
  // (frazione invece di %) che il controllo d'intervallo non vede.
  if (row[row.length - 1] < 5) fail(`${SOURCE}: ${code} burdenPct ${year} tops out at ${row[row.length - 1]}% — looks like fractions, not percentages`);
}
const withWithholding = CANTONS.filter((code) => {
  const a0 = cantons[code].withholding?.ratesPct?.A0;
  return Array.isArray(a0) && a0.length > 0 && a0.every((v) => Number.isFinite(v) && v >= 0 && v < 50);
});
if (withWithholding.length < MIN_WITHHOLDING_CANTONS) {
  fail(`${SOURCE}: withholding A0 rates for only ${withWithholding.length}/26 cantons (minimum ${MIN_WITHHOLDING_CANTONS})`);
}

if (CHECK_ONLY) {
  log(`--check: canton-tax ${year}, 26 cantons, withholding ${withWithholding.length}/26 from ${SOURCE}, wrote nothing`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, raw, 'utf-8');
log(`canton-tax ${year}: 26 cantons, withholding ${withWithholding.length}/26 from ${SOURCE} → ${path.relative(process.cwd(), CACHE)}`);
