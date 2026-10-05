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
  fuel: Object.freeze({ maxAgeMs: 7 * DAY_MS, minStations: 3, minRows: 1 }),
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

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Millisecondi di un istante ISO con fuso esplicito, o NaN. */
export function instantMs(value) {
  return typeof value === 'string' && ISO_INSTANT_RE.test(value) ? Date.parse(value) : NaN;
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
