#!/usr/bin/env node

/**
 * review-scope.mjs — classifica i finding Important rispetto alla HEAD della PR.
 *
 * Il reviewer puo' ispezionare il repository intero. Un finding su un file che
 * non appartiene al diff corrente resta una segnalazione valida, ma non deve
 * tenere rosso il gate della PR: viene raccolto in una sola issue follow-up.
 * L'errore di risoluzione e' conservativo: un basename ambiguo o una review
 * senza un file identificabile continua a bloccare, invece di perdere il
 * contesto del finding.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { REDFLAG_IMPORTANT_RE } from './lib/constants.mjs';
import { fetchPrFiles } from './lib/fetchPrFiles.mjs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

const FOLLOWUP_MARKER = 'OUT_OF_SCOPE_REVIEW_FOLLOWUP';
// Stesso margine del writer condiviso (`MAX_BODY_LEN`): il tetto API e' 65536.
const MAX_FOLLOWUP_BODY_LEN = 60000;
const FILE_CITATION_RE = /(?:^|[\s([{"'`])((?:\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:cjs|css|html|js|json|md|mjs|sh|ts|tsx|txt|toml|yaml|yml|jsx))(?:[:#]L?\d+(?:[-–]\d+)?)?/giu;
const IMPORTANT_MARKER_RE = /🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]\s*/u;
const ZERO_IMPORTANT_RE = /^(?:0|none|nessuno)\s*$/iu;

function resetImportantRegex() {
  REDFLAG_IMPORTANT_RE.lastIndex = 0;
}

/** Normalizza le forme `a/`, `b/`, `./` e i separatori usati dal reviewer. */
export function normalizePath(value) {
  let path = String(value || '')
    .trim()
    .replace(/^['"`([{<]+|['"`\])}>.,;:]+$/g, '')
    .replace(/\\/g, '/');
  path = path.replace(/^\.\//, '').replace(/^(?:\.\.\/)+/, '');
  path = path.replace(/^[ab]\//, '');
  return path.replace(/^\/+/, '').replace(/[:#]L?\d+(?:[-–]\d+)?$/u, '');
}

function citationPathAndLine(rawPath, fullMatch) {
  const lineMatch = fullMatch.match(/[:#]L?(\d+)(?:[-–]\d+)?$/u);
  return {
    path: normalizePath(rawPath),
    line: lineMatch ? Number(lineMatch[1]) : null,
  };
}

export function extractFileCitations(line) {
  const citations = [];
  FILE_CITATION_RE.lastIndex = 0;
  for (const match of String(line || '').matchAll(FILE_CITATION_RE)) {
    const citation = citationPathAndLine(match[1], match[0]);
    if (citation.path) citations.push(citation);
  }
  const seen = new Set();
  return citations.filter((citation) => {
    const key = `${citation.path}:${citation.line || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function importantFindingLine(line) {
  resetImportantRegex();
  if (!REDFLAG_IMPORTANT_RE.test(line)) return false;
  const marker = IMPORTANT_MARKER_RE.exec(line);
  if (!marker) return false;
  // Una riga di conteggio come `🔴 Important: 0` non e' un finding.
  return !ZERO_IMPORTANT_RE.test(line.slice(marker.index + marker[0].length).trim());
}

function findingsSection(body) {
  // REVIEW.md permits a blocking verdict in both `## Findings` and
  // `## Adversarial check`. Truncating at the latter silently declassifies a
  // real in-diff Important finding. Parse the whole review body; the marker
  // predicate below still excludes `Important: 0` and quoted lower-severity
  // prose through the shared positional regex.
  return String(body || '');
}

/** Ritorna i blocchi che sono davvero verdetti Important, non il conteggio. */
export function importantFindings(body) {
  const section = findingsSection(body);
  const lines = (section || String(body || '')).split(/\r?\n/);
  const markers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => importantFindingLine(line));
  return markers.map(({ line, index }, markerIndex) => {
    const nextFinding = markers[markerIndex + 1]?.index ?? lines.length;
    const nextH2 = lines.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && /^##\s/u.test(candidate));
    const end = Math.min(nextFinding, nextH2 === -1 ? lines.length : nextH2);
    const text = lines.slice(index, end).join('\n').trim();
    return {
      line,
      text,
      lineNumber: index + 1,
      citations: extractFileCitations(text),
    };
  });
}

function suffixMatches(candidate, wanted) {
  return candidate === wanted || candidate.endsWith(`/${wanted}`);
}

/** Risolve un riferimento reviewer sul path completo o lo marca ambiguo. */
export function resolveCitedPath(citation, repositoryPaths, { treeAvailable = repositoryPaths !== null && repositoryPaths !== undefined } = {}) {
  const wanted = normalizePath(citation.path);
  const paths = [...new Set((repositoryPaths || []).map(normalizePath).filter(Boolean))];
  const candidates = paths.filter((path) => {
    if (wanted.includes('/')) return suffixMatches(path, wanted);
    return path === wanted || path.endsWith(`/${wanted}`);
  });
  if (candidates.length === 1) {
    return { status: 'resolved', path: candidates[0], candidates };
  }
  if (candidates.length > 1) {
    return { status: 'non-risolubile', path: null, candidates };
  }
  // Senza tree non e' possibile distinguere un path fuori diff da uno
  // inesistente/rinominato: il fallimento della fetch resta non risolvibile e
  // bloccante, mai un'inferenza che approva la review.
  return { status: 'non-risolubile', path: null, candidates: [] };
}

function changedContains(changedFiles, resolvedPath) {
  return changedFiles.some((file) => file === resolvedPath || file.endsWith(`/${resolvedPath}`));
}

/**
 * Classificazione pura. `repositoryPaths` deve essere il tree completo quando
 * disponibile; senza tree i basename vengono risolti solo contro i file del
 * diff, quindi un basename esterno resta non risolvibile.
 */
export function classifyImportantFindings(body, changedFiles, repositoryPaths = null) {
  const changed = [...new Set((changedFiles || []).map(normalizePath).filter(Boolean))];
  const treeAvailable = repositoryPaths !== null && repositoryPaths !== undefined;
  const knownPaths = treeAvailable ? repositoryPaths : changed;
  const outside = [];
  const inScope = [];
  const unresolved = [];

  for (const finding of importantFindings(body)) {
    if (finding.citations.length === 0) {
      unresolved.push({ ...finding, reason: 'nessun file citato' });
      continue;
    }
    const resolved = finding.citations.map((citation) => ({
      citation,
      result: resolveCitedPath(citation, knownPaths, { treeAvailable }),
    }));
    const bad = resolved.find((item) => item.result.status !== 'resolved');
    if (bad) {
      unresolved.push({
        ...finding,
        reason: bad.result.candidates.length
          ? 'basename ambiguo'
          : 'file non risolto',
        candidates: bad.result.candidates,
        resolved,
      });
      continue;
    }
    const resolvedFiles = resolved.map((item) => item.result.path);
    const isInScope = resolvedFiles.some((file) => changedContains(changed, file));
    const classified = {
      ...finding,
      resolvedFiles,
      resolved,
    };
    (isInScope ? inScope : outside).push(classified);
  }

  return {
    findings: importantFindings(body),
    outside,
    inScope,
    unresolved,
    outsideOnly: outside.length > 0 && inScope.length === 0 && unresolved.length === 0,
    blocking: inScope.length > 0 || unresolved.length > 0,
  };
}

function gh(args, { json = true } = {}) {
  const output = execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return json ? JSON.parse(output) : output;
}

function fetchChangedFiles(repo, pr) {
  return fetchPrFiles(Number(pr), gh, repo);
}

function fetchRepositoryPaths(repo, pr) {
  try {
    // Citations are resolved against the tree that the reviewer actually
    // inspected. The base tree omits files added by the PR and made every
    // Important on a new corpus script look like an unresolvable finding.
    const head = gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha'], { json: false }).trim();
    if (!/^[0-9a-f]{40}$/iu.test(head)) return null;
    const tree = gh(['api', `repos/${repo}/git/trees/${head}?recursive=1`]);
    if (tree?.truncated || !Array.isArray(tree?.tree)) return null;
    return tree.tree
      .filter((item) => item.type === 'blob' && item.path)
      .map((item) => normalizePath(item.path));
  } catch (error) {
    console.log(`review-scope: tree del repository non disponibile (${String(error).slice(0, 160)}).`);
    return null;
  }
}

function safeText(value) {
  return String(value || '').replace(/\r?\n/g, ' ').trim();
}

function distinctiveToken(text) {
  const candidates = [];
  for (const match of String(text || '').matchAll(/`([^`\n]{3,90})`/gu)) {
    const token = match[1].trim();
    if (!token.includes('/') && /[(){}'"`]|::|=>|\.\w|:\d|>=|<=/.test(token)) {
      candidates.push(token);
    }
  }
  return candidates.sort((a, b) => b.length - a.length)[0] || null;
}

function suggestedAction(finding) {
  const path = finding.resolvedFiles[0];
  const citation = finding.citations[0];
  const token = distinctiveToken(finding.text || finding.line);
  const anchor = citation.line ? `${path} alla riga ${citation.line}` : path;
  if (token) {
    return `Applicare la correzione indicata dal reviewer in ${anchor} e verificare \`${token}\`.`;
  }
  // Il path e la riga restano contesto umano, non un token di accettazione:
  // `path:12` sarebbe sempre "distintivo" per il matcher dei follow-up ma non
  // puo' mai comparire nel contenuto del file. Senza un token di codice reale
  // l'item resta leggibile ma non falsificabile, quindi non viene auto-chiuso.
  return `Applicare la correzione indicata dal reviewer in ${anchor} e verificare la riga citata.`;
}

/** Il testo di un item, senza l'intestazione `### N.` che lo numera. */
function followupItemBodies(findings) {
  return findings.map((finding) => {
    const path = finding.resolvedFiles[0];
    return [
      `Finding fuori dal diff: \`${path}\``,
      '- Source: reviewer 🔴 Important fuori dal diff',
      '- Stato dichiarato nella PR: nessuno',
      '- Original text:',
      `  > ${safeText(finding.text || finding.line)}`,
      '- Funnel impact: superficie pubblicata / contratto col sito',
      '- Rationale: il reviewer ha trovato un difetto in una funzione condivisa che non appartiene al diff corrente; il fix va tracciato senza bloccare questa PR.',
      `- Suggested action: ${suggestedAction(finding)}`,
    ].join('\n');
  });
}

/**
 * Gli item gia' presenti nel corpo di una follow-up, senza la numerazione.
 * Stessa spezzatura di `splitFollowupItems()` in followup-resolution-match.mjs:
 * il drainer legge il CORPO, quindi il merge deve partire da cio' che il
 * drainer vede, non da cio' che i commenti raccontano.
 */
export function followupItemsFromBody(body) {
  return String(body || '')
    .split(/^### \d+\.\s*/mu)
    .slice(1)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function itemKey(item) {
  return String(item).replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Unisce gli item vecchi e nuovi in ordine, senza duplicarli. */
export function mergeFollowupItems(existingBody, freshItems) {
  const merged = [];
  const seen = new Set();
  for (const item of [...followupItemsFromBody(existingBody), ...freshItems]) {
    const key = itemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function renderFollowupBody({ repo, pr, prUrl, items }) {
  const originUrl = prUrl || `https://github.com/${repo}/pull/${pr}`;
  const header = [
    `<!-- ${FOLLOWUP_MARKER}: ${repo}#${pr} -->`,
    '## Origine',
    '',
    `- PR: #${pr}`,
    `- URL: ${originUrl}`,
    '',
    '## Item',
    '',
  ].join('\n');
  // Il corpo ha un tetto duro lato API: se l'aggregato lo supera si tengono gli
  // item piu' RECENTI (in coda) e si dichiara quanti sono stati omessi, invece
  // di far fallire l'edit e lasciare il corpo fermo al giro precedente.
  const kept = [...items];
  let omitted = 0;
  let body = '';
  for (;;) {
    const numbered = kept.map((item, index) => `### ${index + 1}. ${item}`).join('\n\n');
    const note = omitted
      ? `\n\n_${omitted} item più vecchi omessi per il limite di lunghezza del corpo; restano nella cronologia dei commenti._`
      : '';
    body = `${header}${numbered}${note}\n`;
    if (body.length <= MAX_FOLLOWUP_BODY_LEN || kept.length <= 1) break;
    kept.shift();
    omitted += 1;
  }
  return body;
}

export function followupIssueBody({ repo, pr, prUrl, findings, existingBody = '' }) {
  return renderFollowupBody({
    repo,
    pr,
    prUrl,
    items: mergeFollowupItems(existingBody, followupItemBodies(findings)),
  });
}

/** Stessa risoluzione del target del writer condiviso: `GH_REPO` o la cwd. */
function repoFlag() {
  return process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
}

function readIssueBody(number) {
  return gh(['issue', 'view', String(number), '--json', 'body', '--jq', '.body', ...repoFlag()], { json: false });
}

/**
 * Riscrive il CORPO della follow-up con l'aggregato.
 *
 * Il writer condiviso, quando la issue e' gia' aperta, si limita a COMMENTARE
 * (`github-issue-creator.mjs`): il corpo resterebbe quello del primo giro. Ma i
 * consumer della follow-up leggono il corpo — `followup-has-candidates.mjs` e
 * `splitFollowupItems()` in `followup-resolution-match.mjs` — e non i commenti,
 * quindi dal secondo giro i finding declassati non atterrerebbero in nessuna
 * superficie drenabile: il gate diventa verde e l'item sparisce senza errore.
 */
function syncFollowupBody({ repo, pr, prUrl, findings, number }) {
  const current = readIssueBody(number);
  const merged = followupIssueBody({ repo, pr, prUrl, findings, existingBody: current });
  if (merged.trim() === String(current || '').trim()) return { bodySynced: true, bodyChanged: false };
  gh(['issue', 'edit', String(number), '--body', merged, ...repoFlag()], { json: false });
  return { bodySynced: true, bodyChanged: true };
}

async function mintFollowup({ repo, pr, prUrl, body, findings }) {
  // Il titolo stabile per PR rende il conio idempotente sul titolo: il writer
  // deduplica gli aperti con la ricerca più il listing immediatamente consistente.
  // Non riaprire una follow-up chiusa: se il drainer l'ha chiusa, il giro nuovo
  // deve aprire un thread nuovo, non reinnestare item gia' risolti.
  const title = `follow-up(#${pr}): finding fuori dal diff`;
  const result = await createGithubIssue({
    title,
    description: body,
    priority: 2,
    labels: ['follow-up'],
    // Una follow-up chiusa puo' essere stata drenata: il suo corpo non va
    // risuscitato nel nuovo thread. 0 e' l'opt-out esplicito del writer.
    reopenWithinHours: 0,
  });
  if (!result || result.persisted !== true) {
    throw new Error(`writer follow-up non ha confermato la persistenza per PR #${pr}`);
  }
  if (result.number == null) {
    throw new Error(`writer follow-up non ha restituito il numero della issue per PR #${pr}`);
  }
  // Il corpo e' l'unica superficie che il drainer legge: se non riusciamo a
  // riscriverlo, il finding non e' tracciato e l'errore deve restare bloccante.
  const synced = syncFollowupBody({ repo, pr, prUrl, findings, number: result.number });
  return {
    number: result.number,
    url: result.url,
    reopened: result.reopened === true,
    updated: result.reopened !== true && result.number != null,
    ...synced,
  };
}

/**
 * Classifica la review sulla PR reale e, solo se tutti i finding sono fuori
 * scope, conia/aggiorna la singola issue della PR.
 */
export async function classifyAndMintReview(body, { repo, pr, prUrl, mutate = true } = {}) {
  if (!repo || !pr) throw new Error('repo e pr sono obbligatori');
  const changed = fetchChangedFiles(repo, pr);
  const diffUnavailable = changed.complete !== true || changed.files.length === 0;
  if (diffUnavailable) {
    const findings = importantFindings(body);
    const reason = changed.files.length === 0 ? 'empty' : changed.reason;
    return {
      findings,
      outside: [],
      inScope: [],
      unresolved: findings.map((finding) => ({
        ...finding,
        reason: `diff non verificabile (${reason})`,
      })),
      outsideOnly: false,
      blocking: findings.length > 0,
      minted: false,
      changedFiles: changed.files,
      changedFilesComplete: changed.complete,
      diffReason: reason,
    };
  }
  const repositoryPaths = fetchRepositoryPaths(repo, pr);
  const result = classifyImportantFindings(body, changed.files, repositoryPaths);
  if (result.outside.length === 0 || !mutate) {
    return {
      ...result,
      minted: false,
      changedFiles: changed.files,
      changedFilesComplete: changed.complete,
      diffReason: changed.reason,
    };
  }
  const issueBody = followupIssueBody({ repo, pr, prUrl, findings: result.outside });
  const followup = await mintFollowup({ repo, pr, prUrl, body: issueBody, findings: result.outside });
  return {
    ...result,
    minted: true,
    followup,
    changedFiles: changed.files,
    changedFilesComplete: changed.complete,
    diffReason: changed.reason,
  };
}

function readReviewBody() {
  if (process.env.REVIEW_BODY_FILE) return readFileSync(process.env.REVIEW_BODY_FILE, 'utf8');
  return process.env.REVIEW_BODY || '';
}

if (process.argv[1] && process.argv[1].endsWith('review-scope.mjs')) {
  try {
    const result = await classifyAndMintReview(readReviewBody(), {
      repo: process.env.GITHUB_REPOSITORY || process.env.REPO,
      pr: process.env.PR_NUMBER,
      prUrl: process.env.PR_URL,
      mutate: process.env.REVIEW_SCOPE_MUTATE !== 'false',
    });
    process.stdout.write(`${JSON.stringify({
      outsideOnly: result.outsideOnly,
      blocking: result.blocking,
      important: result.findings.length,
      outside: result.outside.length,
      inScope: result.inScope.length,
      unresolved: result.unresolved.length,
      minted: result.minted,
      followup: result.followup || null,
    })}\n`);
  } catch (error) {
    console.error(`review-scope: errore conservativo: ${String(error)}`);
    process.exit(1);
  }
}
