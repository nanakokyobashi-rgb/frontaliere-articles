/**
 * The follow-up matcher carries the site locator contract into the corpus
 * while retaining corpus-specific acceptance behavior, so its manifest entry
 * is an `adapted` twin.
 *
 * This file used to pin the exact baseline of 2026-09-13 (site digest, corpus
 * digest equal to the file on disk, and the date). That snapshot cannot hold
 * with the way an adapted twin is realigned (issue 1997): a PR that ports site
 * changes edits the file and declares `Realign-adapted:` in its body WITHOUT
 * touching the manifest, and after the merge `realign-adapted-baseline.mjs`
 * rewrites both digests and the date. The pin was therefore red in the porting
 * PR (file moved, manifest not yet) and would have been red on `main` after
 * every realignment (site digest and date moved). What it protected is kept
 * here as invariants that stay true across a realignment; whether the file
 * and the baseline agree byte for byte is the drift check's job
 * (`loop-drift-check.mjs`, with the adapted ratchet).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELATIVE_PATH = 'scripts/ci/followup-resolution-match.mjs';
/** The alignment this entry was first recorded with: a realignment only moves forward. */
const FIRST_ALIGNED_AT = '2026-09-13';
const DIGEST_RE = /^[0-9a-f]{16}$/;

/**
 * The export surface shared with the site twin (50 names on both sides when
 * site PRs 8570, 8632, 8686, 10829 and 11232 were ported). A site change that
 * adds an export is ported here together with this list; dropping one of
 * these from the corpus twin breaks a consumer that the site contract feeds.
 */
const SITE_CONTRACT_EXPORTS = [
  'ACCEPTANCE_CONDITION', 'AGGREGATE_ITEM_COUNT_RE', 'AGGREGATE_KEYWORD_RE', 'bucketState',
  'canonicalDailyBuckets', 'citedFiles', 'citedTokens', 'closedIssueRefs', 'closingMergedPr',
  'COMMAND_CONDITION', 'commandReferent', 'countAggregateHeadingItems', 'dailyBucketIdentity',
  'dailyBucketInfo', 'dailyBucketSourcePrNumbers', 'dailyBucketTargetRepository',
  'dailyBucketTitle', 'dailyItemFingerprint', 'dailyKeyFromBucketBody', 'dailyKeyZurich',
  'dedupeDailyItems', 'detectAlreadyResolved', 'FOLLOWUP_DAILY_TIME_ZONE', 'FOLLOWUP_ITEM_ID_RE',
  'FOLLOWUP_ITEM_ID_SINGLE_RE', 'followupFingerprint', 'followupItemDailyKey', 'followupItemId',
  'followupItemMarkers', 'hasDailyBucketRepositoryConsistency', 'hasEnumeratedItems',
  'hasFalsifiableAcceptance', 'hasStableItemIds', 'hasStableItemIdsForDailyKey',
  'hasUnterminatedMarkdownFence', 'isDailyBucketTitle', 'isDistinctiveToken',
  'maskInlineCodeSpans', 'mergeDailyItemSources', 'metricAlreadyGreen', 'mostSpecificToken',
  'normalizeAcceptanceToken', 'normalizeFingerprintPart', 'parseFollowupItems', 'schedaCommand',
  'selectFirstOpenItem', 'splitFollowupItems', 'stripFencedBlocks', 'suggestedActionText',
  'updateFollowupItemState',
];

test('follow-up matcher stays a declared adapted twin with a well-formed, forward-only baseline', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const entries = manifest.files.filter((file) => file.path === RELATIVE_PATH);

  assert.equal(entries.length, 1, 'una sola voce di manifest per il matcher');
  const [entry] = entries;
  assert.equal(entry.mode, 'adapted');
  assert.ok((entry.reason || '').trim().length > 0, 'un gemello adapted dichiara quale differenza resta');
  assert.match(entry.baseline?.site ?? '', DIGEST_RE);
  assert.match(entry.baseline?.corpus ?? '', DIGEST_RE);
  // Two equal digests would mean the adaptation is gone: that is a change of
  // mode to decide on purpose, not something a realignment may leave behind.
  assert.notEqual(entry.baseline.site, entry.baseline.corpus);
  assert.match(entry.baseline?.alignedAt ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    entry.baseline.alignedAt >= FIRST_ALIGNED_AT,
    `la baseline non puo' tornare prima del ${FIRST_ALIGNED_AT} (trovato ${entry.baseline.alignedAt})`,
  );
});

test('the corpus twin keeps every export of the site locator contract', async () => {
  const twin = await import(pathToFileURL(path.join(ROOT, RELATIVE_PATH)).href);
  const missing = SITE_CONTRACT_EXPORTS.filter((name) => !(name in twin));

  assert.equal(SITE_CONTRACT_EXPORTS.length, 50);
  assert.deepEqual(missing, []);
  for (const name of ['stripFencedBlocks', 'countAggregateHeadingItems', 'dedupeDailyItems', 'parseFollowupItems']) {
    assert.equal(typeof twin[name], 'function', name);
  }
});
