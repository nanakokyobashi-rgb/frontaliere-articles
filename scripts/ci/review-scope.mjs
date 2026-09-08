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

const FOLLOWUP_MARKER = 'OUT_OF_SCOPE_REVIEW_FOLLOWUP';
const FILE_CITATION_RE = /(?:^|[\s([{"'`])((?:\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:cjs|css|html|js|json|md|mjs|sh|ts|tsx|txt|toml|yaml|yml|jsx))(?:[:#]L?\d+(?:[-–]\d+)?)?/giu;
const IMPORTANT_MARKER_RE = /🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]\s*/u;
const ZERO_IMPORTANT_RE = /^(?:0|none|nessuno)(?:[.)\s]|$)/iu;

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
  const text = String(body || '');
  const start = text.search(/^##\s+Findings\b/im);
  if (start < 0) return '';
  const rest = text.slice(start);
  const end = rest.search(/^##\s+(?:Adversarial check|LGTM|Summary)\b/im);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Ritorna i blocchi che sono davvero verdetti Important, non il conteggio. */
export function importantFindings(body) {
  const section = findingsSection(body);
  const lines = (section || String(body || '')).split(/\r?\n/);
  const markers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => importantFindingLine(line));
  return markers.map(({ line, index }, markerIndex) => {
    const end = markers[markerIndex + 1]?.index ?? lines.length;
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
  return candidate === wanted || candidate.endsWith(`/${wanted}`) || wanted.endsWith(`/${candidate}`);
}

/** Risolve un riferimento reviewer sul path completo o lo marca ambiguo. */
export function resolveCitedPath(citation, repositoryPaths) {
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
  // Un path con slash e' gia' un riferimento non ambiguo. Se il tree API non e'
  // disponibile, lo si puo' comunque confrontare con il diff normalizzato.
  if (wanted.includes('/')) {
    return { status: 'resolved', path: wanted, candidates: [], inferred: true };
  }
  return { status: 'non-risolubile', path: null, candidates: [] };
}

function changedContains(changedFiles, resolvedPath) {
  return changedFiles.some((file) => suffixMatches(file, resolvedPath));
}

/**
 * Classificazione pura. `repositoryPaths` deve essere il tree completo quando
 * disponibile; senza tree i basename vengono risolti solo contro i file del
 * diff, quindi un basename esterno resta non risolvibile.
 */
export function classifyImportantFindings(body, changedFiles, repositoryPaths = null) {
  const changed = [...new Set((changedFiles || []).map(normalizePath).filter(Boolean))];
  const knownPaths = repositoryPaths === null ? changed : repositoryPaths;
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
      result: resolveCitedPath(citation, knownPaths),
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
  const output = gh(
    ['api', `repos/${repo}/pulls/${pr}/files`, '--paginate', '--jq', '.[].filename'],
    { json: false },
  );
  return output
    .split(/\r?\n/)
    .map(normalizePath)
    .filter(Boolean);
}

function fetchRepositoryPaths(repo, pr) {
  try {
    const base = gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.base.sha'], { json: false }).trim();
    if (!/^[0-9a-f]{40}$/iu.test(base)) return null;
    const tree = gh(['api', `repos/${repo}/git/trees/${base}?recursive=1`]);
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
  const anchor = `${path}:${citation.line || 1}`;
  if (token) {
    return `Applicare la correzione indicata dal reviewer in \`${anchor}\` e verificare \`${token}\`.`;
  }
  // L'ancora path:riga conserva un punto di accettazione falsificabile anche
  // quando il reviewer non ha citato un simbolo: non inventiamo un nome di
  // funzione che potrebbe non esistere nel file.
  return `Applicare la correzione indicata dal reviewer in \`${anchor}\` e verificare la riga citata.`;
}

export function followupIssueBody({ repo, pr, prUrl, findings }) {
  const originUrl = prUrl || `https://github.com/${repo}/pull/${pr}`;
  const items = findings.map((finding, index) => {
    const path = finding.resolvedFiles[0];
    return [
      `### ${index + 1}. Finding fuori dal diff: \`${path}\``,
      '- Source: reviewer 🔴 Important fuori dal diff',
      '- Stato dichiarato nella PR: nessuno',
      '- Original text:',
      `  > ${safeText(finding.text || finding.line)}`,
      '- Funnel impact: superficie pubblicata / contratto col sito',
      '- Rationale: il reviewer ha trovato un difetto in una funzione condivisa che non appartiene al diff corrente; il fix va tracciato senza bloccare questa PR.',
      `- Suggested action: ${suggestedAction(finding)}`,
    ].join('\n');
  });
  return [
    `<!-- ${FOLLOWUP_MARKER}: ${repo}#${pr} -->`,
    '## Origine',
    '',
    `- PR: #${pr}`,
    `- URL: ${originUrl}`,
    '',
    '## Item',
    '',
    items.join('\n\n'),
    '',
  ].join('\n');
}

function followupTitle(pr, findings) {
  const firstPath = findings[0]?.resolvedFiles?.[0] || 'file non specificato';
  return `follow-up(#${pr}): finding fuori dal diff — ${firstPath}`.slice(0, 120);
}

function findExistingFollowup(repo, pr) {
  try {
    const issues = gh([
      'issue', 'list', '--repo', repo, '--state', 'all', '--label', 'follow-up',
      '--search', `follow-up(#${pr})`, '--limit', '100', '--json', 'number,title,body',
    ]);
    if (!Array.isArray(issues)) return null;
    const titleRe = new RegExp(`^follow-up\\(#${pr}\\):`);
    return issues.find((issue) =>
      String(issue.body || '').includes(`${FOLLOWUP_MARKER}: ${repo}#${pr}`) ||
      titleRe.test(String(issue.title || '')),
    ) || null;
  } catch (error) {
    throw new Error(`lista follow-up non leggibile: ${String(error).slice(0, 180)}`);
  }
}

function mintFollowup({ repo, pr, body, findings }) {
  const existing = findExistingFollowup(repo, pr);
  const title = followupTitle(pr, findings);
  if (existing) {
    gh(['issue', 'edit', String(existing.number), '--repo', repo, '--body', body], { json: false });
    return { number: existing.number, updated: true };
  }
  const url = gh([
    'issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', 'follow-up',
  ], { json: false }).trim();
  if (!url) throw new Error('gh issue create non ha restituito un URL');
  return { url, updated: false };
}

/**
 * Classifica la review sulla PR reale e, solo se tutti i finding sono fuori
 * scope, conia/aggiorna la singola issue della PR.
 */
export function classifyAndMintReview(body, { repo, pr, prUrl, mutate = true } = {}) {
  if (!repo || !pr) throw new Error('repo e pr sono obbligatori');
  const changedFiles = fetchChangedFiles(repo, pr);
  const repositoryPaths = fetchRepositoryPaths(repo, pr);
  const result = classifyImportantFindings(body, changedFiles, repositoryPaths);
  if (result.outside.length === 0 || !mutate) {
    return { ...result, minted: false, changedFiles };
  }
  const issueBody = followupIssueBody({ repo, pr, prUrl, findings: result.outside });
  const followup = mintFollowup({ repo, pr, body: issueBody, findings: result.outside });
  return { ...result, minted: true, followup, changedFiles };
}

function readReviewBody() {
  if (process.env.REVIEW_BODY_FILE) return readFileSync(process.env.REVIEW_BODY_FILE, 'utf8');
  return process.env.REVIEW_BODY || '';
}

if (process.argv[1] && process.argv[1].endsWith('review-scope.mjs')) {
  try {
    const result = classifyAndMintReview(readReviewBody(), {
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
