/**
 * blocks-common.mjs — il contratto dei blocchi dati degli hub cantonali.
 *
 * Modello: `lib/daily-brief-data.mjs` e `lib/canton-services-data.mjs`. Ogni
 * dataset di categoria (D11) passa da uno *shaper* che risponde con un blocco
 * disponibile oppure con il motivo per cui NON lo e'. Un blocco assente non
 * rompe la pagina: l'hub resta valido e indicizzabile (D2/D17, nessun
 * `noindex`) e si regge su intro evergreen, altri blocchi, news e strumenti.
 *
 * I codici di omissione sono stabili (finiscono nel file committato); il
 * `reason` e' prosa per il log e NON viene scritto, perche' cambia a ogni run
 * («vecchio di 49 h», «di 50 h») e farebbe cambiare il file senza che cambi
 * il contenuto.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Orologi sfasati fra produttore e runner: oltre, un timestamp futuro e' un guasto. */
export const CLOCK_SKEW_MS = HOUR_MS;

/**
 * - `missing`: la cache non c'e' (dataset non ancora pubblicato o fetch fallito);
 * - `stale`: c'e' ma e' piu' vecchia della soglia del blocco;
 * - `invalid`: c'e' ma non ha la forma attesa;
 * - `empty`: e' valida ma per questo cantone non arriva alla soglia minima;
 * - `not-applicable`: il blocco non esiste per questo cantone (nessun valico).
 */
export const OMIT_CODES = Object.freeze(['missing', 'stale', 'invalid', 'empty', 'not-applicable']);

/**
 * Soglie minime di validita' di ogni blocco: eta' massima dello snapshot e
 * quantita' minima di righe. Sotto soglia il blocco si omette.
 */
export const BLOCK_THRESHOLDS = Object.freeze({
  // Il sito lo riscrive ogni giorno (stessa soglia di refresh-fuel-cantons.mjs).
  fuel: Object.freeze({ maxAgeMs: 7 * DAY_MS, nationalMaxAgeMs: 62 * DAY_MS, minStations: 3, minRows: 1 }),
  // crawl-events gira ogni giorno; tre giorni senza un giro e' un produttore fermo.
  // `maxSpanDays`: un evento ancora in corso entra se dura al piu' cosi'; oltre
  // e' una rassegna permanente o una serie ricorrente annuale, non un appuntamento.
  events: Object.freeze({ maxAgeMs: 3 * DAY_MS, windowDays: 14, maxSpanDays: 31, minRows: 3, maxRows: 10 }),
  // La finestra e' settimanale (stessa soglia di refresh-border-wait-window.mjs).
  borderWait: Object.freeze({ maxAgeMs: 14 * DAY_MS, minRows: 2, maxRows: 8 }),
  // collect-road-events gira ogni tre ore (stessa soglia di refresh-road-events.mjs).
  roadEvents: Object.freeze({ maxAgeMs: 48 * HOUR_MS, horizonDays: 14, minRows: 1, maxRows: 8 }),
  // crawl-canton-notices gira tre volte al giorno (MAX_AGE_DAYS di canton-notices-data.mjs).
  notices: Object.freeze({ maxAgeMs: 4 * DAY_MS, maxItemAgeDays: 120, minRows: 1, maxRows: 6 }),
  // La vista dei servizi e' ricostruita a ogni run del workflow degli hub.
  services: Object.freeze({ maxAgeMs: 48 * HOUR_MS }),
  // Dataset annuali: valido l'anno in corso o il precedente (come i loro refresh).
  tax: Object.freeze({ maxYearLag: 1 }),
  pensions: Object.freeze({ maxYearLag: 1 }),
});

export function omitted(id, code, reason) {
  if (!OMIT_CODES.includes(code)) throw new Error(`canton-hubs: codice di omissione sconosciuto "${code}"`);
  return { id, available: false, code, reason };
}

export const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
export const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Il giorno esiste nel calendario? (`Date` normalizzerebbe il 31 febbraio al 3 marzo.) */
function realCalendarDay(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** `YYYY-MM-DD` di un giorno che esiste davvero. */
export function isRealDay(value) {
  const m = typeof value === 'string' ? ISO_DAY_RE.exec(value) : null;
  return Boolean(m) && realCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Millisecondi di un istante ISO con fuso esplicito, o NaN. La forma non
 * basta: `Date.parse` accetta e normalizza date impossibili
 * (`2026-02-31T12:00:00Z`), che finirebbero come `updatedAt` negli hub
 * pubblicati. Giorno, ora, minuti, secondi e offset si controllano uno per uno.
 */
export function instantMs(value) {
  const m = typeof value === 'string' ? ISO_INSTANT_RE.exec(value) : null;
  if (!m) return NaN;
  const [, y, mo, d, h, mi, sec = '0', offset] = m;
  if (!realCalendarDay(Number(y), Number(mo), Number(d))) return NaN;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return NaN;
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59)) return NaN;
  return Date.parse(value);
}

/** Millisecondi di una data valida — giorno `YYYY-MM-DD` (a mezzanotte UTC) o istante ISO — o NaN. */
export function dateMs(value) {
  if (isRealDay(value)) return Date.parse(`${value}T00:00:00Z`);
  return instantMs(value);
}

/**
 * Lo snapshot e' usabile? `null` se si', altrimenti `{ code, reason }`.
 * @param {string} iso istante dello snapshot
 * @param {number} nowMs
 * @param {number} maxAgeMs
 * @param {string} what nome del dataset per il log
 */
export function freshnessProblem(iso, nowMs, maxAgeMs, what) {
  const at = instantMs(iso);
  if (!Number.isFinite(at)) return { code: 'invalid', reason: `${what}: istante dello snapshot non leggibile (${JSON.stringify(iso)})` };
  const age = nowMs - at;
  if (age < -CLOCK_SKEW_MS) return { code: 'invalid', reason: `${what}: snapshot datato nel futuro (${iso})` };
  if (age > maxAgeMs) return { code: 'stale', reason: `${what}: snapshot vecchio di ${Math.round(age / HOUR_MS)} h (max ${Math.round(maxAgeMs / HOUR_MS)} h)` };
  return null;
}

/** I codici BFS dei membri di un gruppo URL (APPENZELLO → AI, AR). */
export function inGroup(members, code) {
  return members.includes(String(code ?? '').toUpperCase());
}
