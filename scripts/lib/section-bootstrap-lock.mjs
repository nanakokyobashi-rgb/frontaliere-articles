/**
 * Gate condiviso fra fast-publish-section e publish-api.
 *
 * Un bootstrap di una sezione gia' live deve poter caricare le nuove chiavi
 * HTML mentre il registro API/edge e' ancora sulla release precedente. Il
 * lock su R2 impedisce a publish-section-edge di fare il flip durante quella
 * finestra. Entrambi i workflow contendono lo stesso oggetto con un PUT
 * condizionale: il GET diagnostico non e' il lock e non esiste una finestra
 * GET→PUT in cui due owner possano vincere.
 */

import { fetchWithRefTimeout, releaseFetchWithRefTimeout } from '../../generator/scripts/lib/fetch-with-ref-timeout.mjs';

export const SECTION_BOOTSTRAP_LOCK_PREFIX = 'edge/sections/_bootstrap-locks';
export const SECTION_BOOTSTRAP_LOCK_SCHEMA = 1;
// fast-publish-section.yml può durare al massimo 100m e publish-api 180m.
// Lo stesso lease protegge anche il ruolo edge-publisher, quindi supera il
// protocollo più lungo con 15m di margine: un marker non può scadere mentre
// publish-api sta ancora tra acquire, flip e release dei lease.
export const SECTION_BOOTSTRAP_LOCK_TTL_MS = 195 * 60 * 1000;
export const SECTION_BOOTSTRAP_LOCK_CACHE_CONTROL = 'public,max-age=5';
const SECTION_RE = /^canton-[a-z]+$/;
const SHA_RE = /^[a-f0-9]{7,64}$/;
const LOCK_ROLES = new Set(['bootstrap', 'edge-publisher', 'released']);

export function sectionBootstrapLockKey(section) {
  if (typeof section !== 'string' || !SECTION_RE.test(section)) {
    throw new Error(`sezione non valida per il bootstrap lock: ${section}`);
  }
  return `${SECTION_BOOTSTRAP_LOCK_PREFIX}/${section}.json`;
}

export function sectionBootstrapLockUrl(section, cdnBase = 'https://cdn.frontaliereticino.ch') {
  if (typeof cdnBase !== 'string' || !cdnBase) throw new Error('cdnBase mancante per il bootstrap lock');
  return `${cdnBase.replace(/\/+$/, '')}/${sectionBootstrapLockKey(section)}`;
}

export function bootstrapLockOwner(env = process.env) {
  const repository = String(env.GITHUB_REPOSITORY || 'local').trim();
  const run = String(env.GITHUB_RUN_ID || process.pid).trim();
  const attempt = String(env.GITHUB_RUN_ATTEMPT || '1').trim();
  return `${repository}:${run}:${attempt}`;
}

export function makeSectionBootstrapLock({ section, commit, owner, role = 'bootstrap', now = Date.now(), ttlMs = SECTION_BOOTSTRAP_LOCK_TTL_MS }) {
  sectionBootstrapLockKey(section);
  if (typeof commit !== 'string' || !SHA_RE.test(commit)) throw new Error(`commit non valido per il bootstrap lock: ${commit}`);
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('owner assente per il bootstrap lock');
  if (!LOCK_ROLES.has(role)) throw new Error(`ruolo non valido per il bootstrap lock: ${role}`);
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('durata non valida per il bootstrap lock');
  return {
    schema: SECTION_BOOTSTRAP_LOCK_SCHEMA,
    section,
    role,
    commit,
    owner: owner.trim(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

/** Tombstone scritto con If-Match: libera il lock senza un DELETE non condizionale. */
export function makeReleasedSectionBootstrapLock({ section, commit, owner, now = Date.now() }) {
  return makeSectionBootstrapLock({
    section,
    commit,
    owner,
    role: 'released',
    now: now - 2_000,
    ttlMs: 1,
  });
}

export function parseSectionBootstrapLock(value, { section, now = Date.now() } = {}) {
  let doc = value;
  if (Buffer.isBuffer(doc)) doc = doc.toString('utf8');
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return { state: 'unknown', reason: 'JSON non valido' };
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { state: 'unknown', reason: 'documento non oggetto' };
  if (doc.schema !== SECTION_BOOTSTRAP_LOCK_SCHEMA) return { state: 'unknown', reason: 'schema inatteso' };
  if (section !== undefined && doc.section !== section) return { state: 'unknown', reason: 'sezione diversa' };
  if (typeof doc.section !== 'string' || !SECTION_RE.test(doc.section)) return { state: 'unknown', reason: 'sezione assente o non canonica' };
  if (typeof doc.commit !== 'string' || !SHA_RE.test(doc.commit)) return { state: 'unknown', reason: 'commit assente o non valido' };
  if (typeof doc.owner !== 'string' || !doc.owner.trim()) return { state: 'unknown', reason: 'owner assente' };
  const role = doc.role ?? 'bootstrap';
  if (!LOCK_ROLES.has(role)) return { state: 'unknown', reason: 'ruolo assente o non canonico' };
  const expiresAt = Date.parse(doc.expiresAt);
  const createdAt = Date.parse(doc.createdAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    return { state: 'unknown', reason: 'finestra temporale non valida' };
  }
  if (!Number.isFinite(now)) return { state: 'unknown', reason: 'ora non valida' };
  return { state: expiresAt > now ? 'active' : 'expired', doc: { ...doc, role }, expiresAt };
}

/** Lettura pubblica del marker; 404 = nessun lock, errore di rete = unknown. */
export async function readSectionBootstrapLock(
  section,
  { cdnBase = 'https://cdn.frontaliereticino.ch', fetchImpl = fetch, now = Date.now() } = {},
) {
  const url = `${sectionBootstrapLockUrl(section, cdnBase)}?_sbl=${Date.now()}`;
  try {
    const response = await fetchWithRefTimeout(url, {
      headers: { 'user-agent': 'frontaliere-section-bootstrap-lock/1 (+https://frontaliereticino.ch)' },
    }, 15_000, fetchImpl);
    if (response.status === 404) {
      releaseFetchWithRefTimeout(response);
      return { state: 'absent' };
    }
    if (!response.ok) {
      releaseFetchWithRefTimeout(response);
      return { state: 'unknown', reason: `HTTP ${response.status}` };
    }
    const etag = response.headers.get('etag');
    const body = await response.text();
    return { ...parseSectionBootstrapLock(body, { section, now }), etag: etag || null };
  } catch (error) {
    return { state: 'unknown', reason: error?.message ?? String(error) };
  }
}
