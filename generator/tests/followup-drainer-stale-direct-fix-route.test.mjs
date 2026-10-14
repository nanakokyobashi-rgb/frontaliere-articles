import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isStaleDirectFixRouteCandidate,
  staleDirectFixRouteDecision,
} from '../../scripts/ci/followup-drainer.mjs';

const decisionReady = {
  inFlight: 0,
  liveClaimAllowed: true,
  hasOpenPr: false,
  settling: false,
};

function issue(number, title, labels) {
  return { number, title, labels };
}

test('#649: il digest no-age-out con agent:fix stale è riconciliabile', () => {
  const digest = issue(649, '🧭 Decisioni del proprietario — digest', [
    'agent:triaged', 'agent:fix', 'fu-prio:low', 'needs-human', 'automation', 'agent:no-age-out',
  ]);

  assert.equal(isStaleDirectFixRouteCandidate(digest), true);
  assert.deepEqual(staleDirectFixRouteDecision(digest, decisionReady), {
    action: 'dequeue',
    reason: 'la classificazione corrente restituisce route none',
  });
});

test('#1644 e #2627 non entrano nel pass senza una route diretta stale', () => {
  const healthTracker = issue(1644, '📊 Loop health report (tracker)', [
    'agent:triaged', 'automation', 'agent:no-age-out',
  ]);
  const evergreenContainer = issue(2627, 'evergreen-refresh residuo lotto 2 — contenitore residuo', [
    'agent:triaged', 'fu-prio:low', 'automation-deferred',
  ]);

  assert.equal(isStaleDirectFixRouteCandidate(healthTracker), false);
  assert.equal(isStaleDirectFixRouteCandidate(evergreenContainer), false);
});

test('un lavoro ancora instradabile non viene tolto da agent:fix', () => {
  const publishWork = issue(9001, 'Workflow Failure: Publish article data API', ['agent:fix']);
  const queuedWork = issue(9002, 'Generator CI: output validation', ['agent:fix']);

  assert.equal(isStaleDirectFixRouteCandidate(publishWork), false);
  assert.equal(isStaleDirectFixRouteCandidate(queuedWork), false);
  assert.equal(staleDirectFixRouteDecision(publishWork, decisionReady).action, 'keep');
});

test('il cleanup diretto resta fail-closed su run, claim, PR e settling', () => {
  const digest = issue(649, '🧭 Decisioni del proprietario — digest', [
    'agent:fix', 'needs-human', 'agent:no-age-out',
  ]);

  assert.equal(staleDirectFixRouteDecision(digest).action, 'wait', 'run non misurata');
  assert.equal(staleDirectFixRouteDecision(digest, { ...decisionReady, inFlight: 1 }).action, 'wait');
  assert.equal(staleDirectFixRouteDecision(digest, { ...decisionReady, liveClaimAllowed: false }).action, 'keep');
  assert.equal(staleDirectFixRouteDecision(digest, { ...decisionReady, hasOpenPr: true }).action, 'keep');
  assert.equal(staleDirectFixRouteDecision(digest, { ...decisionReady, hasOpenPr: null }).action, 'keep', 'PR non verificabile');
  assert.equal(staleDirectFixRouteDecision(digest, { ...decisionReady, settling: true }).action, 'wait');
});

test('coda già queued e claim espliciti restano fuori dalla riconciliazione diretta', () => {
  const queuedPin = issue(649, '🧭 Decisioni del proprietario — digest', [
    'agent:fix', 'agent:fix-queued', 'agent:no-age-out',
  ]);
  const claimedPin = issue(649, '🧭 Decisioni del proprietario — digest', [
    'agent:fix', 'agent:no-age-out', 'agent:in-progress',
  ]);

  assert.equal(isStaleDirectFixRouteCandidate(queuedPin), false);
  assert.equal(isStaleDirectFixRouteCandidate(claimedPin), false);
});
