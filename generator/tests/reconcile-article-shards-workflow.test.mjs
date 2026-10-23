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
const publisherWorkflow = readFileSync(
  new URL('../../.github/workflows/fast-publish-article.yml', import.meta.url),
  'utf8',
);

test('il backfill aspetta solo il gruppo dello shard target', () => {
  const start = workflow.indexOf('          active_runs_for_shard() {');
  const end = workflow.indexOf('\n\n          # Tetto assoluto', start);
  assert.ok(start >= 0 && end > start, 'il guard per-shard non è riconoscibile');
  const guard = workflow.slice(start, end);

  assert.match(guard, /actions\/runs\/\$run_id\/jobs\?per_page=100/);
  assert.match(workflow, /IN_FLIGHT_STATUSES='\["queued","in_progress","requested","waiting","pending"\]'/);
  assert.match(guard, /--argjson in_flight "\$IN_FLIGHT_STATUSES"/);
  assert.match(guard, /\.id \| type/);
  assert.match(guard, /\.status \| type/);
  assert.match(guard, /\.name \| type/);
  assert.match(guard, /\.display_title \| type/);
  assert.match(guard, /echo 999/);
  assert.match(guard, /publish \(shard, " \+ \$shard \+ "\)/);
  assert.match(guard, /unknown\|no-active-job/);
  assert.match(
    guard,
    /gh api --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$WF\/runs\?per_page=100"/,
  );
  assert.match(
    guard,
    /gh api --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$run_id\/jobs\?per_page=100"/,
  );
  assert.match(guard, /workflow_runs \| length/);
  assert.match(guard, /total_count/);
  assert.match(guard, /\.name == "resolve"/);
  assert.doesNotMatch(guard, /\.status == "queued" or \.status == "in_progress"/);
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
  assert.match(
    workflow,
    /\.selected\[\].*\[\.id, \.section, \.shard\]/,
  );
  assert.doesNotMatch(workflow, /active_runs\(\)/, 'il gate non deve tornare a contare il workflow globalmente');
});
