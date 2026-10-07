#!/usr/bin/env node
/**
 * validate-canton-sections.mjs — contratto statico del profilo editoriale
 * delle 24 sezioni cantonali (`generator/data/canton-sections.json`).
 *
 * ── PERCHE' ESISTE ─────────────────────────────────────────────────────────
 *
 * Il profilo e' la sorgente da cui `create-article.mjs` (P6) e il workflow per
 * cantone (P8) leggeranno fonti, cadenza, budget e minuto di cron. Finche' non
 * e' collegato non cambia nessun comportamento — ed e' proprio per questo che
 * va vincolato ORA: il giorno in cui un cantone si accende, un URL `http://`,
 * un dominio gia' condannato, una fonte che vieta i bot AI rientrata dalla
 * finestra o due cantoni sullo stesso minuto di cron non fanno esplodere
 * niente, producono un run sterile o una collisione di quota in silenzio.
 *
 * Cosa verifica (tutto offline, solo builtin Node, sul testo dei file):
 *
 *   1. i 24 gruppi sono esattamente quelli di `canton-url-slugs.json`, con
 *      `section` = `canton-<code>` e `members` coerenti con `cantonGroups`;
 *   2. ogni URL e' https, parsabile e unico DENTRO il cantone (fra news, dati
 *      di categoria e decisioni pendenti);
 *   3. nessuna fonte usa un dominio di `DEAD_NEWS_DOMAINS`, letto dal sorgente
 *      di `create-article.mjs` (non e' esportato e importare quel modulo
 *      esegue ~17k righe di module scope: il legame e' coperto dal test, come
 *      fa `news-sources-svizzera.test.mjs`);
 *   4. nessuna `newsSources` e' gia' in `NEWS_SOURCES` o
 *      `NEWS_SOURCES_SVIZZERA` (D6: una fonte = una sezione; D12 per TI);
 *   5. policy robots D10: nessuna fonte in `ownerDecisionPending` compare in
 *      news o dati, e nessun host bloccato per intero (`Disallow: /`) ai bot
 *      AI di input viene usato da NESSUN cantone per un'altra fonte;
 *   6. `cronMinute` intero 0-59, unico fra i cantoni e diverso dai minuti di
 *      `generate-article.yml` (letti dal workflow: frontaliere/svizzera);
 *   7. enum validi (format, parser, kind, language, topics, categorie,
 *      dataShape, quirks — un quirk legato a un parser solo su quel parser) e
 *      `dailyBudget` conforme alla tabella D19;
 *   8. un cantone `enabled` ha almeno una fonte news.
 *
 * Uso:  node scripts/ci/validate-canton-sections.mjs   (exit 1 se ci sono violazioni)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const PROFILE_REL = 'generator/data/canton-sections.json';
export const SLUGS_REL = 'generator/data/canton-url-slugs.json';
export const CREATE_ARTICLE_REL = 'generator/scripts/create-article.mjs';
export const GENERATE_WORKFLOW_REL = '.github/workflows/generate-article.yml';

/** D19 — budget giornaliero massimo per cantone (piano ratificato 2026-10-05). */
export const DAILY_BUDGET_TIERS = Object.freeze({
  4: ['ZH', 'GE', 'VD', 'BE', 'BASILEA', 'TI', 'AG'],
  2: ['LU', 'SG', 'FR', 'VS', 'GR', 'NE', 'JU', 'SO', 'TG', 'ZG'],
  1: ['SH', 'SZ', 'GL', 'NW', 'OW', 'UR', 'APPENZELLO'],
});

export const CATEGORIES = Object.freeze(['carburanti', 'eventi', 'mobilita', 'fisco', 'pensioni', 'servizi']);
export const FORMATS = new Set(['rss', 'atom', 'html', 'sitemap', 'json', 'csv', 'zip']);
export const PARSERS = new Set(['rss', 'atom', 'html-links', 'news-sitemap', 'weekly-sitemap', 'sitemap', 'json-entities', 'json-api', 'csv', 'zip-xml']);
export const KINDS = new Set(['media', 'istituzionale', 'polizia', 'trasporti', 'sindacato', 'eventi', 'fisco', 'previdenza', 'carburanti', 'economia', 'servizi']);
/** Solo questi `kind` alimentano il generatore news; il resto e' dato di categoria (D11). */
export const NEWS_KINDS = new Set(['media', 'istituzionale', 'polizia', 'sindacato', 'economia']);
export const LANGUAGES = new Set(['it', 'de', 'fr', 'rm', 'en']);
export const TOPICS = new Set(['carburanti', 'fisco', 'mobilita', 'eventi', 'pensioni', 'servizi', 'lavoro', 'frontalieri', 'cronaca', 'economia']);
export const DATA_SHAPES = new Set(['csv', 'json', 'html-table', 'agenda', 'feed', 'page', 'sitemap', 'zip-xml']);
export const ALLOWED_CADENCE_HOURS = new Set([1, 2, 3, 4, 6, 8, 12, 24]);
/** I bot che D10 nomina esplicitamente: la lista nel profilo deve contenerli. */
export const REQUIRED_AI_AGENTS = Object.freeze(['ClaudeBot', 'anthropic-ai', 'Claude-Web', 'GPTBot']);

/** quirk → validatore del valore. Un quirk sconosciuto e' un errore: e' un hint che nessuno leggera'. */
const QUIRKS = {
  paywall: (v) => v === 'title+lead',
  emptyPubDate: (v) => v === true,
  datesInList: (v) => v === false,
  charset: (v) => typeof v === 'string' && /^[a-z0-9-]+$/.test(v),
  crawlDelaySeconds: (v) => Number.isFinite(v) && v > 0,
  maxRequestsPerRun: (v) => Number.isInteger(v) && v >= 1,
  // Feed condivisi fra cantoni: il generatore filtra le headline sul gruppo
  // dichiarato prima di applicare recency e gate (es. Unterwalden24 NW/OW).
  filterByCanton: (v) => typeof v === 'string' && /^[A-Z]{2}$/.test(v),
  http1Only: (v) => v === true,
  urlPeriod: (v) => ['year', 'month', 'iso-week'].includes(v),
  datetimeYearOffset: (v) => Number.isInteger(v) && v !== 0,
  robotsTxt: (v) => ['absent', 'unreachable'].includes(v),
  contentSignal: (v) => typeof v === 'string' && !/ai-input\s*=\s*no/i.test(v),
  trainingCrawlersBlocked: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string'),
  // P5b. Regex su path + query dei link-articolo di una pagina `html-links`:
  // ancorata al path (`^/`), cosi' non puo' degradare a «contiene», e
  // compilabile, perche' lo scanner la compila a ogni run.
  articlePathPattern: isPathRegex,
  // P5b. La fonte riemette lo stesso URL con notizie diverse: l'identita'
  // dell'item e' URL + titolo (vedi generator/scripts/lib/source-url-ledger.mjs).
  // `true` = ovunque; una regex sul path = solo li' (i «Ticker» di Tamedia).
  urlReusedForDifferentStories: (v) => v === true || isPathRegex(v),
};

/** quirk → parser su cui ha senso. Dichiarato altrove sarebbe un hint che nessuno legge. */
const QUIRK_PARSERS = {
  articlePathPattern: new Set(['html-links']),
  urlReusedForDifferentStories: new Set(['rss', 'atom', 'news-sitemap', 'sitemap', 'weekly-sitemap']),
};

function isPathRegex(source) {
  if (typeof source !== 'string' || !source.startsWith('^/')) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Letture dal testo dei sorgenti (un valore condiviso ha UNA sorgente) ──────

/** `const <name> = [ … \n];` → stringhe quotate su riga propria. */
function sliceConstArray(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start === -1) throw new Error(`${name} non trovato in ${CREATE_ARTICLE_REL}`);
  const end = src.indexOf('\n];', start);
  if (end === -1) throw new Error(`${name} senza parentesi di chiusura in ${CREATE_ARTICLE_REL}`);
  return src.slice(start, end);
}

export function parseDeadNewsDomains(createArticleSrc) {
  const body = sliceConstArray(createArticleSrc, 'DEAD_NEWS_DOMAINS');
  return [...body.matchAll(/^\s*'([a-z0-9.-]+\.[a-z]{2,})',/gm)].map((m) => m[1]);
}

export function parseGlobalNewsUrls(createArticleSrc) {
  const out = new Set();
  for (const name of ['NEWS_SOURCES', 'NEWS_SOURCES_SVIZZERA']) {
    for (const m of sliceConstArray(createArticleSrc, name).matchAll(/^\s*'(https?:\/\/[^']+)',/gm)) out.add(m[1]);
  }
  return out;
}

/** Minuti dei `cron:` di generate-article.yml (`'M * * * *'`): frontaliere e svizzera. */
export function parseReservedCronMinutes(workflowYaml) {
  const out = new Set();
  for (const m of workflowYaml.matchAll(/^\s*-\s*cron:\s*['"]?([0-9,]+)\s/gm)) {
    for (const x of m[1].split(',')) out.add(Number(x));
  }
  return out;
}

export function loadContext(root = ROOT) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const createArticle = read(CREATE_ARTICLE_REL);
  return {
    slugs: JSON.parse(read(SLUGS_REL)),
    deadDomains: parseDeadNewsDomains(createArticle),
    globalNewsUrls: parseGlobalNewsUrls(createArticle),
    reservedCronMinutes: parseReservedCronMinutes(read(GENERATE_WORKFLOW_REL)),
  };
}

// ── Validazione ──────────────────────────────────────────────────────────────

const hostOf = (u) => new URL(u).hostname.toLowerCase();
const isWholeSiteBlock = (rule) => /->\s*Disallow:\s*\/(\s*;|\s*$)/.test(rule) || /ai-input=no/i.test(rule);

function expectedBudget(code) {
  for (const [budget, codes] of Object.entries(DAILY_BUDGET_TIERS)) if (codes.includes(code)) return Number(budget);
  return undefined;
}

/**
 * @param {any} doc  il profilo parsato
 * @param {{slugs:any, deadDomains:string[], globalNewsUrls:Set<string>, reservedCronMinutes:Set<number>}} ctx
 * @returns {string[]} violazioni (vuoto = valido)
 */
export function validateCantonSections(doc, ctx) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);

  if (!doc || typeof doc !== 'object') return ['profilo: non e\' un oggetto JSON'];
  if (doc.schemaVersion !== 1) err('profilo', `schemaVersion ${doc.schemaVersion} != 1`);
  if (!DATE_RE.test(doc.verifiedAt || '')) err('profilo', 'verifiedAt mancante o non YYYY-MM-DD');
  const agents = Array.isArray(doc.aiInputAgents) ? doc.aiInputAgents : [];
  for (const a of REQUIRED_AI_AGENTS) if (!agents.includes(a)) err('profilo', `aiInputAgents non contiene ${a} (D10)`);
  if (!Array.isArray(doc.cantons)) return [...errors, 'profilo: `cantons` non e\' un array'];

  // 1. copertura e coerenza con canton-url-slugs.json
  const expectedCodes = Object.keys(ctx.slugs.cantons);
  const codes = doc.cantons.map((c) => c?.code);
  const missing = expectedCodes.filter((c) => !codes.includes(c));
  const extra = codes.filter((c) => !expectedCodes.includes(c));
  if (missing.length) err('profilo', `gruppi mancanti rispetto a ${SLUGS_REL}: ${missing.join(', ')}`);
  if (extra.length) err('profilo', `gruppi non presenti in ${SLUGS_REL}: ${extra.join(', ')}`);
  const dupCodes = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dupCodes.length) err('profilo', `codici duplicati: ${[...new Set(dupCodes)].join(', ')}`);
  for (const [code, budget] of Object.entries(DAILY_BUDGET_TIERS).flatMap(([b, cs]) => cs.map((c) => [c, b]))) {
    if (!expectedCodes.includes(code)) err('D19', `${code} (budget ${budget}) non e' un gruppo di ${SLUGS_REL}`);
  }

  // host bloccati per intero ai bot AI, su TUTTI i cantoni (policy D10 cross-cantone)
  const blockedHosts = new Map();
  for (const c of doc.cantons) {
    for (const p of c?.ownerDecisionPending || []) {
      try {
        if (typeof p.robotsRule === 'string' && isWholeSiteBlock(p.robotsRule)) blockedHosts.set(hostOf(p.url), `${c.code} ${p.url}`);
      } catch { /* l'URL invalido e' segnalato sotto */ }
    }
  }

  const cronSeen = new Map();
  for (const c of doc.cantons) {
    const where = c?.code || '<senza code>';
    if (!c || typeof c !== 'object') { err(where, 'voce non oggetto'); continue; }
    if (c.section !== `canton-${String(c.code).toLowerCase()}`) err(where, `section "${c.section}" != "canton-${String(c.code).toLowerCase()}"`);
    const members = ctx.slugs.cantonGroups?.[c.code]?.members || [c.code];
    if (JSON.stringify(c.members) !== JSON.stringify(members)) err(where, `members ${JSON.stringify(c.members)} != ${JSON.stringify(members)} (${SLUGS_REL})`);
    if (!Array.isArray(c.languages) || !c.languages.length || !c.languages.every((l) => LANGUAGES.has(l))) err(where, `languages non valide: ${JSON.stringify(c.languages)}`);
    if (typeof c.enabled !== 'boolean') err(where, 'enabled deve essere boolean');
    if (!ALLOWED_CADENCE_HOURS.has(c.cadenceHours)) err(where, `cadenceHours ${c.cadenceHours} non divide le 24 ore`);
    const budget = expectedBudget(c.code);
    if (c.dailyBudget !== budget) err(where, `dailyBudget ${c.dailyBudget} != ${budget} (D19)`);

    // 6. cron
    if (!Number.isInteger(c.cronMinute) || c.cronMinute < 0 || c.cronMinute > 59) err(where, `cronMinute ${c.cronMinute} non e' un minuto 0-59`);
    else {
      if (ctx.reservedCronMinutes.has(c.cronMinute)) err(where, `cronMinute ${c.cronMinute} collide con ${GENERATE_WORKFLOW_REL}`);
      if (cronSeen.has(c.cronMinute)) err(where, `cronMinute ${c.cronMinute} gia' usato da ${cronSeen.get(c.cronMinute)}`);
      cronSeen.set(c.cronMinute, c.code);
    }

    if (typeof c.frontalieriContext !== 'string' || !c.frontalieriContext.trim()) err(where, 'frontalieriContext vuoto');
    if (!Array.isArray(c.gaps) || !c.gaps.every((g) => typeof g === 'string' && g.trim())) err(where, 'gaps deve essere un array di stringhe');

    const news = Array.isArray(c.newsSources) ? c.newsSources : (err(where, 'newsSources non e\' un array'), []);
    const data = c.categoryDataSources && typeof c.categoryDataSources === 'object' ? c.categoryDataSources : (err(where, 'categoryDataSources mancante'), {});
    const pending = Array.isArray(c.ownerDecisionPending) ? c.ownerDecisionPending : (err(where, 'ownerDecisionPending non e\' un array'), []);
    const cats = Object.keys(data);
    if (JSON.stringify(cats) !== JSON.stringify(CATEGORIES)) err(where, `categoryDataSources deve avere esattamente ${CATEGORIES.join(', ')} (in quest'ordine), trovato ${cats.join(', ')}`);
    if (c.enabled === true && news.length === 0) err(where, 'cantone enabled senza newsSources');

    const urlsInCanton = new Map();
    const checkUrl = (u, label) => {
      let parsed;
      try { parsed = new URL(u); } catch { err(where, `${label}: URL non valido ${u}`); return null; }
      if (parsed.protocol !== 'https:') err(where, `${label}: URL non https ${u}`);
      if (urlsInCanton.has(u)) err(where, `${label}: URL duplicato nel cantone (gia' in ${urlsInCanton.get(u)}) ${u}`);
      urlsInCanton.set(u, label);
      const host = parsed.hostname.toLowerCase().replace(/^(www\d?|media)\./, '');
      const dead = ctx.deadDomains.find((d) => host === d || host.endsWith(`.${d}`));
      if (dead) err(where, `${label}: dominio in DEAD_NEWS_DOMAINS (${dead}) ${u}`);
      return parsed;
    };
    const checkSource = (s, label, isNews) => {
      const lbl = `${label} ${s?.url}`;
      if (!s || typeof s !== 'object') { err(where, `${label}: voce non oggetto`); return; }
      if (!checkUrl(s.url, label)) return;
      if (!FORMATS.has(s.format)) err(where, `${lbl}: format "${s.format}" non valido`);
      if (!PARSERS.has(s.parser)) err(where, `${lbl}: parser "${s.parser}" non valido`);
      if (typeof s.publisher !== 'string' || !s.publisher.trim()) err(where, `${lbl}: publisher vuoto`);
      if (!LANGUAGES.has(s.language)) err(where, `${lbl}: language "${s.language}" non valida`);
      if (!KINDS.has(s.kind)) err(where, `${lbl}: kind "${s.kind}" non valido`);
      if (isNews && !NEWS_KINDS.has(s.kind)) err(where, `${lbl}: kind "${s.kind}" e' un dato di categoria (D11), non una fonte news`);
      if (!Array.isArray(s.topics) || !s.topics.length || !s.topics.every((t) => TOPICS.has(t))) err(where, `${lbl}: topics non validi ${JSON.stringify(s.topics)}`);
      if (!s.quirks || typeof s.quirks !== 'object' || Array.isArray(s.quirks)) err(where, `${lbl}: quirks deve essere un oggetto`);
      else for (const [k, v] of Object.entries(s.quirks)) {
        if (!QUIRKS[k]) err(where, `${lbl}: quirk sconosciuto "${k}"`);
        else if (!QUIRKS[k](v)) err(where, `${lbl}: quirk ${k}=${JSON.stringify(v)} non valido`);
        else if (QUIRK_PARSERS[k] && !QUIRK_PARSERS[k].has(s.parser)) err(where, `${lbl}: quirk ${k} non si applica al parser "${s.parser}"`);
      }
      if (!(s.items7d === null || (Number.isInteger(s.items7d) && s.items7d >= 0))) err(where, `${lbl}: items7d deve essere intero >= 0 o null`);
      if (!DATE_RE.test(s.verifiedAt || '')) err(where, `${lbl}: verifiedAt non YYYY-MM-DD`);
      if (s.reserve !== undefined && s.reserve !== true) err(where, `${lbl}: reserve ammesso solo come true`);
      try {
        const h = hostOf(s.url);
        if (blockedHosts.has(h)) err(where, `${lbl}: host bloccato per intero ai bot AI (D10, vedi ownerDecisionPending ${blockedHosts.get(h)})`);
      } catch { /* gia' segnalato */ }
    };

    for (const s of news) {
      checkSource(s, 'newsSources', true);
      if (s?.url && ctx.globalNewsUrls.has(s.url)) err(where, `newsSources ${s.url}: gia' in NEWS_SOURCES/NEWS_SOURCES_SVIZZERA (D6/D12)`);
      if (s?.dataShape !== undefined) err(where, `newsSources ${s.url}: dataShape e' un campo dei soli dati di categoria`);
    }
    for (const cat of CATEGORIES) {
      const list = data[cat];
      if (!Array.isArray(list)) { err(where, `categoryDataSources.${cat} non e' un array`); continue; }
      for (const s of list) {
        checkSource(s, `categoryDataSources.${cat}`, false);
        if (s?.dataShape !== undefined && !DATA_SHAPES.has(s.dataShape)) err(where, `categoryDataSources.${cat} ${s.url}: dataShape "${s.dataShape}" non valido`);
      }
    }
    // 5. pending: mai dentro news/dati (gia' coperto dall'unicita' per cantone), campi della decisione completi
    for (const p of pending) {
      const lbl = `ownerDecisionPending ${p?.url}`;
      if (!p || typeof p !== 'object') { err(where, 'ownerDecisionPending: voce non oggetto'); continue; }
      checkUrl(p.url, 'ownerDecisionPending');
      if (!Array.isArray(p.blockedAgents) || !p.blockedAgents.length) err(where, `${lbl}: blockedAgents vuoto (la voce non e' una decisione robots)`);
      if (typeof p.robotsRule !== 'string' || !p.robotsRule.trim()) err(where, `${lbl}: robotsRule vuota`);
      if (!DATE_RE.test(p.robotsCheckedAt || '')) err(where, `${lbl}: robotsCheckedAt non YYYY-MM-DD`);
      const bucketOk = p.intendedBucket === 'news' || (typeof p.intendedBucket === 'string' && p.intendedBucket.startsWith('data:') && CATEGORIES.includes(p.intendedBucket.slice(5)));
      if (!bucketOk) err(where, `${lbl}: intendedBucket "${p.intendedBucket}" non valido`);
      if (!KINDS.has(p.kind)) err(where, `${lbl}: kind "${p.kind}" non valido`);
      if (!LANGUAGES.has(p.language)) err(where, `${lbl}: language "${p.language}" non valida`);
      if (!['sources', 'rejected'].includes(p.origin)) err(where, `${lbl}: origin "${p.origin}" non valido`);
      if (!(p.items7d === null || (Number.isInteger(p.items7d) && p.items7d >= 0))) err(where, `${lbl}: items7d deve essere intero >= 0 o null`);
    }
  }
  return errors;
}

function main() {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, PROFILE_REL), 'utf8'));
  const errors = validateCantonSections(doc, loadContext(ROOT));
  if (errors.length) {
    console.error(`${PROFILE_REL}: ${errors.length} violazioni\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  const n = doc.cantons.reduce((a, c) => a + c.newsSources.length, 0);
  console.log(`${PROFILE_REL}: ok (${doc.cantons.length} gruppi, ${n} fonti news)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
