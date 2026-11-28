import {
  isHubOutputOnlyRange,
  parseCantonHubRefreshMarker,
} from './publish-gate.mjs';

export const CANTON_HUB_REFRESH_WORKFLOW_NAME = 'Refresh Canton Hubs';
export const CANTON_HUB_REFRESH_WORKFLOW_PATH = '.github/workflows/refresh-canton-hubs.yml';
export const CANTON_HUB_REFRESH_RECEIPT_SCHEMA = 1;

const SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT = /^[1-9][0-9]{0,5}$/u;
const SECTION = /^canton-[a-z]+$/u;

export function cantonHubRefreshArtifactName(runId, runAttempt) {
  if (!RUN_ID.test(String(runId)) || !RUN_ATTEMPT.test(String(runAttempt))) {
    throw new Error('run id/attempt non validi per il proof artifact');
  }
  return `canton-hub-refresh-proof-${runId}-${runAttempt}`;
}

/** Un trailer e' solo un puntatore: questo gate decide se vale la pena leggerne la prova. */
export function resolveCantonHubRefreshReceiptCandidate({
  eventName = '',
  changedPaths = [],
  commitMessage = '',
  publisherSourceCommit = '',
} = {}) {
  if (eventName !== 'workflow_run' || !SHA.test(publisherSourceCommit) ||
      !isHubOutputOnlyRange(changedPaths)) return { candidate: false };
  const marker = parseCantonHubRefreshMarker(commitMessage);
  if (!marker?.sourceVerified) return { candidate: false };
  return {
    candidate: true,
    runId: marker.receiptRunId,
    runAttempt: marker.receiptRunAttempt,
    artifactName: cantonHubRefreshArtifactName(marker.receiptRunId, marker.receiptRunAttempt),
    marker,
  };
}

export function createCantonHubRefreshReceipt({
  repository,
  eventName,
  runId,
  runAttempt,
  sourceCommit,
  hubCommit,
  sections,
  sourceVerified,
} = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(String(repository ?? ''))) throw new Error('repository receipt non valido');
  if (eventName !== 'workflow_run') throw new Error('un receipt verificato richiede workflow_run');
  if (!RUN_ID.test(String(runId)) || !RUN_ATTEMPT.test(String(runAttempt))) throw new Error('run id/attempt receipt non validi');
  if (!SHA.test(String(sourceCommit)) || !SHA.test(String(hubCommit))) throw new Error('commit receipt non validi');
  if (sourceVerified !== true) throw new Error('il proof artifact si crea solo per source verificati');
  if (!Array.isArray(sections) || sections.length === 0 ||
      sections.some((section) => !SECTION.test(section)) || new Set(sections).size !== sections.length) {
    throw new Error('sezioni receipt non valide');
  }

  return {
    schemaVersion: CANTON_HUB_REFRESH_RECEIPT_SCHEMA,
    repository,
    workflowName: CANTON_HUB_REFRESH_WORKFLOW_NAME,
    workflowPath: CANTON_HUB_REFRESH_WORKFLOW_PATH,
    event: eventName,
    runId: String(runId),
    runAttempt: String(runAttempt),
    sourceCommit,
    hubCommit,
    sourceVerified: true,
    sections: [...sections],
  };
}

function sameSections(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

export function isExpectedCantonHubRefreshWorkflowPath(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('@');
  if (parts.length !== 2 || parts[0] !== CANTON_HUB_REFRESH_WORKFLOW_PATH) return false;
  return parts[1] === 'main' || parts[1] === 'refs/heads/main';
}

function metadataMatches(metadata, { repository, runId, runAttempt }) {
  return Boolean(metadata &&
    String(metadata.id ?? '') === String(runId) &&
    String(metadata.run_attempt ?? '') === String(runAttempt) &&
    metadata.name === CANTON_HUB_REFRESH_WORKFLOW_NAME &&
    isExpectedCantonHubRefreshWorkflowPath(metadata.path) &&
    metadata.event === 'workflow_run' &&
    metadata.head_branch === 'main' &&
    metadata.conclusion === 'success' &&
    metadata.repository?.full_name === repository);
}

/**
 * Autentica il puntatore del commit contro artifact immutabile e metadata REST
 * dell'esatto run attempt. Qualunque dato mancante o discordante fallisce chiuso.
 */
export function verifyCantonHubRefreshReceipt({
  receipt,
  runMetadata,
  repository,
  runId,
  runAttempt,
  publisherSourceCommit,
  commitMessage,
  publisherChangedPaths = [],
} = {}) {
  const candidate = resolveCantonHubRefreshReceiptCandidate({
    eventName: 'workflow_run',
    changedPaths: publisherChangedPaths,
    commitMessage,
    publisherSourceCommit,
  });
  if (!candidate.candidate) return { verified: false, reason: 'commit-receipt-pointer-invalid' };
  if (candidate.runId !== String(runId) || candidate.runAttempt !== String(runAttempt)) {
    return { verified: false, reason: 'run-or-attempt-mismatch' };
  }
  if (!metadataMatches(runMetadata, { repository, runId, runAttempt })) {
    return { verified: false, reason: 'github-run-metadata-mismatch' };
  }

  const exactKeys = [
    'schemaVersion', 'repository', 'workflowName', 'workflowPath', 'event',
    'runId', 'runAttempt', 'sourceCommit', 'hubCommit', 'sourceVerified', 'sections',
  ].sort();
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      !sameSections(Object.keys(receipt).sort(), exactKeys)) {
    return { verified: false, reason: 'receipt-shape-invalid' };
  }
  if (receipt.schemaVersion !== CANTON_HUB_REFRESH_RECEIPT_SCHEMA ||
      receipt.repository !== repository ||
      receipt.workflowName !== CANTON_HUB_REFRESH_WORKFLOW_NAME ||
      receipt.workflowPath !== CANTON_HUB_REFRESH_WORKFLOW_PATH ||
      receipt.event !== 'workflow_run' ||
      String(receipt.runId) !== String(runId) ||
      String(receipt.runAttempt) !== String(runAttempt) ||
      receipt.hubCommit !== publisherSourceCommit ||
      receipt.sourceVerified !== true) {
    return { verified: false, reason: 'receipt-run-or-commit-mismatch' };
  }

  const marker = candidate.marker;
  if (receipt.sourceCommit !== marker.sourceCommit ||
      !sameSections(receipt.sections, marker.sections)) {
    return { verified: false, reason: 'receipt-source-or-sections-mismatch' };
  }
  return { verified: true, reason: 'authenticated-run-artifact-and-commit' };
}
