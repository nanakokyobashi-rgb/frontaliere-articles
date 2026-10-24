/**
 * Il reconciler deve rispettare la stessa granularità della concurrency del
 * publisher: una run attiva su uno shard diverso non deve bloccare un
 * backfill per lo shard target. La prova runtime arriva da Actions; questo
 * gate impedisce che il filtro torni accidentalmente globale o fail-open.
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync(
  new URL('../../.github/workflows/reconcile-article-shards.yml', import.meta.url),
  'utf8',
);
const publisherWorkflow = readFileSync(
  new URL('../../.github/workflows/fast-publish-article.yml', import.meta.url),
  'utf8',
);

test('il backfill aspetta solo il gruppo dello shard target', () => {
  const start = workflow.indexOf('          active_runs_for_shard() {');
  const end = workflow.indexOf('\n\n          # Tetto assoluto', start);
  assert.ok(start >= 0 && end > start, 'il guard per-shard non è riconoscibile');
  const guard = workflow.slice(start, end);

  assert.match(guard, /actions\/workflows\/\$WF\/runs\?per_page=100/);
  assert.match(guard, /actions\/runs\/\$run_id\/jobs\?per_page=100/);
  assert.match(
    workflow,
    /IN_FLIGHT_STATUSES='\["queued","in_progress","requested","waiting","pending"\]'/,
  );
  assert.match(guard, /--argjson in_flight "\$IN_FLIGHT_STATUSES"/);
  assert.match(guard, /\.id \| type/);
  assert.match(guard, /\.status \| type/);
  assert.match(guard, /\.name \| type/);
  assert.match(guard, /\.display_title \| type/);
  assert.match(guard, /echo 999/);
  assert.match(guard, /publish \(shard, " \+ \$shard \+ "\)/);
  assert.match(guard, /publish-other"\) then "occupied"/);
  assert.doesNotMatch(
    guard,
    /publish-other"\) then "free"/,
    'un publish di un altro shard in-flight deve bloccare la matrice ancora incompleta',
  );
  assert.match(guard, /unknown\|no-active-job/);
  assert.match(guard, /run_event.*workflow_dispatch/);
  assert.match(guard, /cover-publish-article\[\[:space:\]\]/);
  assert.match(guard, /dispatch_section="\$\{BASH_REMATCH\[1\]\}"/);
  assert.match(guard, /dispatch_section.*!= "auto"/);
  assert.match(
    publisherWorkflow,
    /\n  publish:\n    name: publish \(shard, \$\{\{ matrix\.target\.shard \}\}\)\n/,
  );
  assert.match(
    workflow,
    /while \[ "\$\(active_runs_for_shard "\$section" "\$target_shard"\)" -gt 0 \]/,
  );
  assert.match(workflow, /\.selected\[\] \| \[\.id, \.section, \.shard\]/);
  assert.doesNotMatch(
    workflow,
    /active_runs\(\)/,
    'il gate non deve tornare a contare il workflow globalmente',
  );
});
