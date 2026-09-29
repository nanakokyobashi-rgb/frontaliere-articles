import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  flattenPaginatedWorkflowRuns,
  promotionBudget,
} from '../../scripts/ci/followup-drainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = readFileSync(path.join(ROOT, 'scripts/ci/followup-drainer.mjs'), 'utf8');

test('#10171: il conteggio issue-fix attraversa tutte le pagine REST', () => {
  const pages = [
    { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) },
    { workflow_runs: [{ id: 101 }, { id: 102 }] },
  ];
  assert.equal(flattenPaginatedWorkflowRuns(pages).length, 102);
  assert.throws(() => flattenPaginatedWorkflowRuns([{ total_count: 0 }]), /workflow_runs/);
});

test('#10171: il cap 15 separa run già vive e slot del tick', () => {
  assert.equal(promotionBudget({ maxInFlight: 15, inFlight: 10 }), 5);
  assert.equal(promotionBudget({ maxInFlight: 15, inFlight: 15 }), 0);
  assert.equal(promotionBudget({ maxInFlight: 15, inFlight: 16 }), 0);
  assert.equal(promotionBudget({ maxInFlight: 15, inFlight: 15, dryRun: true }), 1);
});

test('#10171: la lettura del cap non tronca le run a venti elementi', () => {
  assert.match(
    SOURCE,
    /api', '--paginate', '--slurp',[\s\S]*?actions\/workflows\/issue-fix\.yml\/runs\?status=\$\{status\}&per_page=100/,
  );
  assert.match(SOURCE, /promotionLiveCheck\(liveIssueForClaim\(num\)\)/);
  assert.match(SOURCE, /const promoteBudget = promotionBudget\(/);
});
