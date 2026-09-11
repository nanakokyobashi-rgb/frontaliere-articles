/**
 * Regressioni #1078 item 3: un comment lookup illeggibile resta fail-open per
 * la singola issue, ma una causa persistente deve rendere il run osservabile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decideReconcileAction,
  isCommentLookupDegraded,
} from '../../scripts/ci/reconcile-followups.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts/ci/reconcile-followups.mjs'), 'utf8');

test('#1078 item 3: hasPriorFlag null non autorizza flag o chiusura', () => {
  assert.equal(decideReconcileAction({
    resolved: true,
    hasMaybeResolved: false,
    hasPriorFlag: null,
    isAggregate: false,
    blocked: false,
    strongEvidence: true,
  }), 'none');
});

test('#1078 item 3: i fallimenti dei commenti hanno una soglia osservabile', () => {
  assert.equal(isCommentLookupDegraded(0, 10), false);
  assert.equal(isCommentLookupDegraded(2, 10, { minCount: 3, maxRatio: 0.5 }), false);
  assert.equal(isCommentLookupDegraded(3, 10, { minCount: 3, maxRatio: 0.5 }), true);
  assert.equal(
    isCommentLookupDegraded(1, 1, { minCount: 3, maxRatio: 0.5 }),
    true,
    'se ogni lookup del run fallisce, anche una sola issue non può restare invisibile',
  );
  assert.match(SOURCE, /commentLookupFailed\+\+/);
  assert.match(SOURCE, /process\.exitCode = 1/);
});
