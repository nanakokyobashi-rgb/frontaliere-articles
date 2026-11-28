/**
 * canton-nonnews.mjs — formati non-news per le sezioni cantonali dietro la
 * manopola `CANTON_NONNEWS_SECTIONS` (F4.2 del piano «cadenza 20 articoli per
 * sezione», decisione del proprietario §1.3).
 *
 * ## Cosa risolve
 *
 * Senza notizie utilizzabili una sezione cantonale esce con exit 4
 * `CANTON_EVERGREEN_POOL_DISABLED` (`create-article.mjs`): il profilo ha
 * `evergreenPool: null` perche' il pool evergreen nazionale e' frontaliero. Con
 * la catena ad alta cadenza (`CANTON_HIGH_CADENCE_SECTIONS`) i tentativi in piu'
 * finirebbero vuoti. Per le sezioni elencate in `CANTON_NONNEWS_SECTIONS` il
 * generatore ripiega su un pool di argomenti per cantone: guide su procedure
 * cantonali, articoli su dati ufficiali datati, approfondimenti.
 *
 * ## Come si resta onesti
 *
 * Il candidato non-news NON e' un'idea generata: e' una pagina UFFICIALE del
 * cantone (`generator/data/canton-evergreen-topics/<sezione>.json`) con almeno
 * `MIN_VERIFIED_FACTS` citazioni verbatim. A ogni run la pagina viene scaricata
 * e i fatti sono cercati nel testo: se la fonte non risponde 200, o se meno di 3
 * fatti compaiono, l'argomento si scarta. Il testo della pagina diventa il
 * SOURCE CONTENT della generazione ordinaria: stessi gate di fact-check,
 * traduzione e dedup di una notizia (nessun gate si abbassa).
 *
 * ## Regole (§5 F4.2)
 *
 *   - lista vuota/assente = comportamento di prima (exit 4 invariato);
 *   - priorita' alle notizie: questo modulo si usa solo dopo che il pool news
 *     del run e' vuoto; il budget giornaliero e' applicato a monte da
 *     `canton-generation-admit.mjs` (skip `daily-budget`);
 *   - copertura a 90 giorni: una fonte gia' registrata nel ledger della sezione
 *     da meno di 90 giorni (o senza data: voce storica, permanente) si scarta;
 *   - anti-template fra cantoni: lo scheletro dell'argomento (parole senza nomi
 *     di cantone) non puo' assomigliare a un articolo recente di un ALTRO
 *     cantone, ne' a un argomento del pool di un altro cantone.
 *
 * Solo builtin Node e moduli puri del corpus: niente rete a import-time, la
 * fetch arriva come argomento. Vedi generator/tests/canton-nonnews.test.mjs.
 */
import '../../../host/cantonSectionsBootstrap.mjs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANTON_DISPLAY_NAMES, parseEnabledCantonSections } from './canton-section-profile.mjs';

export const CANTON_NONNEWS_ENV = 'CANTON_NONNEWS_SECTIONS';

/** Valore di `profile.evergreenPool` per una sezione cantonale abilitata. */
export const CANTON_NONNEWS_POOL_ID = 'canton-nonnews';

/** Citazioni verbatim che devono comparire nella fonte perche' l'argomento sia usabile. */
export const MIN_VERIFIED_FACTS = 3;

/** Argomenti minimi per una sezione pilota. */
export const MIN_POOL_TOPICS = 15;

/** Finestra di copertura: una fonte usata da meno di tanti giorni si salta. */
export const COVERAGE_WINDOW_DAYS = 90;

/** Soglia di somiglianza fra scheletri di argomento (Jaccard sui token). */
export const TEMPLATE_SKELETON_JACCARD = 0.6;

export const NONNEWS_FORMATS = Object.freeze(['guida', 'dati', 'approfondimento']);

/** User agent onesto, lo stesso dichiarato dagli scanner cantonali. */
export const NONNEWS_USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereCorpusBot/1.0; +https://frontaliereticino.ch)';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'canton-evergreen-topics');

// ── La manopola ──────────────────────────────────────────────────────────────

/**
 * Le sezioni in lista (stessa sintassi di `CANTON_HIGH_CADENCE_SECTIONS`).
 *
 * @param {string | undefined | null} raw
 * @returns {{ sections: Set<string>, unknown: string[] }}
 */
export function parseNonNewsSections(raw) {
  return parseEnabledCantonSections(raw);
}

/** `section` e' in lista nell'ambiente dato? Assente o vuoto = no. */
export function isNonNewsSection(section, env = process.env) {
  return parseNonNewsSections(env?.[CANTON_NONNEWS_ENV]).sections.has(section);
}

// ── Il pool versionato ───────────────────────────────────────────────────────

export function topicPoolPath(section, dir = DATA_DIR) {
  return path.join(dir, `${section}.json`);
}

/**
 * Il pool di una sezione, letto dal disco. Mai lancia: un file assente o
 * illeggibile e' `{ pool: null, error }` (la sezione resta senza non-news).
 */
export function loadTopicPool(section, { dir = DATA_DIR } = {}) {
  const file = topicPoolPath(section, dir);
  if (!existsSync(file)) return { pool: null, error: `pool assente: ${file}` };
  try {
    return { pool: JSON.parse(readFileSync(file, 'utf8')), error: null };
  } catch (e) {
    return { pool: null, error: `pool illeggibile (${file}): ${e.message}` };
  }
}

const hostMatches = (host, official) => host === official || host.endsWith(`.${official}`);

/**
 * Validazione OFFLINE di un pool (schema, unicita', ospiti ufficiali).
 *
 * @returns {string[]} gli errori (vuoto = valido)
 */
export function validateTopicPool(pool, { section, minTopics = 0 } = {}) {
  const errors = [];
  if (!pool || typeof pool !== 'object') return ['pool non e\' un oggetto'];
  if (pool.schemaVersion !== 1) errors.push('schemaVersion deve essere 1');
  if (section && pool.section !== section) errors.push(`section "${pool.section}" != "${section}"`);
  const hosts = Array.isArray(pool.officialHosts) ? pool.officialHosts.filter((h) => typeof h === 'string' && h) : [];
  if (hosts.length === 0) errors.push('officialHosts mancante');
  const topics = Array.isArray(pool.topics) ? pool.topics : [];
  if (topics.length < minTopics) errors.push(`argomenti ${topics.length} < ${minTopics}`);
  const ids = new Set();
  const keywords = new Set();
  const urls = new Set();
  for (const [i, topic] of topics.entries()) {
    const at = `topics[${i}]${topic?.id ? ` (${topic.id})` : ''}`;
    if (!topic || typeof topic !== 'object') { errors.push(`${at}: non e' un oggetto`); continue; }
    for (const field of ['id', 'keyword', 'angle']) {
      if (typeof topic[field] !== 'string' || !topic[field].trim()) errors.push(`${at}: ${field} mancante`);
    }
    if (!NONNEWS_FORMATS.includes(topic.format)) errors.push(`${at}: format "${topic.format}" non ammesso`);
    if (ids.has(topic.id)) errors.push(`${at}: id duplicato`);
    ids.add(topic.id);
    if (keywords.has(topic.keyword)) errors.push(`${at}: keyword duplicata`);
    keywords.add(topic.keyword);
    let host = '';
    try {
      const u = new URL(topic.source?.url || '');
      host = u.hostname.toLowerCase();
      if (u.protocol !== 'https:') errors.push(`${at}: source.url non https`);
    } catch { errors.push(`${at}: source.url non valido`); }
    if (host && hosts.length && !hosts.some((h) => hostMatches(host, h))) {
      errors.push(`${at}: host ${host} fuori da officialHosts (${hosts.join(', ')})`);
    }
    if (urls.has(topic.source?.url)) errors.push(`${at}: source.url duplicato nel pool`);
    urls.add(topic.source?.url);
    const facts = Array.isArray(topic.facts) ? topic.facts : [];
    if (facts.length < MIN_VERIFIED_FACTS) errors.push(`${at}: ${facts.length} fatti < ${MIN_VERIFIED_FACTS}`);
    const evidences = new Set();
    for (const [j, fact] of facts.entries()) {
      if (typeof fact?.claim !== 'string' || !fact.claim.trim()) errors.push(`${at}: facts[${j}].claim mancante`);
      if (typeof fact?.evidence !== 'string' || normalizeEvidenceText(fact.evidence).length < 8) {
        errors.push(`${at}: facts[${j}].evidence mancante o troppo corta`);
      } else if (evidences.has(normalizeEvidenceText(fact.evidence))) {
        errors.push(`${at}: facts[${j}].evidence duplicata`);
      } else {
        evidences.add(normalizeEvidenceText(fact.evidence));
      }
    }
  }
  return errors;
}

// ── Testo della fonte e fatti verificati ─────────────────────────────────────

/** Normalizza per il confronto verbatim: apostrofi tipografici, spazi, maiuscole. */
export function normalizeEvidenceText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&rsquo;': "'", '&lsquo;': "'", '&#x27;': "'", '&lt;': '<', '&gt;': '>' };

/** Testo leggibile di una pagina HTML (senza script/stile/tag). */
export function htmlToPlainText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|amp|quot|#39|apos|rsquo|lsquo|#x27|lt|gt);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Quali fatti dell'argomento compaiono, verbatim, nel testo della fonte.
 *
 * @returns {{ found: string[], missing: string[], ok: boolean }}
 */
export function verifyTopicOnPage(topic, pageText, minFacts = MIN_VERIFIED_FACTS) {
  const haystack = normalizeEvidenceText(pageText);
  const found = [];
  const missing = [];
  for (const fact of topic?.facts || []) {
    const needle = normalizeEvidenceText(fact?.evidence);
    if (needle && haystack.includes(needle)) found.push(fact.evidence);
    else missing.push(fact?.evidence ?? '');
  }
  return { found, missing, ok: found.length >= minFacts };
}

/**
 * Scarica la fonte ufficiale. `fetchImpl` e' iniettabile (test, script).
 *
 * @returns {Promise<{ ok: boolean, status: number, text: string, error?: string }>}
 */
export async function fetchSourcePage(url, { fetchImpl = globalThis.fetch, timeoutMs = 25_000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': NONNEWS_USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'de,fr;q=0.8,it;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = Number(res?.status) || 0;
    if (status !== 200) return { ok: false, status, text: '', error: `HTTP ${status}` };
    return { ok: true, status, text: htmlToPlainText(await res.text()) };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e?.message || e) };
  }
}

// ── Anti-template ────────────────────────────────────────────────────────────

const SKELETON_STOPWORDS = new Set([
  'a', 'ad', 'al', 'alla', 'alle', 'allo', 'ai', 'agli', 'con', 'da', 'dal', 'dalla', 'dei', 'del', 'della', 'delle', 'di',
  'e', 'ed', 'i', 'il', 'in', 'la', 'le', 'lo', 'nel', 'nella', 'nelle', 'nei', 'per', 'su', 'un', 'una', 'che', 'come',
  'cosa', 'quando', 'chi', 'dopo', 'dal', 'o', 'se', 'si', 'non', 'piu', 'più', 'cantone', 'canton', 'kanton', 'canton',
]);

/** Nomi (e aggettivi) dei cantoni: tolti dallo scheletro. */
const CANTON_TOKEN_EXTRA = ['vallese', 'valesano', 'valesana', 'vallesano', 'vallesana', 'bernese', 'basilese', 'basilea', 'berna', 'citta', 'sion', 'basel', 'bern', 'valais', 'wallis'];

function cantonNameTokens() {
  const tokens = new Set(CANTON_TOKEN_EXTRA);
  for (const name of Object.values(CANTON_DISPLAY_NAMES)) {
    const folded = normalizeEvidenceText(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (const part of folded.split(/[^a-z0-9]+/)) if (part.length > 2) tokens.add(part);
  }
  return tokens;
}

/**
 * Lo scheletro di un titolo/slug: token minuscoli, senza accenti, senza
 * stopword e senza nomi di cantone. Due argomenti con lo stesso scheletro sono
 * lo stesso articolo col solo nome cambiato (rischio doorway).
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function topicSkeleton(text) {
  const names = cantonNameTokens();
  const out = new Set();
  const folded = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const raw of folded.split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw)) continue;
    if (SKELETON_STOPWORDS.has(raw) || names.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Coppie di argomenti di CANTONI DIVERSI con lo stesso scheletro (offline).
 *
 * @param {Record<string, {topics?: Array<{id: string, keyword: string}>}>} poolsBySection
 */
export function findCrossCantonTemplateClones(poolsBySection, threshold = TEMPLATE_SKELETON_JACCARD) {
  const flat = [];
  for (const [section, pool] of Object.entries(poolsBySection || {})) {
    for (const topic of pool?.topics || []) flat.push({ section, id: topic.id, skeleton: topicSkeleton(topic.keyword) });
  }
  const clones = [];
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[i].section === flat[j].section) continue;
      const sim = jaccard(flat[i].skeleton, flat[j].skeleton);
      if (sim >= threshold) clones.push({ a: `${flat[i].section}:${flat[i].id}`, b: `${flat[j].section}:${flat[j].id}`, sim });
    }
  }
  return clones;
}

/**
 * Un articolo recente di un ALTRO cantone ha lo stesso scheletro dell'argomento?
 *
 * @param {{keyword: string}} topic
 * @param {Array<{id: string, section?: string}>} otherCantonArticles id (slug) degli articoli recenti degli altri cantoni
 * @returns {{ id: string, section?: string, sim: number } | null}
 */
export function findTemplateClone(topic, otherCantonArticles, threshold = TEMPLATE_SKELETON_JACCARD) {
  const skeleton = topicSkeleton(topic?.keyword);
  for (const article of otherCantonArticles || []) {
    const sim = jaccard(skeleton, topicSkeleton(String(article?.id ?? '').replace(/-/g, ' ')));
    if (sim >= threshold) return { id: article.id, section: article.section, sim };
  }
  return null;
}

// ── Copertura a 90 giorni ────────────────────────────────────────────────────

/**
 * La fonte e' gia' stata usata dalla sezione entro la finestra?
 *
 * Il ledger `article-source-urls.json` registra, per ogni fonte, `{articleId,
 * ts}` (o la stringa nuda delle voci storiche). Una voce senza data e'
 * permanente, come nel ledger: un timestamp illeggibile non sblocca la fonte.
 *
 * @param {Record<string, unknown>} ledger
 * @param {string} key chiave normalizzata dell'URL (`newsUrlKey`)
 * @returns {boolean}
 */
export function sourceCoveredWithin(ledger, key, { now = Date.now(), windowDays = COVERAGE_WINDOW_DAYS } = {}) {
  if (!ledger || typeof ledger !== 'object' || !key) return false;
  const value = ledger[key];
  if (value == null) return false;
  const ts = typeof value === 'object' && typeof value.ts === 'string' ? Date.parse(value.ts) : NaN;
  if (!Number.isFinite(ts)) return true; // voce storica o data illeggibile: permanente
  return now - ts <= windowDays * 86_400_000;
}

// ── La scelta ────────────────────────────────────────────────────────────────

/** Indice di partenza che ruota col giorno, cosi' le sezioni non ripartono sempre dallo stesso argomento. */
export function rotationStart(section, now, size) {
  if (!size) return 0;
  const day = Math.floor(now / 86_400_000);
  let salt = 0;
  for (const ch of section) salt = (salt * 31 + ch.charCodeAt(0)) >>> 0;
  return (day + salt) % size;
}

/**
 * Il primo argomento del pool utilizzabile in questo run.
 *
 * Gli scarti sono registrati (`skipped`) con una ragione: `rejected`
 * (ledger di ban/strike), `covered-90d`, `template-clone`, `preflight-duplicate`,
 * `source-unreachable`, `facts-unverified`. L'ordine dei controlli va dal piu'
 * economico (locale) al piu' costoso (rete).
 *
 * @param {object} args
 * @param {string} args.section
 * @param {{topics: Array<any>}} args.pool
 * @param {number} [args.now]
 * @param {(topic: any) => boolean} [args.isRejected] ban/strike del ledger evergreen
 * @param {(topic: any) => boolean} [args.isCovered] copertura a 90 giorni sulla fonte
 * @param {Array<{id: string, section?: string}>} [args.otherCantonArticles]
 * @param {(topic: any) => boolean} [args.isPreflightDuplicate]
 * @param {(url: string) => Promise<{ok: boolean, status: number, text: string, error?: string}>} args.fetchPage
 * @param {Set<string>} [args.excludeIds] gia' tentati in questo run
 * @returns {Promise<{ topic: any, pageText: string, verified: string[], skipped: Array<{id: string, reason: string, detail?: string}> } | null>}
 */
export async function pickNonNewsTopic({
  section, pool, now = Date.now(), isRejected = () => false, isCovered = () => false,
  otherCantonArticles = [], isPreflightDuplicate = () => false, fetchPage, excludeIds = new Set(),
}) {
  const topics = Array.isArray(pool?.topics) ? pool.topics : [];
  const skipped = [];
  const start = rotationStart(section, now, topics.length);
  for (let offset = 0; offset < topics.length; offset++) {
    const topic = topics[(start + offset) % topics.length];
    if (excludeIds.has(topic.id)) continue;
    if (isRejected(topic)) { skipped.push({ id: topic.id, reason: 'rejected' }); continue; }
    if (isCovered(topic)) { skipped.push({ id: topic.id, reason: 'covered-90d' }); continue; }
    const clone = findTemplateClone(topic, otherCantonArticles);
    if (clone) { skipped.push({ id: topic.id, reason: 'template-clone', detail: clone.id }); continue; }
    if (isPreflightDuplicate(topic)) { skipped.push({ id: topic.id, reason: 'preflight-duplicate' }); continue; }
    const page = await fetchPage(topic.source.url);
    if (!page?.ok) { skipped.push({ id: topic.id, reason: 'source-unreachable', detail: page?.error || `HTTP ${page?.status}` }); continue; }
    const check = verifyTopicOnPage(topic, page.text);
    if (!check.ok) { skipped.push({ id: topic.id, reason: 'facts-unverified', detail: `${check.found.length}/${MIN_VERIFIED_FACTS}` }); continue; }
    return { topic, pageText: page.text, verified: check.found, skipped };
  }
  return null;
}

/**
 * Il SOURCE CONTENT della generazione: intestazione editoriale (formato,
 * angolo, citazioni verificate) + il testo ufficiale della pagina. Le citazioni
 * sono verbatim dalla fonte, quindi il fact-checker le trova nel testo.
 */
export function buildNonNewsSourceContent(topic, pageText, verified) {
  const lines = [
    '[FORMATO NON-NEWS CANTONALE]',
    `Formato: ${topic.format}`,
    `Argomento: ${topic.keyword}`,
    `Angolo editoriale: ${topic.angle}`,
    `Fonte ufficiale: ${topic.source.publisher} — ${topic.source.url}`,
    'Fatti verificati nella fonte (citazioni testuali):',
    ...(verified || []).map((v) => `- ${v}`),
    '',
    'TESTO DELLA PAGINA UFFICIALE:',
    pageText,
  ];
  return lines.join('\n');
}

// ── CLI: `node canton-nonnews.mjs has <sezione>` (come canton-high-cadence) ──

function realPath(p) {
  try { return path.resolve(p); } catch { return p; }
}

if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  const [cmd, section] = process.argv.slice(2);
  if (cmd === 'has' && section) {
    process.exit(isNonNewsSection(section) ? 0 : 1);
  }
  console.error('uso: node canton-nonnews.mjs has <sezione>');
  process.exit(2);
}
