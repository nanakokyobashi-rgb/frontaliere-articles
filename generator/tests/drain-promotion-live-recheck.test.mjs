/**
 * drain-promotion-live-recheck.test.mjs — il DRAIN rilegge le label LIVE
 * subito prima di promuovere (follow-up sito #8334, FU-2026-09-12-016).
 *
 * `pool` e' una snapshot presa all'inizio del DRAIN. Prima di questa fix la
 * promozione rileggeva soltanto il claim (`hasActiveAgentClaim`): una
 * `agent:fix` aggiunta da una run concorrente dopo la lettura della coda non
 * fermava la mutazione. Il test difende il predicato e — separatamente — il
 * fatto che ENTRAMBI i punti di promozione passino dalla rilettura.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDrainPromotable, promotionLiveCheck } from '../../scripts/ci/followup-drainer.mjs';

const SRC = readFileSync(
  fileURLToPath(new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url)),
  'utf8',
);

const iss = (...labels) => ({ labels: labels.map((name) => ({ name })) });

test('una coda ancora valida resta promuovibile', () => {
  assert.deepEqual(promotionLiveCheck(iss('agent:fix-queued', 'fu-prio:high')), { ok: true, reason: '' });
});

test('agent:fix comparsa dopo la lettura del pool ferma la promozione (FU-2026-09-12-016)', () => {
  const decision = promotionLiveCheck(iss('agent:fix-queued', 'agent:fix'));
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /agent:fix comparsa/);
});

test('ogni esclusione di isDrainPromotable vale anche sulla rilettura live', () => {
  for (const label of [
    'agent:in-progress',
    'fu-parked',
    'decomposed:1',
    'agent:decompose',
    'agent:decompose-queued',
  ]) {
    const live = iss('agent:fix-queued', label);
    assert.equal(isDrainPromotable(live), false, label);
    assert.equal(promotionLiveCheck(live).ok, false, label);
  }
});

test('coda gia tolta da una run concorrente o label illeggibili: nessuna mutazione', () => {
  assert.equal(promotionLiveCheck(iss('fu-prio:high')).ok, false);
  assert.match(promotionLiveCheck(iss('fu-prio:high')).reason, /gia' rimossa/);
  assert.equal(promotionLiveCheck(null).ok, false);
  assert.equal(promotionLiveCheck({}).ok, false);
});

test('entrambi i punti di promozione del DRAIN passano da promoteToFix', () => {
  const drainStart = SRC.indexOf('// --- DRAIN: promuovi queued a agent:fix');
  assert.notEqual(drainStart, -1);
  const drain = SRC.slice(drainStart);
  assert.equal((drain.match(/promoteToFix\(cand\.number\)/g) || []).length, 2);
  assert.doesNotMatch(drain, /edit(?:Checked)?\(cand\.number, \{ add: \[LBL_FIX\]/);
  const promote = SRC.slice(SRC.indexOf('function promoteToFix('), SRC.indexOf('let automationDeferredLabelReady'));
  assert.match(promote, /promotionLiveCheck\(liveIssueForClaim\(num\)\)/);
  assert.match(promote, /'--add-label', LBL_FIX, '--remove-label', LBL_QUEUED/);
});
