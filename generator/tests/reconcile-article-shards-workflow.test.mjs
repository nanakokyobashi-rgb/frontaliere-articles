/**
 * Il reconciler deve rispettare la stessa granularità della concurrency del
 * publisher: una run attiva su articolifrontaliere non deve bloccare un
 * backfill per articolisvizzera. La prova runtime arriva da Actions; questo
 * gate impedisce che il filtro torni accidentalmente globale.
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync(
  new URL('../../.github/workflows/reconcile-article-shards.yml', import.meta.url),
  'utf8',
);

test('il backfill aspetta solo il gruppo dello shard target', () => {
  const start = workflow.indexOf('          active_runs_for_shard() {');
  const end = workflow.indexOf('\n\n          # Tetto assoluto', start);
  assert.ok(start >= 0 && end > start, 'il guard per-shard non è riconoscibile');
  const guard = workflow.slice(start, end);

  assert.match(guard, /actions\/runs\/\$run_id\/jobs\?per_page=100/);
  assert.match(guard, /\.name == "resolve"/);
  assert.match(guard, /endswith\(", " \+ \$shard \+ "\)"\)/);
  assert.match(guard, /run_event.*workflow_dispatch/);
  assert.match(
    workflow,
    /while \[ "\$\(active_runs_for_shard "\$section" "\$target_shard"\)" -gt 0 \]/,
  );
  assert.match(
    workflow,
    /\.selected\[\].*\[\.id, \.section, \.shard\]/,
  );
  assert.doesNotMatch(workflow, /active_runs\(\)/, 'il gate non deve tornare a contare il workflow globalmente');
});
