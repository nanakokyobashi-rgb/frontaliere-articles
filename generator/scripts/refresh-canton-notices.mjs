#!/usr/bin/env node
/**
 * Refresh del dataset degli avvisi ufficiali cantonali (D11/P9g).
 *
 * PERCHE' ESISTE
 *
 * Gli hub cantonali (P10) mostrano un blocco «avvisi ufficiali» per fisco,
 * pensioni, mobilita' e servizi: comunicati delle amministrazioni fiscali,
 * delle casse AVS e pensioni, degli uffici mobilita'/cantieri, di sanita' e
 * migrazione. D10 dice che queste fonti lente alimentano gli hub e non il
 * generatore news, D11 che gli hub LEGGONO i dataset di categoria invece di
 * ricrawlare. Il crawler sta nel sito (`scripts/crawl-canton-notices.mjs`,
 * workflow `crawl-canton-notices.yml`) e pubblica `public/data/canton-notices.json`
 * sul CDN; questo script lo scarica, lo valida e lo mette in cache.
 *
 * PERCHE' E' MORBIDO
 *
 * Un produttore irraggiungibile non deve fermare la generazione: il blocco
 * avvisi e' un complemento dell'hub, e la cache precedente resta valida
 * (sono link a pagine ufficiali, non cifre). Esce comunque non-zero se ha
 * SCARICATO qualcosa che non e' il dataset — pagina d'errore servita con 200,
 * forma cambiata, dataset troncato o fermo da giorni — perche' quel documento
 * finirebbe negli hub come se fosse buono.
 *
 * Uso:
 *   node generator/scripts/refresh-canton-notices.mjs           # fetch + cache
 *   node generator/scripts/refresh-canton-notices.mjs --check   # verifica, non scrive
 *
 * DRY_RUN=1 (o "true") e' un alias di --check. CANTON_NOTICES_URL sostituisce le sorgenti.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFirstOk, isCiWafBlock } from './lib/rewire-fetch.mjs';
import { cantonNoticesProblem } from './lib/canton-notices-data.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node generator/scripts/refresh-canton-notices.mjs [--check]\n' +
      '  --check         verify the published notices, write nothing\n' +
      '  DRY_RUN=1 env   alias for --check',
  );
  process.exit(0);
}

const FILE = 'canton-notices.json';
const ENV_URL = process.env.CANTON_NOTICES_URL;
/** CDN prima: l'offload del deploy cancella la copia same-origin (vedi refresh-events-dataset.mjs). */
const SOURCES = ENV_URL ? [ENV_URL] : [`https://cdn.frontaliereticino.ch/data/${FILE}`, `https://frontaliereticino.ch/data/${FILE}`];

// Cache gitignored accanto alle altre del REWIRE set: e' un dato di un altro repo.
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', FILE);

const CHECK_ONLY = process.argv.includes('--check') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const log = (msg) => console.log(`[refresh-canton-notices] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[refresh-canton-notices] ${msg}`);
  process.exit(1);
};
const skip = (msg) => {
  log(`${msg} — keeping the existing cache (hubs render without the notices block if absent)`);
  process.exit(0);
};

const got = await fetchFirstOk(SOURCES);
if (!got.ok) {
  if (CHECK_ONLY && process.env.REWIRE_SKIP_WAF_403 === '1' && isCiWafBlock(got.errors)) {
    skip(`publisher unreachable from CI (WAF 403); shape is gated offline by rewire-json-contracts.test.mjs.\n${got.errors.join('\n')}`);
  }
  skip(`no source reachable —\n  ${got.errors.join('\n  ')}`);
}

let payload;
try {
  payload = JSON.parse(got.body);
} catch (err) {
  fail(`${got.url} is not valid JSON: ${err.message}`);
}

const problem = cantonNoticesProblem(payload);
if (problem) fail(`${got.url} ${problem} — refusing to cache it`);

// Anti-troncamento rispetto alla copia buona: il crawler ha gia' una sua
// soglia anti-shrink, questa protegge da un publish parziale fra i due.
if (fs.existsSync(CACHE)) {
  try {
    const before = JSON.parse(fs.readFileSync(CACHE, 'utf-8'))?.notices?.length ?? 0;
    if (before && payload.notices.length < before / 2) fail(`would shrink from ${before} to ${payload.notices.length} notices — refusing`);
  } catch {
    /* cache illeggibile: la si sovrascrive con un documento validato */
  }
}

const cantons = new Set(payload.notices.map((n) => n.canton)).size;
const dated = payload.notices.filter((n) => n.publishedAt).length;
if (CHECK_ONLY) {
  log(`--check: ${payload.notices.length} notices (${dated} dated) in ${cantons} cantons from ${got.url}, wrote nothing`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, got.body, 'utf-8');
log(`${payload.notices.length} notices (${dated} dated) in ${cantons} cantons from ${got.url} → ${path.relative(process.cwd(), CACHE)}`);
