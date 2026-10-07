/**
 * Routing dei finding 🔴 che riguardano esclusivamente gemelli `identical`.
 *
 * La politica e' pura fino al confine del writer: il creator e il commentatore
 * arrivano come dipendenze iniettate, cosi' il caso «crea/aggiorna una issue»
 * resta testabile senza GitHub e continua a usare il writer deduplicante gia'
 * adottato dal ciclo.
 */
import { identicalPaths, identicalSitePaths } from './identical-paths.mjs';

export const IDENTICAL_REVIEW_TITLE = (sitePath) =>
  `gemello identical: rilievi della review del corpus su ${sitePath}`;

function findingPaths(finding) {
  const paths = Array.isArray(finding?.resolvedFiles) && finding.resolvedFiles.length
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
        findingId: finding.stableId || finding.id || finding.lineNumber || finding.text,
        corpusPath,
        sitePath: sites.get(corpusPath) || corpusPath,
      });
    }
  }
  return out;
}

function routeKey(items) {
  return [...new Set(items.map((item) => `${item.sitePath}:${item.findingId}`))].sort().join('|');
}

function issueDescription({ repo, pr, prUrl, sitePath, items }) {
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
  lines.push('', 'Il rilievo resta aperto sulla PR del corpus: questo instradamento non modifica il gate e non autorizza il merge.', '');
  return lines.join('\n');
}

function commentBody({ repo, pr, prUrl, routed, allIdentical }) {
  const marker = `<!-- IDENTICAL_REVIEW_ROUTING: ${routeKey(routed)} -->`;
  const lines = [
    marker,
    '📤 **Rilievi su gemelli `identical` instradati al sito**',
    '',
    'Questi rilievi restano aperti sulla PR del corpus; il fixer non li applica qui e nessun gate è stato abbassato.',
    '',
  ];
  for (const item of routed) {
    lines.push(`- \`${item.corpusPath}\` → \`${item.sitePath}\`: ${item.issueUrl || 'issue del sito creata/aggiornata'}`);
  }
  if (allIdentical) {
    lines.push('', 'Tutti i rilievi aperti sono su gemelli `identical`: il giro del fixer viene saltato e non consuma quota né round.');
  }
  lines.push('', `Origine: [PR #${pr}](${prUrl || `https://github.com/${repo}/pull/${pr}`})`);
  return lines.join('\n');
}

/**
 * Apre/aggiorna una issue per path del sito e commenta la PR una sola volta
 * quando il callback `commentPr` implementa il controllo del marker.
 */
export async function routeIdenticalFindings({
  findings,
  manifest,
  repo,
  pr,
  prUrl = '',
  createIssue,
  commentPr = null,
  mutate = true,
} = {}) {
  if (typeof createIssue !== 'function') throw new TypeError('createIssue deve essere una funzione');
  const candidates = classifyIdenticalFindings(findings, manifest);
  const uniqueFindings = [...new Set(candidates.map((item) => item.findingId))];
  const allIdentical = Array.isArray(findings) && findings.length > 0 && uniqueFindings.length === findings.length;
  if (!mutate || candidates.length === 0) {
    return { candidates, routed: [], routedFindingIds: [], allIdentical };
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
      description: issueDescription({ repo, pr, prUrl, sitePath, items }),
      priority: 2,
      labels: [],
      exactTitle: true,
      dedupKey: `gemello identical:`,
    });
    if (!issue || issue.persisted !== true) {
      throw new Error(`routing identical non persistito per ${sitePath}`);
    }
    for (const item of items) routed.push({ ...item, issueNumber: issue.number, issueUrl: issue.url });
  }
  if (typeof commentPr === 'function') {
    await commentPr(commentBody({ repo, pr, prUrl, routed, allIdentical }), { marker: `<!-- IDENTICAL_REVIEW_ROUTING: ${routeKey(routed)} -->` });
  }
  return {
    candidates,
    routed,
    routedFindingIds: [...new Set(routed.map((item) => item.findingId))],
    allIdentical,
  };
}
