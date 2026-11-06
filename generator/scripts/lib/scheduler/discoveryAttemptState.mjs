// Persisted recovery state for the proven/discovery scheduler.
//
// The publication quota counter advances only after a successful article.
// Keep separate monotonic counters so repeated proven failures cannot starve
// discovery, while preserving the publication counter's existing meaning.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DISCOVERY_ATTEMPT_STATE_PATH = 'data/discovery-attempt-state.json';
export const DISCOVERY_RECOVERY_THRESHOLD = 3;
export const DISCOVERY_ATTEMPT_COUNTER_FIELDS = Object.freeze([
  'frontaliereProvenAttempts',
  'frontaliereDiscoveryResetAt',
  'svizzeraProvenAttempts',
  'svizzeraDiscoveryResetAt',
]);

const SECTIONS = Object.freeze(['frontaliere', 'svizzera']);

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function counterFields(section) {
  if (!SECTIONS.includes(section)) return null;
  return {
    proven: `${section}ProvenAttempts`,
    resetAt: `${section}DiscoveryResetAt`,
  };
}

function defaultState() {
  return {
    version: 1,
    frontaliereProvenAttempts: 0,
    frontaliereDiscoveryResetAt: 0,
    svizzeraProvenAttempts: 0,
    svizzeraDiscoveryResetAt: 0,
  };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const normalized = {
    version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : base.version,
  };
  for (const section of SECTIONS) {
    const fields = counterFields(section);
    const provenAttempts = counter(raw[fields.proven]);
    normalized[fields.proven] = provenAttempts;
    // A reset watermark can never refer to a future proven attempt.
    normalized[fields.resetAt] = Math.min(counter(raw[fields.resetAt]), provenAttempts);
  }
  return normalized;
}

/** Load monotonic recovery counters. Missing or corrupt state degrades to zero. */
export function loadDiscoveryAttemptState({ path = DISCOVERY_ATTEMPT_STATE_PATH } = {}) {
  try {
    if (!existsSync(path)) return defaultState();
    return normalizeState(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return defaultState();
  }
}

/** Persist recovery counters atomically; a telemetry failure never blocks generation. */
export function saveDiscoveryAttemptState(state, { path = DISCOVERY_ATTEMPT_STATE_PATH } = {}) {
  const normalized = normalizeState(state);
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    renameSync(tempPath, path);
    return true;
  } catch (err) {
    try {
      writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      try { unlinkSync(tempPath); } catch {}
      return true;
    } catch (fallbackErr) {
      try { unlinkSync(tempPath); } catch {}
      console.warn(
        `[discovery-attempt] could not write ${path}: ${err?.message || err}`
        + `; direct-write fallback failed: ${fallbackErr?.message || fallbackErr}`,
      );
    }
    return false;
  }
}

/** Return the section's outstanding proven failures and whether recovery is due. */
export function discoveryRecoveryDecision(state, {
  section,
  threshold = DISCOVERY_RECOVERY_THRESHOLD,
} = {}) {
  const safe = normalizeState(state);
  const fields = counterFields(section);
  const safeThreshold = Number.isSafeInteger(threshold) && threshold > 0
    ? threshold
    : DISCOVERY_RECOVERY_THRESHOLD;
  if (!fields) {
    return {
      section: typeof section === 'string' ? section : null,
      provenAttempts: 0,
      discoveryResetAt: 0,
      outstandingProvenFailures: 0,
      threshold: safeThreshold,
      shouldForceDiscovery: false,
    };
  }
  const provenAttempts = safe[fields.proven];
  const discoveryResetAt = safe[fields.resetAt];
  const outstandingProvenFailures = Math.max(0, provenAttempts - discoveryResetAt);
  return {
    section,
    provenAttempts,
    discoveryResetAt,
    outstandingProvenFailures,
    threshold: safeThreshold,
    shouldForceDiscovery: outstandingProvenFailures >= safeThreshold,
  };
}

/**
 * Record one terminal pool attempt without decreasing any persisted counter.
 * Only a candidate-level attempt consumes recovery debt. A discovery candidate
 * attempt or successful publication of a selected candidate advances the reset watermark.
 */
export function recordDiscoveryAttempt(state, {
  section,
  poolKind,
  generated = false,
  candidateAttempted = false,
} = {}) {
  const safe = normalizeState(state);
  const fields = counterFields(section);
  if (!fields || !['proven', 'discovery'].includes(poolKind) || candidateAttempted !== true) return safe;

  const next = { ...safe };
  if (poolKind === 'proven') {
    next[fields.proven] = safe[fields.proven] + 1;
    if (generated) next[fields.resetAt] = next[fields.proven];
  } else {
    next[fields.resetAt] = safe[fields.proven];
  }
  return normalizeState(next);
}
