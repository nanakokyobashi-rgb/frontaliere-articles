const PUBLISH_RANGE = /range=([0-9a-f]{40}|none)\.\.([0-9a-f]{40})(?:\s|$)/i;

/**
 * Estrae il range del push dal run-name del publisher, che conserva il before
 * SHA anche quando l'evento workflow_run non lo espone.
 */
export function parsePublishApiRange(displayTitle) {
  const match = PUBLISH_RANGE.exec(String(displayTitle ?? ''));
  if (!match) return null;
  return { before: match[1], after: match[2] };
}

/** Classifica l'assenza del Pages artifact usando il freshness gate del publisher. */
export function resolvePublisherArtifactState({
  artifactAvailable,
  publisherCommit = '',
  workflowHeadSha = '',
  mainHeadSha = '',
  newerPublisherInputs = false,
} = {}) {
  if (artifactAvailable) {
    if (!/^[0-9a-f]{40}$/.test(publisherCommit)) throw new Error('Pages artifact senza commit publisher valido');
    return { status: 'published', sourceCommit: publisherCommit, reason: 'publisher-artifact' };
  }
  if (!/^[0-9a-f]{40}$/.test(workflowHeadSha) || !/^[0-9a-f]{40}$/.test(mainHeadSha)) {
    throw new Error('Pages artifact assente e commit main/run non verificabili');
  }
  if (workflowHeadSha === mainHeadSha || !newerPublisherInputs) {
    throw new Error('Publish API concluso senza Pages artifact e senza una run piu\u0300 nuova proprietaria');
  }
  return { status: 'skipped', sourceCommit: '', reason: 'newer-publisher-run-queued' };
}

/**
 * I push che pubblicano dati articolo devono attendere la sitemap aggiornata.
 * Gli output degli hub entrano in content/** e avviano il publisher, ma non
 * devono avviare un secondo refresh degli hub.
 */
export function isArticlePublicationPath(filePath) {
  const normalized = String(filePath ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (isCantonHubOutputPath(normalized)) return false;
  return normalized.startsWith('content/') ||
    normalized.startsWith('data/blog-articles/') ||
    normalized.startsWith('data/swiss-articles/');
}

export function isCantonHubOutputPath(filePath) {
  const normalized = String(filePath ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  return /^content\/cantons\/canton-[a-z0-9-]+\/hubs\/[^/]+\.json$/.test(normalized);
}

export function isHubOutputOnlyRange(filePaths) {
  const paths = [...(filePaths ?? [])].filter(Boolean);
  return paths.length > 0 && paths.every(isCantonHubOutputPath);
}

/** Legge il receipt dal paragrafo finale del commit generato dal refresh hub. */
export function parseCantonHubRefreshMarker(message) {
  const text = String(message ?? '').trimEnd();
  if (!text) return null;
  const paragraphs = text.split(/\r?\n(?:[ \t]*\r?\n)+/u);
  const lines = paragraphs.at(-1)?.split(/\r?\n/u) ?? [];
  if (lines.length !== 5) return null;
  const source = /^Canton-Hub-Source-Commit: ([0-9a-f]{40})$/u.exec(lines[0]);
  const verified = /^Canton-Hub-Source-Verified: (true|false)$/u.exec(lines[1]);
  const runId = /^Canton-Hub-Receipt-Run-Id: ([1-9][0-9]{0,19})$/u.exec(lines[2]);
  const runAttempt = /^Canton-Hub-Receipt-Run-Attempt: ([1-9][0-9]{0,5})$/u.exec(lines[3]);
  const sectionsMatch = /^Canton-Hub-Sections: (canton-[a-z]+(?:,canton-[a-z]+)*)$/u.exec(lines[4]);
  if (!source || !verified || !runId || !runAttempt || !sectionsMatch) return null;
  const sections = sectionsMatch[1].split(',');
  if (new Set(sections).size !== sections.length) return null;
  return {
    sourceCommit: source[1],
    sourceVerified: verified[1] === 'true',
    receiptRunId: runId[1],
    receiptRunAttempt: runAttempt[1],
    sections,
  };
}

/**
 * Un evento publisher hub-only puo' chiudersi senza rigenerare solo se il
 * commit dice che tutte le sezioni attive furono processate dallo stesso
 * high-water e ogni commit successivo aggiunge esclusivamente output hub.
 */
export function hasCompleteCantonHubRefreshCoverage({
  enabledSections = [],
  publisherChangedPaths = [],
  publisherSourceCommit = '',
  commitMessage = '',
  receiptSourceCommit = '',
  receiptAuthenticated = false,
  sourceCommitIsAncestor = false,
  sourceChangedPaths = null,
} = {}) {
  if (!isHubOutputOnlyRange(publisherChangedPaths)) return false;
  if (!/^[0-9a-f]{40}$/u.test(publisherSourceCommit) || sourceCommitIsAncestor !== true) return false;
  if (!Array.isArray(sourceChangedPaths) || sourceChangedPaths.length === 0 ||
      !sourceChangedPaths.every(isCantonHubOutputPath)) return false;

  const marker = parseCantonHubRefreshMarker(commitMessage);
  if (!marker?.sourceVerified || receiptAuthenticated !== true) return false;
  if (marker.sourceCommit !== receiptSourceCommit) return false;
  const enabled = [...new Set((enabledSections ?? []).filter(Boolean))].sort();
  const covered = [...marker.sections].sort();
  return enabled.length > 0 &&
    marker.sections.length === enabled.length &&
    covered.every((section, index) => section === enabled[index]);
}

export function shouldWaitForArticlePublication(filePaths) {
  return [...(filePaths ?? [])].some(isArticlePublicationPath);
}

/** Calcola la modalita' del run con gli stessi eventi forniti dal workflow. */
export function resolveRefreshMode({
  eventName,
  pushBefore = '',
  pushAfter = '',
  upstreamEvent = '',
  upstreamBranch = '',
  upstreamConclusion = '',
  upstreamTitle = '',
  upstreamHeadSha = '',
  publisherStatus = 'published',
  publisherSourceCommit = '',
  changedPaths = [],
  dryRunInput = false,
}) {
  const skipped = (reason, before = '', after = '') => ({ run: false, dry: true, before, after, reason });
  if (eventName === 'push') {
    return shouldWaitForArticlePublication(changedPaths)
      ? skipped('await-publisher', pushBefore, pushAfter)
      : { run: true, dry: false, before: pushBefore, after: pushAfter, reason: 'direct-push' };
  }
  if (eventName === 'workflow_run') {
    if (upstreamEvent !== 'push' || upstreamBranch !== 'main' || upstreamConclusion !== 'success') {
      return skipped('publisher-not-successful');
    }
    const range = parsePublishApiRange(upstreamTitle);
    if (!range) throw new Error('run-name Publish article data API senza range before..after');
    if (range.after !== upstreamHeadSha) throw new Error('publisher range after diverso da head SHA');
    if (publisherStatus === 'skipped') {
      return skipped('publisher-skipped-requeued', range.before, range.after);
    }
    if (publisherStatus !== 'published') throw new Error(`receipt Publish API non pronto (${publisherStatus || 'assente'})`);
    const after = publisherSourceCommit || range.after;
    if (!/^[0-9a-f]{40}$/.test(after)) throw new Error('source commit Publish API non valido');
    return {
      run: true,
      dry: false,
      before: range.before === 'none' ? '' : range.before,
      after,
      reason: 'published-api-artifact',
    };
  }
  if (eventName === 'workflow_dispatch') {
    return { run: true, dry: Boolean(dryRunInput), before: '', after: '', reason: 'workflow-dispatch' };
  }
  if (eventName === 'schedule') return { run: true, dry: false, before: '', after: '', reason: 'schedule' };
  return skipped('unsupported-event');
}

const LOCAL_CANTON_PATHS = [
  /^content\/blog-body-(canton-[a-z]+)\//,
  /^content\/blog-meta-(canton-[a-z]+)-(?:it|en|de|fr)\.ts$/,
  /^content\/cantons\/(canton-[a-z]+)\/(?:registry|seo|slugs)\.ts$/,
  /^data\/sections\/(canton-[a-z]+)\//,
];
const AUXILIARY_CANTON_PATH = /^(?:data\/generated-image-registry\.json|public\/images\/blog\/)/;

/**
 * Restringe un refresh al cantone quando il range del push diretto contiene
 * solo input locali (piu' eventuali asset ausiliari); gli input condivisi o
 * ignoti richiedono tutti i cantoni abilitati. Il resolver workflow_run
 * include tutti i cantoni tranne quando un receipt hub-only prova che l'intero
 * set attivo e' gia' coperto dallo stesso publisher high-water.
 */
export function resolveCantonTargetSections(enabledSections, filePaths, { includeAll = false } = {}) {
  const enabled = [...new Set((enabledSections ?? []).filter(Boolean))];
  if (includeAll) return enabled;
  const localSections = new Set();
  for (const rawPath of filePaths ?? []) {
    const filePath = String(rawPath ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
    const local = LOCAL_CANTON_PATHS.map((pattern) => pattern.exec(filePath)).find(Boolean);
    if (local) {
      localSections.add(local[1]);
      continue;
    }
    if (AUXILIARY_CANTON_PATH.test(filePath)) continue;
    return enabled;
  }
  if (localSections.size === 0) return enabled;
  return enabled.filter((section) => localSections.has(section));
}
