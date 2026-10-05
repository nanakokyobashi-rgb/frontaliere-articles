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
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

/**
 * @returns {string|null} il primo motivo per rifiutare il documento, o null
 */
export function cantonNoticesProblem(payload, { nowMs = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'is not an object';
  if (payload.schemaVersion !== 1) return `schemaVersion is ${JSON.stringify(payload.schemaVersion)}, expected 1`;
  const generated = Date.parse(payload.generatedAt ?? '');
  if (!Number.isFinite(generated)) return 'generatedAt is not a date';
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
    if (typeof n.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(n.url)) return `${where}: url is not an absolute http(s) URL`;
    if (n.publishedAt !== null && !(typeof n.publishedAt === 'string' && (ISO_DAY.test(n.publishedAt) || ISO_TIME.test(n.publishedAt)))) {
      return `${where}: publishedAt ${JSON.stringify(n.publishedAt)} is neither null nor an ISO date`;
    }
    if (typeof n.observedAt !== 'string' || !ISO_TIME.test(n.observedAt)) return `${where}: observedAt is not an ISO timestamp`;
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
  return (payload?.notices ?? [])
    .filter((n) => n.canton === canton && (!category || n.category === category))
    .sort((a, b) => (a.publishedAt === null) - (b.publishedAt === null) || dateKey(b).localeCompare(dateKey(a)))
    .slice(0, limit);
}
