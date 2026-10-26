/**
 * Il backfill del contenuto sporco deve rispettare la stessa granularità della
 * concurrency del publisher: una run attiva su uno shard diverso non deve
 * consumare il budget del backfill corrente.
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync(
  new URL('../../.github/workflows/republish-dirty-content.yml', import.meta.url),
  'utf8',
);

test('il backfill aspetta solo il gruppo dello shard target', () => {
  const start = workflow.indexOf('          active_runs_for_shard() {');
  const end = workflow.indexOf('\n\n          # Tetto assoluto', start);
  assert.ok(start >= 0 && end > start, 'il guard per-shard non è riconoscibile');
  const validation = workflow.slice(0, start);
  const guard = workflow.slice(start, end);

  assert.match(validation, /api_timeout_seconds=60/);
  assert.match(validation, /timeout --kill-after=5s "\$\{api_timeout_seconds\}s" gh api "\$@"/);
  assert.doesNotMatch(workflow, /^\s+gh api\b/m, 'nessuna chiamata deve bypassare il wrapper');
  assert.equal(
    (workflow.match(/gh_api_timeout(?:\s|\()/g) || []).length,
    8,
    'sette chiamate più la definizione devono restare protette',
  );
  assert.match(guard, /actions\/runs\/\$run_id\/jobs\?per_page=100/);
  assert.match(
    guard,
    /gh_api_timeout --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$WF\/runs\?per_page=100"/,
  );
  assert.match(validation, /workflow_runs \| length/);
  assert.match(validation, /total_count/);
  assert.match(validation, /\.created_at \| type/);
  assert.match(validation, /try \(\.created_at \| fromdateiso8601\)/);
  assert.match(guard, /\.name == "resolve"/);
  assert.match(validation, /IN_FLIGHT_STATUSES=/);
  assert.match(validation, /validate_workflow_runs\(\)/);
  assert.match(validation, /validate_workflow_jobs\(\)/);
  assert.ok(guard.includes('test("^publish \\\\(shard, .+\\\\)$")'));
  assert.match(guard, /\.name == \("publish \(shard, " \+ \$shard \+ "\)"\)/);
  assert.match(guard, /\(\$in_flight \| index\(\$status\)\) != null/);
  assert.doesNotMatch(guard, /\.status == "queued" or \.status == "in_progress"/);
  assert.match(guard, /run_event.*workflow_dispatch/);
  assert.match(guard, /cover-publish-article\[\[:space:\]\]/);
  assert.match(guard, /dispatch_section="\$\{BASH_REMATCH\[1\]\}"/);
  assert.match(guard, /dispatch_section.*!= "auto"/);
  assert.match(
    workflow,
    /target_shard="\$\(node scripts\/ci\/fast-publish-section\.mjs shard-of "\$section"/,
  );
  assert.match(
    workflow,
    /while \[ "\$\(active_runs_for_shard "\$section" "\$target_shard"\)" -gt 0 \]/,
  );
  assert.match(workflow, /dispatch_nonce="dirty-content-\$\{GITHUB_RUN_ID\}-/);
  assert.match(workflow, /-f "inputs\[dispatch_nonce\]=\$dispatch_nonce"/);
  assert.match(workflow, /--arg nonce "\$dispatch_nonce"/);
  assert.match(workflow, /contains\("nonce=" \+ \$nonce\)/);
  assert.match(workflow, /recent_pages_json=.*gh_api_timeout --paginate --slurp/);
  assert.match(
    workflow,
    /if ! gh_api_timeout -X POST "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$WF\/dispatches"/,
  );
  assert.match(
    workflow,
    /printf '%s\\t%s\\t%s\\n' "\$id" "\$section" "lost" >> "\$results"/,
  );
  assert.match(workflow, /recent_runs_json=.*validate_workflow_runs/);
  assert.match(workflow, /\.created_at \| fromdateiso8601/);
  assert.doesNotMatch(workflow, /created_at >= \$before/);
  assert.doesNotMatch(workflow, /active_runs\(\)/, 'il gate non deve tornare a contare il workflow globalmente');
});
