import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github/workflows/jobs-pipeline-queue-monitor.yml'),
  'utf8',
);
const OBSERVER_PATH = 'scripts/monitor-jobs-pipeline-queue.mjs';

function sparseCheckoutEntries(workflow) {
  const block = workflow.match(
    /sparse-checkout:\s*\|\n([\s\S]*?)\n\s*sparse-checkout-cone-mode:/,
  )?.[1];
  assert.ok(block, 'sparse-checkout dell observer non trovato');
  return block.split('\n').map((line) => line.trim()).filter(Boolean);
}

test('il queue monitor usa il path reale del sorgente site nello sparse checkout', () => {
  const entries = sparseCheckoutEntries(WORKFLOW);
  assert.ok(entries.includes(OBSERVER_PATH), `sparse-checkout senza ${OBSERVER_PATH}`);
  assert.ok(entries.includes('scripts/lib'), 'sparse-checkout senza gli helper dell observer');
  assert.ok(entries.includes('scripts/ci/lib'), 'sparse-checkout senza gli helper CI dell observer');

  const invocation = WORKFLOW.match(
    /^\s*run:\s+node\s+observer-source\/([^\s]+)\s*$/m,
  )?.[1];
  assert.equal(invocation, OBSERVER_PATH);
  assert.doesNotMatch(WORKFLOW, /scripts\/ci\/monitor-jobs-pipeline-queue\.mjs/);
});
