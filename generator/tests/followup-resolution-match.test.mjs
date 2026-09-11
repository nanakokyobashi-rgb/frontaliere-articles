/**
 * followup-resolution-match.test.mjs — `closedIssueRefs`/`closingMergedPr`
 * had zero test coverage (issue #567: `grep -rl closedIssueRefs
 * generator/tests/*.test.mjs` returned nothing). The concrete gap: PR #418
 * declared "Chiude anche la issue #402" in its body — a real, unambiguous
 * Italian closure declaration — and `CLOSE_KW_LIST` (English-keyword-only)
 * never matched it, so `closingMergedPr()` (SIGNAL 1 of the already-resolved
 * pre-flight, `check-issue-already-resolved.mjs`) never short-circuited: #402
 * stayed `agent:fix` through 6 wasted fixer runs after the fix had already
 * merged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  citedFiles,
  closingMergedPr,
  closedIssueRefs,
  detectAlreadyResolved,
} from '../../scripts/ci/followup-resolution-match.mjs';

test('legacy quoted source paths remain file locators without widening token scope', () => {
  const target = '.github/workflows/crawler-group-01.yml';
  const body = [
    '### 1. Legacy crawler item',
    '- Original text:',
    `  > \`${target}:L261-L267\`: the old call site drops the exit code`,
    '- Suggested action: preserve `git-commit-data.sh --extra-only` while handling its result.',
  ].join('\n');

  assert.deepEqual(citedFiles(body, (path) => path === target), [target]);
  const result = detectAlreadyResolved(body, {
    fileExists: (path) => path === target,
    readFile: () => 'git-commit-data.sh --extra-only',
  });
  assert.equal(result.resolved, true);
});

test('plain paths in Suggested action are resolved as locators', () => {
  const target = 'scripts/ci/verify-crawler-contract-provenance.mjs';
  const body = [
    '### 1. Runtime provenance item',
    `- Suggested action: extend (${target}) with \`createRawFetcher(\` and \`CONTRACT.siteRuntimePaths\`.`,
  ].join('\n');

  assert.deepEqual(citedFiles(body, (path) => path === target), [target]);
  const result = detectAlreadyResolved(body, {
    fileExists: (path) => path === target,
    readFile: () => 'createRawFetcher( CONTRACT.siteRuntimePaths',
  });
  assert.equal(result.resolved, true);
});

test('Italian "Chiude anche la issue #N" is recognized — the exact PR #418 shape', () => {
  const body = 'Chiude anche la issue #402, ferma con `agent:fix` e 6 run del fixer a vuoto.';
  assert.deepEqual(closedIssueRefs(body), [402]);
});

test('Italian bare "chiude #N" (no filler) is recognized', () => {
  assert.deepEqual(closedIssueRefs('chiude #402'), [402]);
});

test('Italian "risolve"/"supera" are recognized as closing keywords', () => {
  assert.deepEqual(closedIssueRefs('Risolve #10'), [10]);
  assert.deepEqual(closedIssueRefs('Supera #20'), [20]);
});

test('Italian filler is bounded to the known bridge words — a real sentence does not bridge to a later #N', () => {
  // "Chiude il problema descritto ma non tocca #402" — "il problema descritto
  // ma non tocca" is prose, not one of the bridge words ("anche"/"la"/"le"/
  // "issue"), so it must NOT bridge the verb to #402: same guarantee as the
  // English "Fixes #8 and touches #N" case below.
  assert.deepEqual(closedIssueRefs('Chiude il problema descritto ma non tocca #402'), []);
});

test('a mid-word Italian substring is not a keyword ("racchiude" is not "chiude")', () => {
  assert.deepEqual(closedIssueRefs('Il problema racchiude molte cose #402'), []);
});

test('regression: multi-issue "Closes #a #b #c" still matches every ref in the list', () => {
  assert.deepEqual(closedIssueRefs('Closes #1, #2 and #3'), [1, 2, 3]);
});

test('regression: "Fixes #8 and touches #N" — the word "touches" still breaks the run', () => {
  assert.deepEqual(closedIssueRefs('Fixes #8 and touches #9'), [8]);
});

test('regression: English keywords in every case still match', () => {
  assert.deepEqual(closedIssueRefs('Closes #1\nfixes #2\nRESOLVED: #3\nSupersedes #4'), [1, 2, 3, 4]);
});

test('closingMergedPr finds the declaring PR via the Italian form', () => {
  const mergedPrs = [{ number: 418, title: 'Haiku sul corpo (#379, #402)', body: 'Chiude anche la issue #402.' }];
  assert.equal(closingMergedPr(402, mergedPrs), 418);
});

test('closingMergedPr returns null when no merged PR declares closure', () => {
  const mergedPrs = [{ number: 1, title: 'Altro', body: 'Vedi #402 per contesto' }];
  assert.equal(closingMergedPr(402, mergedPrs), null);
});
