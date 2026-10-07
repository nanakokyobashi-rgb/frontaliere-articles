/**
 * Identità e attestazione di una PR prodotta dal workflow di trasporto dei
 * gemelli `identical`.
 *
 * Il branch è solo una parte dell'identità: il canale è riconosciuto soltanto
 * quando autore, repository/head, manifest e insieme dei file corrispondono
 * tutti al prodotto di `transport-identical-twins.yml`.
 */

export const TRANSPORT_MANIFEST_PATH = 'scripts/ci/loop-sync-manifest.json';
export const TRANSPORT_WORKFLOW_AUTHOR = 'nanakokyobashi-rgb';
export const TRANSPORT_BRANCH_RE = /^transport\/identical-twins-\d+$/u;
export const TRANSPORT_EXCEPTION_PHRASE =
  'merge consentito dalla decisione del proprietario del 2026-10-07 (issue 2400): i rilievi sui gemelli identical trasportati non bloccano il trasporto';
export const TRANSPORT_ROUTING_MARKER = 'IDENTICAL_REVIEW_ROUTING';
export const TRANSPORT_ROUTING_EVIDENCE_MARKER = 'IDENTICAL_REVIEW_ROUTING_EVIDENCE';

const HEX_SHA_RE = /^[0-9a-f]{40}$/iu;

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^\/+/u, '');
}

function pathFromFile(file) {
  if (typeof file === 'string') return normalizePath(file);
  return normalizePath(file?.filename || file?.path || '');
}

function loginFromPr(pr) {
  return String(pr?.author?.login || pr?.user?.login || '').trim();
}

function branchFromPr(pr) {
  return String(pr?.headRefName || pr?.head?.ref || '').trim();
}

function baseFromPr(pr) {
  return String(pr?.baseRefName || pr?.base?.ref || '').trim();
}

function headRepositoryFromPr(pr) {
  return String(
    pr?.headRepository?.nameWithOwner
      || pr?.head?.repo?.full_name
      || pr?.headRepositoryFullName
      || '',
  ).trim();
}

function uniquePaths(files) {
  return [...new Set((Array.isArray(files) ? files : []).map(pathFromFile).filter(Boolean))].sort();
}

function identicalManifestPaths(manifest) {
  return new Set((manifest?.files || [])
    .filter((entry) => entry?.mode === 'identical' && typeof entry.path === 'string')
    .map((entry) => normalizePath(entry.path))
    .filter(Boolean));
}

/**
 * Unico predicato del prodotto PR `transport-identical-twins.yml`.
 *
 * `filesComplete` deve essere false quando l'API non ha dimostrato di aver
 * restituito l'elenco completo: una lista parziale non può autorizzare
 * l'eccezione del gate.
 */
export function transportPrDisposition({
  pr,
  repository = '',
  files,
  filesComplete = true,
  manifest,
} = {}) {
  const changedFiles = uniquePaths(files);
  const identical = identicalManifestPaths(manifest);
  const allowed = new Set([...identical, TRANSPORT_MANIFEST_PATH]);
  const author = loginFromPr(pr);
  const branch = branchFromPr(pr);
  const base = baseFromPr(pr);
  const headRepository = headRepositoryFromPr(pr);
  const failures = [];
  const transportedFiles = changedFiles
    .filter((file) => file !== TRANSPORT_MANIFEST_PATH && identical.has(file));

  if (!filesComplete) failures.push('elenco file della PR non completo');
  if (author !== TRANSPORT_WORKFLOW_AUTHOR) failures.push(`autore non è ${TRANSPORT_WORKFLOW_AUTHOR}`);
  if (!TRANSPORT_BRANCH_RE.test(branch)) failures.push('branch non prodotto dal workflow di trasporto');
  if (base !== 'main') failures.push('base diversa da main');
  if (repository && headRepository !== repository) {
    failures.push('repository head diversa dal corpus');
  }
  if (!changedFiles.includes(TRANSPORT_MANIFEST_PATH)) {
    failures.push('manifest del ciclo non modificato');
  }
  if (identical.size === 0) failures.push('manifest senza gemelli identical ammessi');
  if (transportedFiles.length === 0) failures.push('nessun gemello identical trasportato');

  const disallowedFiles = changedFiles.filter((file) => !allowed.has(file));
  if (disallowedFiles.length > 0) {
    failures.push(`file fuori dall'insieme ammesso: ${disallowedFiles.join(', ')}`);
  }

  return {
    transport: failures.length === 0,
    reason: failures.length === 0
      ? 'PR prodotta dal workflow transport-identical-twins'
      : failures.join('; '),
    author,
    branch,
    changedFiles,
    transportedFiles,
    disallowedFiles,
    manifestPath: TRANSPORT_MANIFEST_PATH,
  };
}

export function isIdenticalTwinTransportPr(options = {}) {
  return transportPrDisposition(options);
}

function routingKey(routed) {
  return [...new Set((routed || []).map((item) => `${item.sitePath}:${item.findingId}`))]
    .sort()
    .join('|');
}

function headMarkerValue(headSha) {
  return HEX_SHA_RE.test(String(headSha || '')) ? String(headSha) : 'unknown';
}

export function identicalRoutingCommentMarker({ routed = [], headSha = '' } = {}) {
  return `<!-- ${TRANSPORT_ROUTING_MARKER}: head=${headMarkerValue(headSha)}; ${routingKey(routed)} -->`;
}

/** Payload machine-readable usato dal native gate, senza fabbricare LGTM. */
export function transportRoutingEvidence({
  headSha = '',
  reviewId = null,
  transportPr = false,
  transportException = false,
  allOpenFindingIds = [],
  routed = [],
} = {}) {
  const routedItems = (routed || []).map((item) => ({
    findingId: String(item.findingId || ''),
    corpusPath: String(item.corpusPath || ''),
    sitePath: String(item.sitePath || ''),
    issueUrl: String(item.issueUrl || ''),
  }));
  return {
    version: 1,
    headSha: headMarkerValue(headSha),
    reviewId: reviewId === null || reviewId === undefined ? null : String(reviewId),
    transportPr: transportPr === true,
    transportException: transportException === true,
    allOpenFindingIds: [...new Set((allOpenFindingIds || []).map((id) => String(id)))],
    routedFindingIds: [...new Set(routedItems.map((item) => item.findingId).filter(Boolean))],
    routed: routedItems,
  };
}

export function transportRoutingEvidenceMarker(payload) {
  return `<!-- ${TRANSPORT_ROUTING_EVIDENCE_MARKER}: ${JSON.stringify(payload)} -->`;
}

export function parseTransportRoutingEvidence(body) {
  const found = [];
  const pattern = new RegExp(`<!--\\s*${TRANSPORT_ROUTING_EVIDENCE_MARKER}:\\s*(\\{[^\\n]*\\})\\s*-->`, 'gu');
  for (const match of String(body || '').matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]);
      if (value && typeof value === 'object' && !Array.isArray(value)) found.push(value);
    } catch {
      // Marker corrotto: il consumer lo ignora e resta fail-closed.
    }
  }
  return found;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function isKnownSiteIssueUrl(value, siteRepository = 'valerielinc-ops/frontaliere-si-o-no') {
  const repository = escapeRegExp(siteRepository);
  return new RegExp(`^https://github\\.com/${repository}/issues/[1-9]\\d*(?:#issuecomment-[1-9]\\d*)?$`, 'u')
    .test(String(value || ''));
}
