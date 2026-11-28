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
 *   node generator/scripts/build-section-demand-vocabulary.mjs --verify
 *        [--file <json>] [--previous <json>] [--max-change 0.3] [--allow-large-change]
 *
 * `--verify` rilegge il JSON gia' scritto e FALLISCE (exit 1) se una query non
 * rispetta la grammatica chiusa del filtro, se e' sotto `minQueryImpressions`
 * o (con `--previous`) se piu' del 30% delle query di una sezione e' nuovo
 * rispetto al file precedente. Stampa solo conteggi per sezione e categoria,
 * mai il testo di una query.
 *
 * PRIVACY: le query passano dal filtro `lib/section-demand-query-filter.mjs`
 * (grammatica chiusa a token esatti + scarto di nomi, contatti, codici) prima di essere
 * aggregate; nel log finiscono solo conteggi.
 *
 * Senza credenziali o con GSC non raggiungibile esce con codice 1 SENZA toccare
 * il file: un vocabolario vecchio e' meglio di uno vuoto. Le sezioni senza
 * righe restano fuori (il ranker le tratta come "vocabolario insufficiente").
 */
import '../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { SECTION_DEMAND_VOCABULARY_VERSION } from './lib/canton-section-demand-ranker.mjs';
import { QUERY_FILTER_VERSION, classifyDemandQuery } from './lib/section-demand-query-filter.mjs';

const GSC_SITE = 'sc-domain:frontaliereticino.ch';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const LOCALES = ['it', 'en', 'de', 'fr'];
const LOCALE_PREFIX = /^\/(en|de|fr)(?=\/|$)/;
const DAY_MS = 86400000;
export const DEFAULT_OUTPUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'section-demand-vocabulary.json');
export const DEFAULT_TOP = 80;
/** Sotto 5 impression in 28 giorni una query e' rumore, e spesso una persona che cerca se stessa o un conoscente. */
export const MIN_QUERY_IMPRESSIONS = 5;
/** Quota massima di query nuove per sezione rispetto al file precedente. */
export const MAX_SECTION_CHANGE = 0.3;

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
 *
 * PRIVACY: ogni query passa da `classifyDemandQuery` PRIMA dell'aggregazione e
 * quelle che non sono domanda di dominio (nomi di persone, contatti, codici,
 * operatori) vengono SCARTATE, non anonimizzate. Se si passa `stats`, vi si
 * accumulano SOLO i conteggi per categoria di scarto (query distinte): mai il
 * testo di una query scartata.
 */
export function buildVocabularySections(rows, aliasMap, { top = DEFAULT_TOP, minImpressions = MIN_QUERY_IMPRESSIONS, stats = null } = {}) {
  const acc = new Map();
  const verdicts = new Map();
  for (const row of rows) {
    const [rawQuery, page] = row.keys || [];
    const section = sectionOfPath(pathOfPage(page), aliasMap);
    const query = String(rawQuery ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!section || !query) continue;
    const verdictKey = `${section}\u0000${query}`;
    let verdict = verdicts.get(verdictKey);
    if (!verdict) { verdict = classifyDemandQuery(query, { section }); verdicts.set(verdictKey, verdict); }
    if (!verdict.keep) continue;
    const bySection = acc.get(section) || new Map();
    const bucket = bySection.get(query) || { clicks: 0, impressions: 0, positionWeighted: 0 };
    bucket.clicks += row.clicks || 0;
    bucket.impressions += row.impressions || 0;
    bucket.positionWeighted += (row.position || 0) * (row.impressions || 0);
    bySection.set(query, bucket);
    acc.set(section, bySection);
  }
  if (stats) {
    stats.discarded = {};
    stats.keptDistinct = 0;
    for (const verdict of verdicts.values()) {
      if (verdict.keep) stats.keptDistinct += 1;
      else stats.discarded[verdict.reason] = (stats.discarded[verdict.reason] || 0) + 1;
    }
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

/**
 * Verifica un documento gia' costruito. Ritorna SOLO conteggi (mai testo di query).
 * @returns {{ok: boolean, violations: {reasons: object, belowMinimum: number, checked: number},
 *            changes: object[], changeViolations: string[]}}
 */
export function verifyVocabularyDocument(doc, { previous = null, maxChange = MAX_SECTION_CHANGE, allowLargeChange = false } = {}) {
  const reasons = {};
  let belowMinimum = 0;
  let checked = 0;
  const minImpressions = Number(doc?.minQueryImpressions) || MIN_QUERY_IMPRESSIONS;
  const sections = doc && typeof doc.sections === 'object' && doc.sections ? doc.sections : {};
  for (const [section, entry] of Object.entries(sections)) {
    for (const q of Array.isArray(entry?.queries) ? entry.queries : []) {
      checked += 1;
      const verdict = classifyDemandQuery(q?.query, { section });
      if (!verdict.keep) reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1;
      if (!(Number(q?.impressions) >= Math.max(minImpressions, MIN_QUERY_IMPRESSIONS))) belowMinimum += 1;
    }
  }
  const changes = [];
  const changeViolations = [];
  const prevSections = previous && typeof previous.sections === 'object' && previous.sections ? previous.sections : null;
  if (prevSections) {
    for (const [section, entry] of Object.entries(sections)) {
      const old = prevSections[section];
      if (!old) { changes.push({ section, newQueries: null, total: (entry?.queries || []).length, share: null }); continue; }
      const oldSet = new Set((old.queries || []).map((q) => q?.query));
      const current = entry?.queries || [];
      const fresh = current.filter((q) => !oldSet.has(q?.query)).length;
      const share = current.length > 0 ? fresh / current.length : 0;
      changes.push({ section, newQueries: fresh, total: current.length, share: Math.round(share * 100) / 100 });
      if (share > maxChange) changeViolations.push(section);
    }
  }
  const grammarOk = Object.keys(reasons).length === 0 && belowMinimum === 0;
  const changeOk = allowLargeChange || changeViolations.length === 0;
  return { ok: grammarOk && changeOk, violations: { reasons, belowMinimum, checked }, changes, changeViolations };
}

function runVerify(args) {
  const file = typeof args.file === 'string' ? path.resolve(args.file) : DEFAULT_OUTPUT;
  const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  let doc;
  try { doc = readJson(file); } catch (error) { console.error(`verify: file illeggibile (${error.code || 'parse'})`); return 1; }
  let previous = null;
  if (typeof args.previous === 'string') {
    try { previous = readJson(path.resolve(args.previous)); } catch { console.error('verify: file precedente illeggibile: tetto di variazione non verificabile'); return 1; }
  }
  const maxChange = args['max-change'] !== undefined ? Number(args['max-change']) : MAX_SECTION_CHANGE;
  const result = verifyVocabularyDocument(doc, { previous, maxChange, allowLargeChange: args['allow-large-change'] === true });
  const { reasons, belowMinimum, checked } = result.violations;
  console.error(`verify: ${checked} query controllate, violazioni di grammatica per categoria ${JSON.stringify(reasons)}, sotto soglia impression ${belowMinimum}`);
  if (previous) {
    console.error(`verify: variazione per sezione (nuove/totale) ${result.changes.map((c) => `${c.section}:${c.newQueries === null ? 'nuova' : `${c.newQueries}/${c.total}`}`).join(' ')}`);
    if (result.changeViolations.length > 0) {
      console.error(`verify: sezioni oltre il tetto del ${Math.round(maxChange * 100)}%: ${result.changeViolations.join(' ')}${args['allow-large-change'] === true ? ' (ammesso da --allow-large-change)' : ''}`);
    }
  }
  if (!result.ok) { console.error('verify: FALLITO'); return 1; }
  console.error('verify: ok');
  return 0;
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

/** Tetto documentato da Search Console: 50.000 righe per tipo di ricerca e per giorno. */
export const GSC_DAILY_ROW_CAP = 50000;

/**
 * Pagina UNA richiesta (un giorno) fino a esaurire le righe. Fallisce chiuso:
 * `truncated` e' true se si raggiunge il tetto giornaliero di GSC senza vedere
 * una risposta corta (non si puo' provare che sia completa).
 */
export async function gscSweep(query, body, { rowLimit = 25000, dailyCap = GSC_DAILY_ROW_CAP } = {}) {
  const rows = [];
  const maxPages = Math.ceil(dailyCap / rowLimit);
  for (let page = 0; page < maxPages; page += 1) {
    const data = await query({ ...body, rowLimit, startRow: page * rowLimit });
    const batch = data.rows || [];
    rows.push(...batch);
    if (batch.length < rowLimit) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Giorni ISO inclusivi da `from` a `to`. */
export function enumerateDays(from, to) {
  const days = [];
  for (let ms = Date.parse(from); ms <= Date.parse(to); ms += DAY_MS) days.push(new Date(ms).toISOString().slice(0, 10));
  return days;
}

/**
 * Una query GSC per giorno (il tetto di 50.000 righe e' per giorno: una query
 * su 28 giorni puo' perdere la coda senza segnalarlo) e aggregazione a valle in
 * `buildVocabularySections`. Basta un giorno troncato per marcare l'alias.
 */
export async function gscSweepByDay(query, body, { from, to, ...options } = {}) {
  const rows = [];
  let truncated = false;
  for (const day of enumerateDays(from, to)) {
    const sweep = await gscSweep(query, { ...body, startDate: day, endDate: day }, options);
    rows.push(...sweep.rows);
    if (sweep.truncated) truncated = true;
  }
  return { rows, truncated };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verify) { process.exit(runVerify(args)); }
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
    const sweep = await gscSweepByDay((request) => gscQuery(token, request), {
      dimensions: ['query', 'page'],
      dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: `/${alias}/` }] }],
    }, { from: windowFrom, to: windowTo });
    if (sweep.truncated) truncated.push(alias);
    rows.push(...sweep.rows);
  }
  const stats = {};
  const built = buildVocabularySections(rows, aliasMap, { top, stats });
  const document = {
    version: SECTION_DEMAND_VOCABULARY_VERSION,
    source: 'google-search-console',
    window: { from: windowFrom, to: windowTo, days },
    generatedAt: new Date().toISOString(),
    top,
    minQueryImpressions: MIN_QUERY_IMPRESSIONS,
    queryFilterVersion: QUERY_FILTER_VERSION,
    // Solo conteggi per categoria di scarto, mai il testo delle query scartate.
    discardedByReason: stats.discarded,
    truncatedAliases: truncated,
    sections: built,
  };
  const summary = Object.entries(built).map(([s, v]) => `${s}:${v.keptQueries}q/${v.keptImpressions}i`).join(' ');
  console.error(`vocabolario: ${Object.keys(built).length}/${sections.length} sezioni con segnale (${windowFrom}..${windowTo}) ${summary}`);
  console.error(`query distinte tenute=${stats.keptDistinct} scartate per categoria: ${JSON.stringify(stats.discarded)}`);
  if (Object.keys(built).length === 0) throw new Error('nessuna sezione con query: il file non viene toccato');
  if (args['dry-run']) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeVocabularyAtomically(out, `${JSON.stringify(document, null, 1)}\n`);
  console.error(`scritto ${path.relative(process.cwd(), out)}`);
}

// Scrittura atomica: temp accanto al target + renameSync, cosi' un SIGKILL del
// workflow (timeout-minutes) non lascia mai un vocabolario troncato.
let writeTmpSeq = 0;
function writeVocabularyAtomically(file, content) {
  const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`build-section-demand-vocabulary: ${error.message}`); process.exit(1); });
}
