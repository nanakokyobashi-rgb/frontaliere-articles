#!/usr/bin/env node
/**
 * build-section-demand-vocabulary.mjs — rigenera
 * `generator/data/section-demand-vocabulary.json` (F6.2, obiettivo O2).
 *
 * Per ogni sezione cantonale legge da Search Console (ultimi 28 giorni, fino a
 * 3 giorni fa per il ritardo di GSC) le query che hanno portato impression sulle
 * pagine della sezione — hub e articoli nelle QUATTRO lingue, quindi anche le
 * query in tedesco/francese dei cantoni — e le aggrega per query con impression,
 * click e posizione media pesata. Il ranker locale
 * (`lib/canton-section-demand-ranker.mjs`) le usa come vocabolario di domanda.
 *
 * Uso (service account via Remote Config; nessun segreto viene stampato):
 *   source ~/Projects/frontaliere/bin/rc-env.sh
 *   node generator/scripts/build-section-demand-vocabulary.mjs [--days 28] [--top 80]
 *        [--sections canton-ti,canton-vd] [--out <file>] [--dry-run]
 *
 * Senza credenziali o con GSC non raggiungibile esce con codice 1 SENZA toccare
 * il file: un vocabolario vecchio e' meglio di uno vuoto. Le sezioni senza
 * righe restano fuori (il ranker le tratta come "vocabolario insufficiente").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { SECTION_DEMAND_VOCABULARY_VERSION } from './lib/canton-section-demand-ranker.mjs';

const GSC_SITE = 'sc-domain:frontaliereticino.ch';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const LOCALES = ['it', 'en', 'de', 'fr'];
const LOCALE_PREFIX = /^\/(en|de|fr)(?=\/|$)/;
const DAY_MS = 86400000;
export const DEFAULT_OUTPUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'section-demand-vocabulary.json');
export const DEFAULT_TOP = 80;
/** Una query con una sola impression e' rumore, non domanda. */
export const MIN_QUERY_IMPRESSIONS = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[token.slice(2)] = true;
    else { args[token.slice(2)] = next; i += 1; }
  }
  return args;
}

/** Alias di hub per lingua -> sezione, per le sole sezioni richieste. */
export function buildAliasMap(sections) {
  const map = new Map();
  for (const section of sections) {
    const core = ARTICLE_SECTION_CORE_ALL[section];
    if (!core) throw new Error(`sezione sconosciuta: ${section}`);
    for (const locale of LOCALES) map.set(core.indexSlug[locale], section);
  }
  return map;
}

export function sectionOfPath(pathname, aliasMap) {
  const rest = pathname.replace(LOCALE_PREFIX, '');
  const alias = rest.split('/')[1];
  return aliasMap.get(alias) || null;
}

function pathOfPage(value) {
  try { return new URL(value).pathname; } catch { return String(value).startsWith('/') ? value : ''; }
}

/**
 * Funzione pura: righe GSC `{keys: [query, page], clicks, impressions, position}`
 * -> `{[section]: {...}}`. Esportata per i test.
 */
export function buildVocabularySections(rows, aliasMap, { top = DEFAULT_TOP, minImpressions = MIN_QUERY_IMPRESSIONS } = {}) {
  const acc = new Map();
  for (const row of rows) {
    const [rawQuery, page] = row.keys || [];
    const section = sectionOfPath(pathOfPage(page), aliasMap);
    const query = String(rawQuery ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!section || !query) continue;
    const bySection = acc.get(section) || new Map();
    const bucket = bySection.get(query) || { clicks: 0, impressions: 0, positionWeighted: 0 };
    bucket.clicks += row.clicks || 0;
    bucket.impressions += row.impressions || 0;
    bucket.positionWeighted += (row.position || 0) * (row.impressions || 0);
    bySection.set(query, bucket);
    acc.set(section, bySection);
  }
  const sections = {};
  for (const section of [...acc.keys()].sort()) {
    const all = [...acc.get(section).entries()].map(([query, b]) => ({
      query,
      impressions: b.impressions,
      clicks: b.clicks,
      position: b.impressions > 0 ? Math.round((b.positionWeighted / b.impressions) * 10) / 10 : null,
    }));
    const kept = all
      .filter((q) => q.impressions >= minImpressions)
      .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query))
      .slice(0, top);
    if (kept.length === 0) continue;
    sections[section] = {
      totalQueries: all.length,
      keptQueries: kept.length,
      keptImpressions: kept.reduce((sum, q) => sum + q.impressions, 0),
      queries: kept,
    };
  }
  return sections;
}

async function gscToken() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const fallback = path.join(os.homedir(), '.config', 'frontaliere', 'sa-frontaliere-ticino.json');
    if (fs.existsSync(fallback)) process.env.GOOGLE_APPLICATION_CREDENTIALS = fallback;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('nessuna credenziale service account (GOOGLE_APPLICATION_CREDENTIALS)');
  const { GoogleAuth } = await import('google-auth-library');
  const client = await new GoogleAuth({ scopes: [GSC_SCOPE] }).getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('token GSC non ottenuto');
  return token;
}

async function gscQuery(token, body) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`;
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) return await res.json();
      lastError = new Error(`GSC ${res.status}: ${(await res.text()).slice(0, 160)}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) { lastError = error; }
    await sleep(1000 * 2 ** attempt);
  }
  throw lastError;
}

async function gscSweep(token, body, { rowLimit = 25000, maxPages = 8 } = {}) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const data = await gscQuery(token, { ...body, rowLimit, startRow: page * rowLimit });
    const batch = data.rows || [];
    rows.push(...batch);
    if (batch.length < rowLimit) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = Number(args.days) || 28;
  const top = Number(args.top) || DEFAULT_TOP;
  const out = typeof args.out === 'string' ? path.resolve(args.out) : DEFAULT_OUTPUT;
  const sections = typeof args.sections === 'string'
    ? args.sections.split(',')
    : Object.values(ARTICLE_SECTION_CORE_ALL).filter((core) => core.kind === 'canton').map((core) => core.section);
  const aliasMap = buildAliasMap(sections);
  const endMs = Date.now() - 3 * DAY_MS; // GSC pubblica con 2-3 giorni di ritardo.
  const windowTo = isoDay(endMs);
  const windowFrom = isoDay(endMs - (days - 1) * DAY_MS);

  const token = await gscToken();
  const rows = [];
  const truncated = [];
  for (const alias of aliasMap.keys()) {
    const sweep = await gscSweep(token, {
      startDate: windowFrom,
      endDate: windowTo,
      dimensions: ['query', 'page'],
      dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: `/${alias}/` }] }],
    });
    if (sweep.truncated) truncated.push(alias);
    rows.push(...sweep.rows);
  }
  const built = buildVocabularySections(rows, aliasMap, { top });
  const document = {
    version: SECTION_DEMAND_VOCABULARY_VERSION,
    source: 'google-search-console',
    window: { from: windowFrom, to: windowTo, days },
    generatedAt: new Date().toISOString(),
    top,
    minQueryImpressions: MIN_QUERY_IMPRESSIONS,
    truncatedAliases: truncated,
    sections: built,
  };
  const summary = Object.entries(built).map(([s, v]) => `${s}:${v.keptQueries}q/${v.keptImpressions}i`).join(' ');
  console.error(`vocabolario: ${Object.keys(built).length}/${sections.length} sezioni con segnale (${windowFrom}..${windowTo}) ${summary}`);
  if (Object.keys(built).length === 0) throw new Error('nessuna sezione con query: il file non viene toccato');
  if (args['dry-run']) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(document, null, 1)}\n`);
  console.error(`scritto ${path.relative(process.cwd(), out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`build-section-demand-vocabulary: ${error.message}`); process.exit(1); });
}
