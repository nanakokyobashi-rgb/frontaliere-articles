/** Owner policy: tests run in CI, but are excluded from model review. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchPrFiles } from './lib/fetchPrFiles.mjs';

export const TEST_REVIEW_MARKER = '<!-- TEST_ONLY_AUTOMATIC_REVIEW -->';
export const REVIEW_INPUT_REVISION_MARKER_RE = /<!--\s*REVIEW_INPUT_REVISION:\s*(body:[0-9a-f]{64})\s*-->/giu;
export const REVIEW_INPUT_REVISION_RE = /^body:[0-9a-f]{64}$/iu;
const TEST_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'd.ts', 'd.mts', 'd.cts'];
export const TEST_PATH_RE = new RegExp('(?:^|/)(?:tests|__tests__)/|\\.(?:test|spec)\\.(?:'
  + TEST_EXTENSIONS.map(ext => ext.replaceAll('.', '\\.')).join('|') + ')$');
export const TEST_DIFF_EXCLUSIONS = [
  ':(glob,exclude)**/tests/**', ':(glob,exclude)**/__tests__/**',
  ...TEST_EXTENSIONS.flatMap(ext =>
    ['test', 'spec'].map(kind => `:(glob,exclude)**/*.${kind}.${ext}`)),
];
export const isReviewTestPath = path => typeof path === 'string' && TEST_PATH_RE.test(path);
export function isTestOnlySnapshot(snapshot) {
  return snapshot?.complete === true && Array.isArray(snapshot.files)
    && snapshot.files.length > 0 && snapshot.files.every(isReviewTestPath);
}
export function gh(args, { json = true, allowFail = false, input } = {}) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input });
    return json ? JSON.parse(out) : out;
  } catch (error) { if (allowFail) return null; throw error; }
}
export function verifyTestOnlyHead(ghFn, repo, pr, head) {
  const current = () => ghFn(['api', `repos/${repo}/pulls/${pr}`]);
  const before = current();
  if (before.state !== 'open' || before.head?.sha !== head) return false;
  const snapshot = fetchPrFiles(pr, ghFn, repo);
  if (!isTestOnlySnapshot(snapshot)) return false;
  // A rename into tests still removes application code at its old path.
  const pages = ghFn(['api', `repos/${repo}/pulls/${pr}/files`, '--paginate', '--slurp']);
  if (!Array.isArray(pages)) return false;
  const entries = pages.flat();
  const names = new Set(snapshot.files);
  const onlyTests = entries.length === names.size && entries.every(file => names.has(file.filename)
    && isReviewTestPath(file.filename) && (!file.previous_filename || isReviewTestPath(file.previous_filename)));
  const after = current();
  return onlyTests && after.state === 'open' && after.head?.sha === head && before.base?.sha === after.base?.sha;
}

export function normalizeReviewInputRevision(reviewRevision) {
  const revision = String(reviewRevision ?? '').trim().toLowerCase();
  return REVIEW_INPUT_REVISION_RE.test(revision) ? revision : revision ? null : '';
}

/** The review verdict must identify the exact trusted PR-body revision. */
export function reviewInputRevisionMarker(reviewRevision = '') {
  const revision = normalizeReviewInputRevision(reviewRevision);
  if (revision === null) throw new Error('Invalid review input revision');
  return revision ? `<!-- REVIEW_INPUT_REVISION: ${revision} -->` : '';
}

/**
 * A matching marker is necessary, and conflicting revision markers are not
 * accepted. With no expected revision this remains backward-compatible for
 * callers that do not run in the body-revision-aware workflow.
 */
export function reviewHasInputRevision(body, expectedRevision = '') {
  const expected = normalizeReviewInputRevision(expectedRevision);
  if (expected === null) return false;
  if (!expected) return true;
  const markers = [...String(body ?? '').matchAll(REVIEW_INPUT_REVISION_MARKER_RE)]
    .map(match => String(match[1]).toLowerCase());
  return markers.length > 0 && new Set(markers).size === 1 && markers[0] === expected;
}

export function findTestOnlyApproval(reviews, head, {
  ghFn = gh,
  repo,
  pr,
  reviewRevision = process.env.REVIEW_REVISION || '',
} = {}) {
  const candidates = (reviews ?? []).flat().filter(review => review.user?.type === 'Bot'
    && /^(github-actions|frontaliere-automation)\[bot\]$/.test(review.user.login ?? '')
    && review.commit_id === head && String(review.body ?? '').includes(TEST_REVIEW_MARKER)
    && reviewHasInputRevision(review.body, reviewRevision)
    && /^## LGTM\s*$/m.test(review.body) && !/🔴/.test(review.body));
  if (!candidates.length || !verifyTestOnlyHead(ghFn, repo, pr, head)) return null;
  return candidates.at(-1);
}
export function postTestOnlyReview({
  repo,
  pr,
  head,
  ghFn = gh,
  reviewRevision = process.env.REVIEW_REVISION || '',
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^\d+$/.test(String(pr)) || !/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Invalid review target');
  const revisionMarker = reviewInputRevisionMarker(reviewRevision);
  if (!verifyTestOnlyHead(ghFn, repo, pr, head)) throw new Error('PR is not a complete tests-only change on the expected HEAD');
  const reviews = ghFn(['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate']);
  if (findTestOnlyApproval(reviews, head, { ghFn, repo, pr, reviewRevision })) return;
  const body = [
    TEST_REVIEW_MARKER,
    revisionMarker,
    '## Scope',
    'Approvazione automatica: la PR modifica esclusivamente test. I controlli CI e il contratto del body restano obbligatori; nessuna review del modello richiesta dalla policy del proprietario.',
    '',
    '## Findings (Important: 0, Nit: 0)',
    '',
    '## LGTM',
    '',
  ].join('\n');
  ghFn(['api', `repos/${repo}/pulls/${pr}/reviews`, '--method', 'POST', '--input', '-'], {
    input: JSON.stringify({ commit_id: head, event: 'COMMENT', body }),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'filter') {
    const names = readFileSync(0, 'utf8').split(/\r?\n/).filter(name => name && !isReviewTestPath(name));
    process.stdout.write(names.length ? names.join('\n') + '\n' : '');
  } else if (process.argv[2] === 'only') {
    process.exitCode = isTestOnlySnapshot(JSON.parse(readFileSync(0, 'utf8'))) ? 0 : 1;
  } else if (process.argv[2] === 'check') {
    process.exitCode = verifyTestOnlyHead(gh, process.env.REPO || process.env.GITHUB_REPOSITORY, process.env.PR_NUMBER, process.env.HEAD_SHA) ? 0 : 1;
  } else if (process.argv[2] === 'post') {
    postTestOnlyReview({ repo: process.env.REPO || process.env.GITHUB_REPOSITORY, pr: process.env.PR_NUMBER, head: process.env.HEAD_SHA });
  } else throw new Error('Usage: review-test-policy.mjs filter|only|check|post');
}
