import { createHash } from 'node:crypto';

export const TRANSPORT_MANUAL_BLOCKER_WORKFLOW_PATH = '.github/workflows/transport-identical-twins.yml';

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const CARET_ANSI_RE = /\^\[\[[0-9;]*[A-Za-z]/g;

/** Normalize a blocker set so log order and repeated lines cannot change its identity. */
export function canonicalManualBlockers(blockers) {
  const unique = new Set();
  for (const blocker of Array.isArray(blockers) ? blockers : []) {
    const value = String(blocker ?? '').trim();
    if (value) unique.add(value);
  }
  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The stable issue key for one distinct, sorted set of manual blockers. */
export function manualBlockerIssueKey(blockers) {
  const canonical = canonicalManualBlockers(blockers);
  if (canonical.length === 0) return null;
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
  return `manual:${hash}`;
}

/** The canonical generic or cause-keyed title for a Transport workflow issue. */
export function workflowFailureTitle(workflowName, issueKey = null) {
  const name = String(workflowName ?? '').trim();
  const key = String(issueKey ?? '').trim();
  return `Workflow Failure: ${key ? `${key} | ` : ''}${name}`;
}

/** Build the issue title shared by the failed-run scanner and recovery parser. */
export function manualBlockerFailureTitle(workflowName, blockers) {
  const key = manualBlockerIssueKey(blockers);
  return workflowFailureTitle(workflowName, key);
}

/** Recreate the keyed expected title that the closer revalidates before writing. */
export function failureIssueTitleForRecovery(issue) {
  if (issue?.issueKey) return workflowFailureTitle(issue.workflow, issue.issueKey);
  return String(issue?.title ?? '');
}

/**
 * Extract runtime `⛔` manual blocker lines from an Actions log, in canonical
 * order. `gh run view --log` also includes the shell trace and `##[error]`
 * annotation, both of which quote the marker from the workflow source. A
 * blocker is valid only when it is the first runtime message after the
 * job/step/timestamp prefix.
 */
export function manualBlockersFromFailureLog(log) {
  const blockers = [];
  for (const rawLine of String(log ?? '').split(/\r?\n/)) {
    const fields = rawLine.split('\t');
    const runtime = fields.length >= 3
      ? fields.slice(2).join('\t').replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[^\s]+\s+/, '')
      : rawLine;
    const line = runtime
      .replace(/\r$/, '')
      .replace(ANSI_RE, '')
      .replace(CARET_ANSI_RE, '');
    const message = line.trimStart();
    if (!message.startsWith('⛔')) continue;
    const blocker = message.slice('⛔'.length).trim();
    if (blocker) blockers.push(blocker);
  }
  return canonicalManualBlockers(blockers);
}

/**
 * Parse a reporter title into its recovery workflow and issue identity.
 * Legacy titles remain valid; manual blocker titles retain their cause key while
 * exposing the real workflow name to the recovery run query.
 */
export function failureIssueIdentityFromTitle(title) {
  const match = /^(Workflow|Crawler|CI) Failure: (.+)$/.exec(String(title ?? ''));
  if (!match) return null;
  const display = match[2].trim();
  if (match[1] === 'Workflow') {
    const keyed = /^manual:([a-f0-9]{16}) \| (.+)$/.exec(display);
    if (keyed) {
      return {
        kind: match[1],
        workflowName: keyed[2].trim(),
        issueKey: `manual:${keyed[1]}`,
      };
    }
  }
  return { kind: match[1], workflowName: display, issueKey: null };
}
