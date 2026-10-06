#!/usr/bin/env node

/**
 * Corpus-only observer for final review claims. The identical loop report is
 * intentionally left mirror-safe; this companion adds the claim-specific
 * breakdown to the corpus workflow summary without changing the site's twin.
 */

import { execFileSync } from 'node:child_process';
import { normalizeCauseClass } from './codex-primary-diagnostics.mjs';
import { parseReviewClaim, REVIEW_CLAIM_MARKER } from './review-claim.mjs';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const argv = process.argv.slice(2);
const DAYS = Number(argv.includes('--days') ? argv[argv.indexOf('--days') + 1] : 7);
export const CLAIM_COMMENT_LIMIT = 5_000;

function gh(args, { json = true } = {}) {
  const output = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(output) : output;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function isPullRequestComment(comment) {
  return /\/pull(?:s)?\//iu.test(String(comment?.html_url || comment?.issue_url || ''));
}

function markerFromComment(comment) {
  if (!isPullRequestComment(comment)) return null;
  const body = String(comment?.body || '');
  if (!body.includes(REVIEW_CLAIM_MARKER)) return null;
  return parseReviewClaim(body);
}

export function summarizeFailedTerminalClaims(comments, {
  since = '',
  limit = CLAIM_COMMENT_LIMIT,
} = {}) {
  if (!Array.isArray(comments)) {
    return { measured: false, reason: 'invalid-comments', truncated: false, total: 0, byDay: {} };
  }
  const sinceMs = since ? Date.parse(`${since}T00:00:00Z`) : -Infinity;
  if (since && !Number.isFinite(sinceMs)) {
    return { measured: false, reason: 'invalid-since', truncated: false, total: 0, byDay: {} };
  }
  const byDay = {};
  let total = 0;
  let truncated = false;
  for (const comment of comments) {
    const createdAt = Date.parse(comment?.created_at ?? comment?.createdAt ?? '');
    if (!Number.isFinite(createdAt) || createdAt < sinceMs) continue;
    const event = markerFromComment(comment);
    if (!event || event.state !== 'failed-terminal') continue;
    if (total >= limit) {
      truncated = true;
      continue;
    }
    const day = new Date(createdAt).toISOString().slice(0, 10);
    const cause = normalizeCauseClass(event.causeClass);
    byDay[day] ||= {};
    byDay[day][cause] = (byDay[day][cause] || 0) + 1;
    total += 1;
  }
  return { measured: true, reason: null, truncated, total, byDay };
}

export function fetchReviewClaimComments(since, runGh = gh, {
  repo = REPO,
} = {}) {
  try {
    const pages = runGh([
      'api', '--paginate', '--slurp',
      `repos/${repo}/issues/comments?since=${encodeURIComponent(`${since}T00:00:00Z`)}&per_page=100`,
    ]);
    if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
      return { measured: false, reason: 'invalid-github-response', comments: [], truncated: false };
    }
    const comments = pages.flat();
    if (comments.some((comment) => !comment || typeof comment !== 'object' || Array.isArray(comment))) {
      return { measured: false, reason: 'malformed-comment', comments: [], truncated: false };
    }
    return {
      measured: true,
      reason: null,
      comments: comments.slice(0, CLAIM_COMMENT_LIMIT),
      truncated: comments.length > CLAIM_COMMENT_LIMIT,
    };
  } catch {
    return { measured: false, reason: 'github-api-error', comments: [], truncated: false };
  }
}

export function renderClaimHealth(stats, since) {
  const lines = [`### Review claim failed-terminal — per giorno/classe (dal ${since})`, ''];
  if (!stats?.measured) {
    lines.push(`Dati non misurabili: ${stats?.reason || 'unknown'}.`);
    return lines.join('\n');
  }
  lines.push('| Giorno UTC | Classe di causa | failed-terminal |');
  lines.push('|---|---|---:|');
  const rows = Object.entries(stats.byDay || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([day, causes]) => Object.entries(causes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([cause, count]) => `| ${day} | \`${cause}\` | ${count} |`));
  lines.push(...(rows.length ? rows : ['| (nessuno) | — | 0 |']));
  lines.push('');
  lines.push(`**Totale claim failed-terminal:** ${stats.total}${stats.truncated ? ' (limite di lettura raggiunto)' : ''}.`);
  return lines.join('\n');
}

function main() {
  if (!REPO) {
    console.error('GITHUB_REPOSITORY/GH_REPO mancante');
    process.exit(1);
  }
  const since = isoDaysAgo(DAYS);
  const fetched = fetchReviewClaimComments(since);
  const stats = fetched.measured
    ? summarizeFailedTerminalClaims(fetched.comments, { since, limit: CLAIM_COMMENT_LIMIT })
    : { measured: false, reason: fetched.reason, truncated: fetched.truncated, total: 0, byDay: {} };
  console.log(renderClaimHealth({ ...stats, truncated: stats.truncated || fetched.truncated }, since));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
