/**
 * Event records of private sources (Eventfrog Public API) must never enter
 * this repository.
 *
 * The site publishes Eventfrog events only as ephemeral pages built from a
 * private snapshot (owner decision D5 of 2026-10-05, Eventfrog AGB v1.28 §17):
 * the terms forbid handing the data to third parties (§17(3)) and using it for
 * anything but the event's own announcement (§17(6)) — a weekend digest
 * article is exactly such another use. The site already keeps these records
 * out of the public `events.json` this repo fetches; this is the second line
 * of defense at the only door through which the dataset enters the corpus
 * (refresh-events-dataset.mjs), so the digest can never read one.
 *
 * Same predicate as the site's `scripts/lib/private-event-sources.mjs`,
 * duplicated on purpose: the boundary between the two repositories is HTTP,
 * never an import.
 */

export const PRIVATE_EVENT_SOURCE_KEYS = Object.freeze(['eventfrog']);

/** Whether a record comes from a private source (source key, id prefix or ephemeral marker). */
export function isPrivateEventRecord(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.ephemeral === true) return true;
  const sourceKey = typeof event.sourceKey === 'string' ? event.sourceKey.trim().toLowerCase() : '';
  if (PRIVATE_EVENT_SOURCE_KEYS.includes(sourceKey)) return true;
  const id = typeof event.id === 'string' ? event.id.trim().toLowerCase() : '';
  return PRIVATE_EVENT_SOURCE_KEYS.some((key) => id.startsWith(`${key}:`));
}

/**
 * The dataset payload without private records, plus how many were removed.
 * The payload object is not mutated.
 *
 * @param {{ events?: unknown[] } & Record<string, unknown>} payload
 * @returns {{ payload: Record<string, unknown>, removed: number }}
 */
export function stripPrivateEventRecords(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const kept = events.filter((event) => !isPrivateEventRecord(event));
  const removed = events.length - kept.length;
  if (removed === 0) return { payload, removed };
  const next = { ...payload, events: kept };
  if (typeof payload.totalEvents === 'number') next.totalEvents = kept.length;
  return { payload: next, removed };
}
