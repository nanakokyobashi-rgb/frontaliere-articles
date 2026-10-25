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
const republishWorkflow = readFileSync(
  new URL('../../.github/workflows/republish-dirty-content.yml', import.meta.url),
  'utf8',
);
const generationWorkflow = readFileSync(
  new URL('../../.github/workflows/generate-article.yml', import.meta.url),
  'utf8',
);
const generationCoreWorkflow = readFileSync(
  new URL('../../.github/workflows/generate-article-core.yml', import.meta.url),
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
  assert.match(workflow, /\[\$pages\[\]\.workflow_runs\[\]\.id\] \| unique \| length/);
  assert.match(guard, /\[\$pages\[\]\.jobs\[\]\.id\] \| unique \| length/);
  assert.match(workflow, /\.display_title \| type/);
  assert.match(workflow, /\.created_at \| type/);
  assert.match(workflow, /try \(\.created_at \| fromdateiso8601\)/);
  assert.match(workflow, /created_at_epoch/);
  assert.match(guard, /echo 999/);
  assert.match(guard, /publish \(shard, " \+ \$shard \+ "\)/);
  assert.match(guard, /publish-other"\) then "free"/);
  assert.match(guard, /unknown\|no-active-job/);
  assert.match(
    guard,
    /gh_api_timeout --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$WF\/runs\?per_page=100"/,
  );
  assert.match(
    guard,
    /gh_api_timeout --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$run_id\/jobs\?per_page=100"/,
  );
  assert.match(workflow, /workflow_runs \| length/);
  assert.match(guard, /total_count/);
  assert.match(workflow, /validate_workflow_runs\(\)/);
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
  assert.match(workflow, /recent_pages_json=.*gh_api_timeout --paginate --slurp/);
  assert.match(workflow, /recent_runs_json=.*validate_workflow_runs/);
  assert.match(workflow, /\.created_at_epoch >= \(\$t \| fromdateiso8601\)/);
});

test('i gemelli del guard usano listing completi, stati completi e fail-closed', () => {
  const start = republishWorkflow.indexOf('          active_runs_for_shard() {');
  const end = republishWorkflow.indexOf('\n\n          # Tetto assoluto', start);
  assert.ok(start >= 0 && end > start, 'il guard republish non è riconoscibile');
  const republishGuard = republishWorkflow.slice(start, end);

  assert.match(republishWorkflow, /IN_FLIGHT_STATUSES='\["queued","in_progress","requested","waiting","pending"\]'/);
  assert.match(republishGuard, /gh api --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$WF\/runs\?per_page=100"/);
  assert.match(republishGuard, /gh api --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$run_id\/jobs\?per_page=100"/);
  assert.match(republishWorkflow, /total_count/);
  assert.match(republishWorkflow, /validate_workflow_runs/);
  assert.match(republishWorkflow, /created_at_epoch/);
  assert.match(republishWorkflow, /validate_workflow_jobs/);
  assert.match(republishWorkflow, /\[\$pages\[\]\.workflow_runs\[\]\.id\] \| unique \| length/);
  assert.match(republishWorkflow, /\[\$pages\[\]\.jobs\[\]\.id\] \| unique \| length/);
  assert.match(republishGuard, /publish \(shard, " \+ \$shard \+ "\)/);
  assert.match(republishGuard, /publish-other"\) then "free"/);
  assert.match(republishWorkflow, /shard-of "\$section"/);
  assert.doesNotMatch(republishWorkflow, /^\s*active_runs\(\)/m);

  for (const [label, source] of [
    ['generate-article', generationWorkflow],
    ['generate-article-core', generationCoreWorkflow],
  ]) {
    assert.match(source, /gh api --paginate --slurp/,
      `${label}: il listing delle run deve essere paginato`);
    assert.match(source, /actions\/workflows\/(?:generate-article\.yml|\$CALLER_WORKFLOW)\/runs\?per_page=100/,
      `${label}: endpoint del listing non riconoscibile`);
    assert.match(source, /IN_FLIGHT_STATUSES='\["queued","in_progress","requested","waiting","pending"\]'/,
      `${label}: stato in-flight mancante`);
    assert.match(source, /total_count/,
      `${label}: validazione total_count mancante`);
    assert.match(source, /\[\$pages\[\]\.workflow_runs\[\]\.id\] \| unique \| length/,
      `${label}: gli ID duplicati delle run devono negare l'ammissione`);
    assert.match(source, /admit-run-list-unreadable/,
      `${label}: il fallimento del listing deve chiudere l'ammissione`);
    assert.match(source, /fromdateiso8601/,
      `${label}: created_at non validato`);
    assert.doesNotMatch(source, /\.status == "queued" or \.status == "in_progress"/,
      `${label}: filtro status troncato trovato`);
  }
});

test('i due backfill mantengono lo stesso contratto di isolamento per shard', () => {
  const workflowGuards = [workflow, republishWorkflow].map((source) => {
    const start = source.indexOf('          active_runs_for_shard() {');
    const end = source.indexOf('\n\n          # Tetto assoluto', start);
    assert.ok(start >= 0 && end > start, 'guard per-shard non riconoscibile');
    return source.slice(start, end);
  });

  for (const guard of workflowGuards) {
    assert.match(guard, /\.name == "resolve"/,
      'una run ancora nel resolve deve bloccare in modo conservativo');
    assert.match(guard, /publish \(shard, " \+ \$shard \+ "\)/,
      'il job publish deve essere confrontato con lo shard richiesto');
    assert.match(guard, /publish-other"\) then "free"/,
      'un publish su uno shard diverso non deve consumare il backfill');
    assert.match(guard, /unknown\|no-active-job/,
      'un payload senza stato interpretabile deve restare fail-closed');
    assert.doesNotMatch(guard, /active_runs\(\)/,
      'il guard non deve tornare a contare globalmente il workflow');
  }
});
