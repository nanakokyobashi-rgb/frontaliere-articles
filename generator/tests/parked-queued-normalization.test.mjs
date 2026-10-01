import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  isDrainPromotable,
  isReparkableCandidate,
  isVerdictExitCandidate,
  isRetryCooldownElapsed,
  verdictExitDecision,
} from '../../scripts/ci/followup-drainer.mjs';

const DAY = 86_400_000;
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url)),
  'utf8',
);
const issue = (...labels) => ({
  title: 'follow-up(daily:2026-10-01): 1 item — owner/repo',
  createdAt: '2026-09-20T00:00:00.000Z',
  labels: labels.map((name) => ({ name })),
});

test('#10677: la coda in conflitto resta parked fino al cooldown e poi si normalizza', () => {
  const mixed = issue('follow-up', 'fu-parked', 'agent:fix-queued');
  assert.equal(isReparkableCandidate(mixed), true);
  assert.equal(isDrainPromotable(mixed), false);
  assert.equal(isReparkableCandidate(issue('follow-up', 'agent:fix-queued')), false);

  const significantAt = Date.parse('2026-09-24T00:00:00.000Z');
  const comments = [
    {
      author: { login: 'github-actions' },
      createdAt: '2026-09-25T00:00:00.000Z',
      body: '<!-- followup-mint-gate --> bucket sealed',
    },
    {
      author: { login: 'human-maintainer' },
      createdAt: new Date(significantAt).toISOString(),
      body: 'Contesto ancora valido; riprovare dopo il cooldown.',
    },
    {
      author: { login: 'frontaliere-automation' },
      createdAt: '2026-09-27T00:00:00.000Z',
      body: 'Aggiornamento automatico del bucket.',
    },
  ];
  assert.equal(isRetryCooldownElapsed(mixed, comments, {
    now: significantAt + 4 * DAY,
    cooldownDays: 5,
  }), false);
  assert.equal(isRetryCooldownElapsed(mixed, comments, {
    now: significantAt + 5 * DAY,
    cooldownDays: 5,
  }), true);

  const normalized = {
    ...mixed,
    labels: mixed.labels.filter(({ name }) => name !== 'fu-parked'),
  };
  assert.equal(isDrainPromotable(normalized), true);

  const retryStart = SOURCE.indexOf('// --- PARKED-RETRY:');
  const drainStart = SOURCE.indexOf('// --- DRAIN: promuovi queued a agent:fix');
  assert.ok(retryStart >= 0 && drainStart > retryStart, 'PARKED-RETRY deve precedere il DRAIN');
  const retry = SOURCE.slice(retryStart, drainStart);
  assert.match(retry, /listIssues\(LBL_PARKED\)\.filter\(isReparkableCandidate\)/);
  assert.match(retry, /isRetryCooldownElapsed\(iss, comments, \{ now, cooldownDays: cdDays \}\)/);
  assert.match(retry, /add: \[LBL_QUEUED, `fu-reparked:\$\{gen\}`\]/);
  assert.match(retry, /remove: \[LBL_PARKED, LBL_AUTOMATION_DEFERRED/);
  assert.match(
    SOURCE.slice(drainStart),
    /const pool = listIssues\(LBL_QUEUED\)\.filter\(\(i\) => !has\(i, LBL_PARKED\)\);[\s\S]*?let queued = pool\s*\.filter\(isDrainPromotable\)/,
  );
});

test('#1997/#1495: i verdetti fermi nella coda in conflitto raggiungono VERDICT-EXIT', () => {
  const queuedParked = issue('follow-up', 'fu-parked', 'agent:fix-queued');
  const alreadyFlagged = issue('follow-up', 'fu-parked', 'agent:fix-queued', 'maybe-resolved');
  assert.equal(isReparkableCandidate(queuedParked), true);
  assert.equal(isDrainPromotable(queuedParked), false);
  assert.equal(isVerdictExitCandidate(queuedParked), true);
  assert.equal(isVerdictExitCandidate(alreadyFlagged), true);
  assert.equal(isVerdictExitCandidate(issue('follow-up', 'fu-parked', 'maybe-resolved')), false);
  assert.equal(isVerdictExitCandidate(issue('follow-up', 'agent:fix-queued')), false);
  assert.equal(verdictExitDecision('already-fixed', { noAutoclose: true }).action, 'flag');
  assert.equal(verdictExitDecision('no-root-cause').action, 'escalate');

  const cooldownStart = SOURCE.indexOf('const cdDays = cooldownDaysFor(iss);');
  const cooldownEnd = SOURCE.indexOf('if (commentScans >= RETRY_COMMENT_SCAN_MAX)', cooldownStart);
  const cooldown = SOURCE.slice(cooldownStart, cooldownEnd);
  assert.match(cooldown, /minutesSince\(iss\.updatedAt\) >= cdDays \* 1440 && !has\(iss, LBL_QUEUED\)/);

  const verdictStart = SOURCE.indexOf('// --- VERDICT-EXIT:');
  const verdictEnd = SOURCE.indexOf('// --- TOO-LARGE ESCALATION', verdictStart);
  const verdict = SOURCE.slice(verdictStart, verdictEnd);
  assert.match(verdict, /listIssues\(LBL_PARKED\)\s*\.filter\(isVerdictExitCandidate\)/);
  assert.match(verdict, /remove: clearQueue/);
  assert.match(verdict, /alreadyFlagged \? \[\] : \[LBL_MAYBE_RESOLVED\]/);
});
