/**
 * canton-notices-data.mjs — contratto e letture del dataset
 * `canton-notices.json` (avvisi ufficiali cantonali, D11/P9g).
 *
 * Il produttore e' il SITO (`scripts/crawl-canton-notices.mjs`, workflow
 * `crawl-canton-notices.yml`, tre giri al giorno): legge le fonti istituzionali
 * lente del profilo `generator/data/canton-sections.json` e pubblica solo
 * metadati — canton, category, title, url, publishedAt, source, observedAt.
 * Questo modulo e' il lato consumatore: la validazione che
 * `refresh-canton-notices.mjs` applica prima di mettere in cache, e le letture
 * che useranno gli hub (P10). Nessun I/O.
 */

/** I 24 gruppi URL delle sezioni cantonali (`canton-url-slugs.json` → `cantons`). */
export const CANTON_GROUP_CODES = Object.freeze([
  'AG', 'APPENZELLO', 'BE', 'BASILEA', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW',
  'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
]);

/** Le categorie degli hub (D2). */
export const NOTICE_CATEGORIES = Object.freeze(['fisco', 'pensioni', 'mobilita', 'servizi', 'eventi', 'carburanti']);

/** Avvisi minimi per considerare il documento un dataset e non un troncamento (misurati ~1.000-1.500). */
export const MIN_NOTICES = 200;
/** Gruppi cantonali minimi con almeno un avviso (misurati 23-24 su 24). */
export const MIN_CANTONS = 15;
/** Il crawler gira tre volte al giorno: quattro giorni senza un giro nuovo e' un produttore fermo. */
export const MAX_AGE_DAYS = 4;

const ISO_DAY = /^\d{4}-\d\d-\d\d$/;

/** Giorno di calendario esistente (2026-02-31 no). */
function isRealDay(value) {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** Istante ISO UTC esistente: la forma non basta (2026-10-05T99:99:99Z). */
function isRealInstant(value) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return false;
  // il round-trip scarta ore/minuti fuori scala che qualche motore normalizza
  return new Date(t).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** `https:///path` passerebbe una regex: si chiede a URL un protocollo http(s) e un host. */
function isAbsoluteHttpUrl(value) {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0 && /^https?:\/\/[^/]/.test(value);
  } catch {
    return false;
  }
}
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

/**
 * @returns {string|null} il primo motivo per rifiutare il documento, o null
 */
export function cantonNoticesProblem(payload, { nowMs = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'is not an object';
  if (payload.schemaVersion !== 1) return `schemaVersion is ${JSON.stringify(payload.schemaVersion)}, expected 1`;
  const generated = Date.parse(payload.generatedAt ?? '');
  if (!Number.isFinite(generated)) return 'generatedAt is not a date';
  // Un generatedAt nel futuro (oltre dieci minuti di orologio sfasato) non e'
  // fresco: e' un orologio sbagliato, e il gate di eta' non lo vedrebbe mai.
  if (generated - nowMs > 10 * 60_000) return `generatedAt ${payload.generatedAt} is in the future`;
  const ageDays = (nowMs - generated) / 86_400_000;
  if (ageDays > MAX_AGE_DAYS) return `generatedAt is ${ageDays.toFixed(1)} days old (max ${MAX_AGE_DAYS}) — the notices crawler stopped`;
  if (!Array.isArray(payload.notices)) return 'has no notices[] array';
  if (payload.notices.length < MIN_NOTICES) return `carries ${payload.notices.length} notices (min ${MIN_NOTICES})`;
  const cantons = new Set();
  const ids = new Set();
  for (const n of payload.notices) {
    const where = `notice ${JSON.stringify(n?.id ?? n?.url ?? n)}`.slice(0, 120);
    if (!n || typeof n !== 'object') return `${where} is not an object`;
    if (typeof n.id !== 'string' || !/^[0-9a-f]{16}$/.test(n.id)) return `${where}: id is not a 16-hex id`;
    if (ids.has(n.id)) return `${where}: duplicate id`;
    ids.add(n.id);
    if (!CANTON_GROUP_CODES.includes(n.canton)) return `${where}: canton ${JSON.stringify(n.canton)} is not a URL group`;
    if (!NOTICE_CATEGORIES.includes(n.category)) return `${where}: category ${JSON.stringify(n.category)} is not a hub category`;
    if (typeof n.title !== 'string' || n.title.length < 8 || n.title.length > 240) return `${where}: title is not an 8-240 char string`;
    if (!isAbsoluteHttpUrl(n.url)) return `${where}: url is not an absolute http(s) URL with a host`;
    if (n.publishedAt !== null && !(isRealDay(n.publishedAt) || isRealInstant(n.publishedAt))) {
      return `${where}: publishedAt ${JSON.stringify(n.publishedAt)} is neither null nor an ISO date`;
    }
    if (!isRealInstant(n.observedAt)) return `${where}: observedAt is not an ISO timestamp`;
    if (typeof n.source !== 'string' || !n.source) return `${where}: source is missing`;
    cantons.add(n.canton);
  }
  if (cantons.size < MIN_CANTONS) return `covers ${cantons.size} canton groups (min ${MIN_CANTONS})`;
  return null;
}

const dateKey = (n) => String(n.publishedAt ?? '');

/**
 * Gli avvisi di un cantone (e opzionalmente di una categoria), dal piu'
 * recente; quelli senza data in coda. E' la lettura che faranno gli hub.
 */
export function noticesFor(payload, canton, { category = null, limit = 10 } = {}) {
  // null/undefined/non numerico = tetto di default, non zero
  const n = limit == null || limit === '' ? NaN : Number(limit);
  const max = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 10;
  return (payload?.notices ?? [])
    .filter((n) => n.canton === canton && (!category || n.category === category))
    .sort((a, b) => (a.publishedAt === null) - (b.publishedAt === null) || dateKey(b).localeCompare(dateKey(a)))
    .slice(0, max);
}
