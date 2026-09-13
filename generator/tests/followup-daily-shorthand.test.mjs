import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bucketState,
  dailyKeyFromBucketBody,
  hasDailyBucketRepositoryConsistency,
  parseFollowupItems,
  selectFirstOpenItem,
} from '../../scripts/ci/followup-resolution-match.mjs';
import { decideDailyMintGate } from '../../scripts/ci/gate-minted-followups.mjs';
import {
  dailyBucketCloseGate,
  hasStrongDailyAcceptanceEvidence,
  reconcileDailyItems,
} from '../../scripts/ci/reconcile-followups.mjs';

const DAY = '2026-09-12';
const TITLE = `follow-up(daily:${DAY}): 1 item — owner/repo`;
const BODY = [
  'State: collecting',
  '',
  '## Origine',
  '- PR: #1398',
  '',
  '## Item',
  `### FU-${DAY}-001 — shorthand bucket`,
  '- Target repository: owner/repo',
  '- Target file: scripts/example.mjs',
  '- Sources: PR #1398',
  '- Suggested action: verificare `firstGuard()` in scripts/example.mjs',
  '- Acceptance token: `firstGuard()`',
  '',
].join('\n');

test('il gate recupera un daily shorthand e apre gli item senza State', () => {
  assert.equal(bucketState(BODY), 'collecting');
  assert.equal(dailyKeyFromBucketBody(BODY), DAY);
  assert.equal(hasDailyBucketRepositoryConsistency(BODY, 'owner/repo'), true);
  assert.equal(parseFollowupItems(BODY)[0].state, null);

  const decision = decideDailyMintGate({ title: TITLE, body: BODY }, { triageComplete: true });
  assert.equal(decision.action, 'seal');
  assert.equal(bucketState(decision.body), 'sealed');
  assert.equal(parseFollowupItems(decision.body).every((item) => item.state === 'open'), true);
  assert.equal(selectFirstOpenItem(decision.body)?.id, `FU-${DAY}-001`);

  const fencedExample = BODY.replace(
    '- Suggested action: verificare `firstGuard()` in scripts/example.mjs',
    '- Suggested action: verificare `firstGuard()` in scripts/example.mjs\n```md\n- State: blocked\n```',
  );
  const fencedDecision = decideDailyMintGate({ title: TITLE, body: fencedExample }, { triageComplete: true });
  assert.equal(fencedDecision.action, 'seal');
  assert.equal(selectFirstOpenItem(fencedDecision.body)?.id, `FU-${DAY}-001`);
});

test('il reconciler usa l acceptance token strutturale del daily item', () => {
  const body = BODY.replace('State: collecting', 'State: sealed')
    .replace('- Suggested action: verificare `firstGuard()` in scripts/example.mjs',
      '- Suggested action: verificare `firstGuard()` in scripts/example.mjs\n- State: open');
  const result = reconcileDailyItems(body, {
    fileExists: (path) => path === 'scripts/example.mjs',
    readFile: () => 'const value = firstGuard(input);',
  }, DAY, 'owner/repo', 1);

  assert.equal(result.changed, true);
  assert.equal(parseFollowupItems(result.body)[0].state, 'done');
  assert.deepEqual(result.changes[0].evidence, [{ file: 'scripts/example.mjs', tok: 'firstGuard()' }]);

  const gate = dailyBucketCloseGate(result.body, {
    fileExists: (path) => path === 'scripts/example.mjs',
    readFile: () => 'const value = firstGuard(input);',
  }, DAY, 'owner/repo', 1);
  assert.equal(gate.blocks, false, 'un token Acceptance stabile è evidenza forte per l item');
  assert.equal(
    hasStrongDailyAcceptanceEvidence(parseFollowupItems(result.body), result.changes[0].evidence),
    true,
  );
});
