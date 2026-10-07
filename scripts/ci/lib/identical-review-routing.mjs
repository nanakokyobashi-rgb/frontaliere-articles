/**
 * Routing dei finding 🔴 che riguardano esclusivamente gemelli `identical`.
 *
 * La politica e' pura fino al confine del writer: il creator e il commentatore
 * arrivano come dipendenze iniettate, cosi' il caso «crea/aggiorna una issue»
 * resta testabile senza GitHub e continua a usare il writer deduplicante gia'
 * adottato dal ciclo.
 */
import { identicalPaths, identicalSitePaths } from './identical-paths.mjs';
import {
  TRANSPORT_EXCEPTION_PHRASE,
  identicalRoutingCommentMarker,
  transportRoutingEvidence,
  transportRoutingEvidenceMarker,
} from './transport-pr.mjs';

export const IDENTICAL_REVIEW_TITLE = (sitePath) =>
  `gemello identical: rilievi della review del corpus su ${sitePath}`;

function findingPaths(finding) {
  const paths = Object.hasOwn(finding || {}, 'resolvedFiles') && Array.isArray(finding.resolvedFiles)
    ? finding.resolvedFiles
    : (Array.isArray(finding?.citations) ? finding.citations.map((citation) => citation?.path) : []);
  return [...new Set(paths.filter((value) => typeof value === 'string' && value.length > 0))];
}

/**
 * Seleziona solo i finding per cui TUTTI i path risolti sono `identical`.
 * Un finding misto resta al fixer: instradarne solo una parte abbasserebbe il
 * gate sul residuo che il sito non puo' correggere.
 */
export function classifyIdenticalFindings(findings, manifest) {
  const locked = identicalPaths(manifest);
  const sites = identicalSitePaths(manifest);
  const out = [];
  for (const finding of findings || []) {
    const corpusPaths = findingPaths(finding);
    if (corpusPaths.length === 0 || !corpusPaths.every((rel) => locked.has(rel))) continue;
    for (const corpusPath of corpusPaths) {
      out.push({
        finding,
        findingId: String(finding.stableId || finding.id || finding.lineNumber || finding.text),
        corpusPath,
        sitePath: sites.get(corpusPath) || corpusPath,
      });
    }
  }
  return out;
}

function issueDescription({
  repo,
  pr,
  prUrl,
  sitePath,
  items,
  transportPr = false,
  transportException = false,
}) {
  const lines = [
    'Diagnosi instradata automaticamente dal fixer del corpus: il rilievo riguarda un file `mode: identical` e va corretto nel sito.',
    '',
    `**Path del sito:** \`${sitePath}\``,
    `**PR del corpus:** [#${pr}](${prUrl || `https://github.com/${repo}/pull/${pr}`})`,
    '',
    '## Rilievi aperti',
  ];
  for (const item of items) {
    lines.push(`- **Path corpus:** \`${item.corpusPath}\``);
    lines.push(`  **Finding:** ${String(item.finding?.text || '').trim()}`);
  }
  if (transportException) {
    lines.push('', `${TRANSPORT_EXCEPTION_PHRASE}.`, '');
  } else if (transportPr) {
    lines.push('', 'Il rilievo resta aperto sulla PR del corpus: il trasporto resta bloccato finché ogni rilievo aperto non è instradato con una issue del sito.', '');
  } else {
    lines.push('', 'Il rilievo resta aperto sulla PR del corpus: questo instradamento non modifica il gate e non autorizza il merge.', '');
  }
  return lines.join('\n');
}

function commentBody({
  repo,
  pr,
  prUrl,
  routed,
  allIdentical,
  transportPr = false,
  transportException = false,
  headSha = '',
  reviewId = null,
  allOpenFindingIds = [],
}) {
  const marker = identicalRoutingCommentMarker({ routed, headSha });
  const evidence = transportRoutingEvidence({
    headSha,
    reviewId,
    transportPr,
    transportException,
    allOpenFindingIds,
    routed,
  });
  const lines = [
    marker,
    transportRoutingEvidenceMarker(evidence),
    '📤 **Rilievi su gemelli `identical` instradati al sito**',
    '',
    transportException
      ? `Questi rilievi restano aperti sulla PR del corpus; il fixer non li applica qui. ${TRANSPORT_EXCEPTION_PHRASE}.`
      : transportPr
        ? 'Questi rilievi restano aperti sulla PR del corpus; il fixer non li applica qui e il trasporto resta bloccato finché ogni rilievo aperto non è instradato.'
        : 'Questi rilievi restano aperti sulla PR del corpus; il fixer non li applica qui e nessun gate è stato abbassato.',
    '',
  ];
  for (const item of routed) {
    lines.push(`- \`${item.corpusPath}\` → \`${item.sitePath}\`: ${item.issueUrl || 'issue del sito creata/aggiornata'}`);
  }
  if (allIdentical) {
    lines.push('', 'Tutti i rilievi aperti sono su gemelli `identical`: il giro del fixer viene saltato e non consuma quota né round.');
  }
  if (transportException) lines.push('', TRANSPORT_EXCEPTION_PHRASE);
  lines.push('', `Origine: [PR #${pr}](${prUrl || `https://github.com/${repo}/pull/${pr}`})`);
  return lines.join('\n');
}

/**
 * Apre/aggiorna una issue per path del sito e commenta la PR una sola volta
 * quando il callback `commentPr` implementa il controllo del marker.
 */
export async function routeIdenticalFindings({
  findings,
  allFindings = findings,
  manifest,
  repo,
  pr,
  prUrl = '',
  createIssue,
  commentPr = null,
  mutate = true,
  transportPr = null,
  headSha = '',
  reviewId = null,
} = {}) {
  if (typeof createIssue !== 'function') throw new TypeError('createIssue deve essere una funzione');
  const candidates = classifyIdenticalFindings(findings, manifest);
  const uniqueFindings = [...new Set(candidates.map((item) => item.findingId))];
  const considered = Array.isArray(allFindings) ? allFindings : findings;
  const allOpenFindingIds = [...new Set(considered.map((finding) => (
    finding?.stableId || finding?.id || finding?.lineNumber || finding?.text
  )).filter((id) => id !== undefined && id !== null).map(String))];
  const allIdentical = allOpenFindingIds.length > 0
    && uniqueFindings.length === allOpenFindingIds.length;
  const transported = new Set(transportPr?.transportedFiles || []);
  const candidatesByFinding = new Map();
  for (const item of candidates) {
    const group = candidatesByFinding.get(item.findingId) || [];
    group.push(item);
    candidatesByFinding.set(item.findingId, group);
  }
  const transportPrRecognized = transportPr?.transport === true;
  const transportEligibleFindingIds = new Set(
    [...candidatesByFinding.entries()]
      .filter(([, items]) => transportPrRecognized
        && items.every((item) => transported.has(item.corpusPath)))
      .map(([findingId]) => String(findingId)),
  );
  const transportExceptionCandidate = transportPrRecognized
    && allIdentical
    && allOpenFindingIds.every((findingId) => transportEligibleFindingIds.has(findingId));
  if (!mutate || candidates.length === 0) {
    return {
      candidates,
      routed: [],
      routedFindingIds: [],
      allIdentical,
      transportPr: transportPrRecognized,
      transportException: false,
      transportRoutedFindingIds: [],
      allOpenFindingIds,
    };
  }

  const bySite = new Map();
  for (const item of candidates) {
    const group = bySite.get(item.sitePath) || [];
    group.push(item);
    bySite.set(item.sitePath, group);
  }
  const routed = [];
  for (const [sitePath, items] of bySite) {
    const issue = await createIssue({
      title: IDENTICAL_REVIEW_TITLE(sitePath),
      description: issueDescription({
        repo,
        pr,
        prUrl,
        sitePath,
        items,
        transportPr: transportPrRecognized,
        transportException: transportExceptionCandidate,
      }),
      priority: 2,
      labels: [],
      exactTitle: true,
      dedupKey: `gemello identical:`,
    });
    if (!issue || issue.persisted !== true) {
      throw new Error(`routing identical non persistito per ${sitePath}`);
    }
    if (transportExceptionCandidate && !issue.url) {
      throw new Error(`routing identical senza URL issue per ${sitePath}`);
    }
    for (const item of items) routed.push({ ...item, issueNumber: issue.number, issueUrl: issue.url });
  }
  const routedFindingIds = [...new Set(routed.map((item) => item.findingId))];
  const transportRoutedFindingIds = routedFindingIds.filter((findingId) =>
    transportEligibleFindingIds.has(findingId)
      && routed.filter((item) => item.findingId === findingId).every((item) => item.issueUrl));
  const transportException = transportExceptionCandidate
    && transportRoutedFindingIds.length === allOpenFindingIds.length
    && allOpenFindingIds.every((findingId) => transportRoutedFindingIds.includes(findingId));
  if (typeof commentPr === 'function') {
    await commentPr(commentBody({
      repo,
      pr,
      prUrl,
      routed,
      allIdentical,
      transportPr: transportPrRecognized,
      transportException,
      headSha,
      reviewId,
      allOpenFindingIds,
    }), { marker: identicalRoutingCommentMarker({ routed, headSha }) });
  }
  return {
    candidates,
    routed,
    routedFindingIds,
    allIdentical,
    transportPr: transportPrRecognized,
    transportException,
    transportRoutedFindingIds,
    allOpenFindingIds,
  };
}
