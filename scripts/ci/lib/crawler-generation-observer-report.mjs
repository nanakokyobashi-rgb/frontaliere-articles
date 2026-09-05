import { digestDocument } from './canonical-json-digest.mjs';
import { isCrawlerGenerationToken } from './crawler-generation-token.mjs';

export const CRAWLER_GENERATION_OBSERVER_REPORT_SCHEMA_VERSION = 2;
export const ARTIFACT_MISSING_GRACE_MS = 6 * 60 * 60 * 1_000;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const STATUS_SET = new Set(['ready', 'blocked', 'waiting', 'infrastructure_error']);
const GROUP_IDS = Object.freeze(Array.from(
  { length: 23 },
  (_, index) => String(index + 1).padStart(2, '0'),
));
const DISPATCH_STATUS_SET = new Set([
  'direct', 'reconciled_transport_error', 'reconciled_protocol_mismatch', 'rejected',
  'missing', 'duplicate', 'invalid_200_response', 'binding_mismatch',
  'duplicate_run_id', 'api_protocol_mismatch',
]);
const ACCEPTED_DISPATCH_STATUS_SET = new Set(['direct', 'reconciled_transport_error']);
const NULL_DISPATCH_RUN_ID_STATUS_SET = new Set([
  'rejected', 'missing', 'duplicate', 'invalid_200_response', 'duplicate_run_id',
  'api_protocol_mismatch',
]);
const REASON_SET = new Set([
  'artifact_ambiguous', 'artifact_archive_invalid', 'artifact_binding_invalid',
  'artifact_cycle_too_large', 'artifact_expired', 'artifact_list_invalid',
  'artifact_missing', 'artifact_too_large', 'blocked_dispatch_missing',
  'blocked_group_cancelled', 'blocked_group_failed', 'blocked_group_timed_out',
  'blocked_manifest_invalid', 'blocked_manifest_missing', 'blocked_timeout',
  'caller_runs_incomplete', 'github_api_failed', 'github_api_invalid',
  'github_response_too_large', 'observer_checkout_mismatch', 'observer_internal_error',
  'observer_timeout', 'roster_invalid', 'run_binding_invalid', 'sentinel_artifact_invalid',
  'sentinel_conflict', 'sentinel_invalid', 'sentinel_missing', 'sentinel_replay_ambiguous',
  'sentinel_replay_invalid', 'sentinel_replay_overflow', 'sentinel_run_invalid',
  'source_fetch_failed', 'source_history_check_failed', 'source_history_incomparable',
  'source_history_rewritten', 'source_snapshot_failed', 'source_tree_invalid',
  'terminal_manifest_set_invalid', 'waiting',
]);
/**
 * Il documento `barrier` prodotto da `evaluateCrawlerGenerationBarrier()` sul
 * sito. Qui viaggia come sotto-documento del report, ed e' l'unico dei tre
 * documenti digestati della catena (sentinel, report, barrier) che nessuno
 * ri-verificava: `barrier` era accettato per il solo fatto di non essere
 * `null`. Il suo `digest` si auto-certifica e il suo `cycleId` E' il
 * `generationToken` (il sito lo costruisce con `cycleId: sentinel.generationToken`),
 * quindi il legame col token esisteva gia' in produzione — mancava solo la
 * verifica in lettura, che e' il lato che conta: il report arriva da un
 * artifact scaricato, non da questa memoria.
 */
const BARRIER_KEYS = [
  'schemaVersion', 'cycleId', 'expectedGroups', 'groups', 'barrier', 'translation', 'digest',
];
const BARRIER_GROUP_KEYS = [
  'state', 'callerRepository', 'callerRunId', 'status', 'conclusion',
  'manifestDigest', 'remoteCommit', 'reasons',
];
// Gli stati non-`ready` che il sito puo' assegnare alla barriera. Il produttore
// li travasa tali e quali in `observer.reasons`, quindi sono anche un
// sottoinsieme di `REASON_SET`: il legame non e' importabile fra i due repo ed
// e' coperto da un test (AGENTS.md #6).
const BARRIER_BLOCKING_STATUS_SET = new Set([
  'blocked_dispatch_missing', 'blocked_group_cancelled', 'blocked_group_failed',
  'blocked_group_timed_out', 'blocked_manifest_invalid', 'blocked_manifest_missing',
  'blocked_timeout', 'waiting',
]);
const BARRIER_STATUS_SET = new Set(['ready', ...BARRIER_BLOCKING_STATUS_SET]);

const REPORT_KEYS = [
  'schemaVersion',
  'evaluatedAt',
  'generationToken',
  'siteCodeCommit',
  'corpusCodeCommit',
  'sentinelDigest',
  'sentinelSetDigest',
  'sentinelReplayCount',
  'dispatchDiagnostics',
  'evidenceDigest',
  'observer',
  'barrier',
  'translation',
  'digest',
];

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort(compareCodePoint))
      === JSON.stringify([...keys].sort(compareCodePoint));
}

function withoutDigest(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest'));
}

function validDispatchDiagnostics(value) {
  if (!exactKeys(value, GROUP_IDS)) return false;
  return GROUP_IDS.every((group) => {
    const diagnostic = value[group];
    if (!exactKeys(diagnostic, ['status', 'runId'])
        || !DISPATCH_STATUS_SET.has(diagnostic.status)
        || (diagnostic.runId !== null && !/^[1-9][0-9]*$/.test(diagnostic.runId))) return false;
    if (ACCEPTED_DISPATCH_STATUS_SET.has(diagnostic.status)) return diagnostic.runId !== null;
    if (NULL_DISPATCH_RUN_ID_STATUS_SET.has(diagnostic.status)) return diagnostic.runId === null;
    return true;
  });
}

/**
 * Verifica che la barriera sia un documento valido E che appartenga a QUESTA
 * generazione. Senza il confronto `cycleId` ↔ `generationToken` una barriera
 * legittima di un'altra generazione passava: il digest del report copre la
 * barriera, ma prova solo che il report e' coerente con se stesso, non che la
 * barriera sia quella giusta.
 */
function validBarrierDocument(barrier, report) {
  if (!exactKeys(barrier, BARRIER_KEYS)
      || barrier.schemaVersion !== 1
      || barrier.expectedGroups !== GROUP_IDS.length
      || barrier.cycleId !== report.generationToken
      || !exactKeys(barrier.groups, GROUP_IDS)) return false;
  const groupsBound = GROUP_IDS.every((group) => {
    const entry = barrier.groups[group];
    return exactKeys(entry, BARRIER_GROUP_KEYS)
      && BARRIER_STATUS_SET.has(entry.state)
      && Array.isArray(entry.reasons);
  });
  if (!groupsBound) return false;
  const inner = barrier.barrier;
  if (!exactKeys(inner, ['status', 'readyAt', 'sourceCommit'])
      || !BARRIER_STATUS_SET.has(inner.status)) return false;
  const ready = inner.status === 'ready';
  // `ready` implica una fonte valida: sul sito `accepted && !sourceCommitValid`
  // degrada il gruppo, quindi una barriera `ready` senza `sourceCommit` non e'
  // producibile e va rifiutata.
  if (ready
    ? (!Number.isFinite(Date.parse(inner.readyAt ?? '')) || !COMMIT_RE.test(inner.sourceCommit ?? ''))
    : inner.readyAt !== null) return false;
  if (inner.sourceCommit !== null && !COMMIT_RE.test(inner.sourceCommit ?? '')) return false;
  // La `translation` di primo livello e' COPIATA dalla barriera al momento
  // della creazione e poi non piu' riletta: un report puo' quindi dichiarare
  // `wouldDispatch` diverso da quello che la barriera giustifica.
  if (!exactKeys(barrier.translation, ['mode', 'wouldDispatch', 'dispatched'])
      || barrier.translation.mode !== 'shadow'
      || barrier.translation.dispatched !== false
      || barrier.translation.wouldDispatch !== ready
      || barrier.translation.wouldDispatch !== report.translation?.wouldDispatch) return false;
  return HASH_RE.test(barrier.digest ?? '')
    && barrier.digest === digestDocument(withoutDigest(barrier));
}

/** Lo stato che il sito deriva dalla barriera, da confrontare con quello dichiarato. */
function observerStatusForBarrier(status) {
  if (status === 'ready') return 'ready';
  return status === 'waiting' ? 'waiting' : 'blocked';
}

export function createSentinelSetBinding(sentinels) {
  if (!Array.isArray(sentinels) || sentinels.length > 100) {
    throw new TypeError('invalid_sentinel_set');
  }
  const sentinelDigests = sentinels.map((sentinel) => (
    HASH_RE.test(sentinel?.digest ?? '') ? sentinel.digest : digestDocument(sentinel)
  )).sort(compareCodePoint);
  return {
    sentinelSetDigest: digestDocument({ schemaVersion: 1, sentinelDigests }),
    sentinelReplayCount: sentinelDigests.length,
  };
}

export function createCrawlerGenerationObserverReport({
  evaluatedAt,
  generationToken = null,
  siteCodeCommit = null,
  corpusCodeCommit = null,
  sentinelDigest = null,
  sentinelSetDigest = null,
  sentinelReplayCount = null,
  dispatchDiagnostics = null,
  evidenceDigest = null,
  status,
  reasons,
  barrier,
}) {
  const payload = {
    schemaVersion: CRAWLER_GENERATION_OBSERVER_REPORT_SCHEMA_VERSION,
    evaluatedAt,
    generationToken,
    siteCodeCommit,
    corpusCodeCommit,
    sentinelDigest,
    sentinelSetDigest,
    sentinelReplayCount,
    dispatchDiagnostics,
    evidenceDigest,
    observer: {
      status,
      reasons: [...new Set(reasons)].sort(compareCodePoint),
    },
    barrier: barrier ?? null,
    translation: barrier?.translation
      ?? { mode: 'shadow', wouldDispatch: false, dispatched: false },
  };
  return { ...payload, digest: digestDocument(payload) };
}

export function validateCrawlerGenerationObserverReport(report, expected = null) {
  const errors = [];
  if (!exactKeys(report, REPORT_KEYS)) return { valid: false, errors: ['unsupported_schema'] };
  if (report.schemaVersion !== CRAWLER_GENERATION_OBSERVER_REPORT_SCHEMA_VERSION) {
    errors.push('unsupported_schema_version');
  }
  if (!Number.isFinite(Date.parse(report.evaluatedAt ?? ''))) errors.push('invalid_evaluated_at');
  if (report.generationToken !== null && !isCrawlerGenerationToken(report.generationToken)) {
    errors.push('invalid_generation_token');
  }
  if (report.siteCodeCommit !== null && !COMMIT_RE.test(report.siteCodeCommit ?? '')) {
    errors.push('invalid_site_code_commit');
  }
  if (report.corpusCodeCommit !== null && !COMMIT_RE.test(report.corpusCodeCommit ?? '')) {
    errors.push('invalid_corpus_code_commit');
  }
  if (report.sentinelDigest !== null && !HASH_RE.test(report.sentinelDigest ?? '')) {
    errors.push('invalid_sentinel_digest');
  }
  if (report.sentinelSetDigest !== null && !HASH_RE.test(report.sentinelSetDigest ?? '')) {
    errors.push('invalid_sentinel_set_digest');
  }
  if (report.sentinelReplayCount !== null
      && (!Number.isInteger(report.sentinelReplayCount)
        || report.sentinelReplayCount < 0 || report.sentinelReplayCount > 100)) {
    errors.push('invalid_sentinel_replay_count');
  }
  if (report.evidenceDigest !== null && !HASH_RE.test(report.evidenceDigest ?? '')) {
    errors.push('invalid_evidence_digest');
  }
  if (!exactKeys(report.observer, ['status', 'reasons'])
      || !STATUS_SET.has(report.observer?.status)
      || !Array.isArray(report.observer?.reasons)
      || report.observer.reasons.some((reason) => !REASON_SET.has(reason))
      || new Set(report.observer.reasons).size !== report.observer.reasons.length) {
    errors.push('invalid_observer_status');
  }
  if (report.observer?.status === 'ready'
      ? report.observer?.reasons?.length !== 0
      : report.observer?.reasons?.length < 1) {
    errors.push('invalid_observer_reasons');
  }
  if (report.dispatchDiagnostics !== null && !validDispatchDiagnostics(report.dispatchDiagnostics)) {
    errors.push('invalid_dispatch_diagnostics');
  }
  if (['ready', 'blocked'].includes(report.observer?.status)
      && !validDispatchDiagnostics(report.dispatchDiagnostics)) {
    errors.push('missing_terminal_dispatch_diagnostics');
  }
  if (!exactKeys(report.translation, ['mode', 'wouldDispatch', 'dispatched'])
      || report.translation?.mode !== 'shadow'
      || typeof report.translation?.wouldDispatch !== 'boolean'
      || report.translation?.dispatched !== false) {
    errors.push('invalid_translation_shadow');
  }
  if (report.observer?.status === 'ready'
      && (report.barrier === null || report.translation?.wouldDispatch !== true)) {
    errors.push('invalid_ready_report');
  }
  if (report.observer?.status !== 'ready' && report.translation?.wouldDispatch !== false) {
    errors.push('invalid_nonready_report');
  }
  if (report.barrier !== null) {
    if (!validBarrierDocument(report.barrier, report)) {
      errors.push('invalid_barrier');
    } else {
      if (report.observer?.status !== observerStatusForBarrier(report.barrier.barrier.status)) {
        errors.push('barrier_status_mismatch');
      }
      if (report.barrier.barrier.status !== 'ready'
          && !report.observer?.reasons?.includes(report.barrier.barrier.status)) {
        errors.push('barrier_reason_missing');
      }
    }
  }
  if (!HASH_RE.test(report.digest ?? '') || report.digest !== digestDocument(withoutDigest(report))) {
    errors.push('invalid_report_digest');
  }
  if (expected !== null) {
    if (report.generationToken !== expected.generationToken
        || report.siteCodeCommit !== expected.siteCodeCommit
        || report.corpusCodeCommit !== expected.corpusCodeCommit
        || report.sentinelDigest !== expected.sentinelDigest
        || report.sentinelSetDigest !== expected.sentinelSetDigest
        || report.sentinelReplayCount !== expected.sentinelReplayCount) {
      errors.push('sentinel_set_mismatch');
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)].sort(compareCodePoint) };
}

export function classifyCrawlerGenerationObserverReport(report, {
  expected,
  now,
  sentinelCreatedAt,
}) {
  if (!validateCrawlerGenerationObserverReport(report).valid) {
    return { terminal: false, reason: 'report_malformed' };
  }
  if (!validateCrawlerGenerationObserverReport(report, expected).valid) {
    return { terminal: false, reason: 'report_stale' };
  }
  if (report.observer.status === 'ready') return { terminal: true, reason: 'ready' };
  if (report.observer.status !== 'blocked') {
    return { terminal: false, reason: report.observer.status };
  }
  if (report.observer.reasons.includes('artifact_missing')) {
    const createdAt = typeof sentinelCreatedAt === 'number'
      ? sentinelCreatedAt
      : Date.parse(sentinelCreatedAt ?? '');
    if (!Number.isFinite(now) || !Number.isFinite(createdAt)
        || now - createdAt < ARTIFACT_MISSING_GRACE_MS) {
      return { terminal: false, reason: 'artifact_missing_grace' };
    }
    return { terminal: true, reason: 'artifact_missing' };
  }
  return { terminal: true, reason: report.observer.reasons[0] ?? 'blocked' };
}
