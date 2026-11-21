/**
 * Il reconciler deve rispettare la stessa granularità della concurrency del
 * publisher: una run attiva su articolifrontaliere non deve bloccare un
 * backfill per articolisvizzera. La prova runtime arriva da Actions; questo
 * gate impedisce che il filtro torni accidentalmente globale.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('il workflow separa le code per trigger e serializza il job di reconcile', () => {
  const workflowConcurrency = workflow.match(/^concurrency:\n(?:^ {2}[^\n]+\n)*/m)?.[0];
  assert.equal(workflowConcurrency, [
    'concurrency:',
    "  group: reconcile-article-shards-${{ github.event_name == 'workflow_run' && format('workflow_run-{0}', github.event.workflow_run.event) || github.event_name }}",
    '  queue: single',
    '  cancel-in-progress: false',
    '',
  ].join('\n'));

  const jobConcurrency = workflow.match(/^jobs:\n  reconcile:\n    concurrency:\n(?:^ {6}[^\n]+\n)*/m)?.[0];
  assert.equal(jobConcurrency, [
    'jobs:',
    '  reconcile:',
    '    concurrency:',
    '      group: reconcile-article-shards',
    '      queue: max',
    '      cancel-in-progress: false',
    '',
  ].join('\n'));
});

test('il reconcile automatico usa la HEAD corrente e non arma backfill stantii', () => {
  const checkout = workflow.match(/^      - name: Checkout\n(?:(?!^      - ).*\n)*/m)?.[0] ?? '';
  assert.match(checkout, /^        with:\n/m);
  assert.match(
    checkout,
    /^          ref: \$\{\{ steps\.checkout_ref\.outputs\.ref \}\}$/m,
  );
  assert.match(checkout, /^          fetch-depth: 1$/m);
  assert.match(checkout, /^          persist-credentials: false$/m);

  const detect = workflow.match(/^      - name: Detect ghosts \(slug annunciati senza pagina sullo shard\)\n(?:(?!^      - ).*\n)*/m)?.[0] ?? '';
  assert.match(
    detect,
    /node scripts\/reconcile-article-shards\.mjs [^\n]*\n[^\n]*\n\s+source_commit="\$\(git rev-parse HEAD\)"\n\s+current_main="\$\(bash scripts\/ci\/read-main-head\.sh\)"[\s\S]*?if ! bash scripts\/ci\/section-source-unaffected\.sh --bookkeeping-only "\$source_commit" "\$current_main"; then/,
  );
  assert.match(
    detect,
    /if ! bash scripts\/ci\/section-source-unaffected\.sh --bookkeeping-only "\$source_commit" "\$current_main"; then[\s\S]*?echo 'head_guard=false' >> "\$GITHUB_OUTPUT"[\s\S]*?exit 0[\s\S]*?echo 'head_guard=true'/,
  );

  const guardedSideEffects = workflow.match(/if:[^\n]*steps\.detect\.outputs\.head_guard == 'true'/g) ?? [];
  assert.equal(guardedSideEffects.length, 5, 'ogni side effect del report deve richiedere una revisione verificata di main');

  const backfill = workflow.match(/^      - name: Backfill \(dispatch fast-publish-article per gli id selezionati\)\n(?:(?!^      - ).*\n)*/m)?.[0] ?? '';
  assert.match(backfill, /^          SOURCE_COMMIT: \$\{\{ steps\.detect\.outputs\.source_commit \}\}$/m);
  assert.match(
    backfill,
    /verifyMainHeadAtDispatch\(\) \{[\s\S]*?bash scripts\/ci\/read-main-head\.sh[\s\S]*?if ! bash scripts\/ci\/section-source-unaffected\.sh --bookkeeping-only "\$SOURCE_COMMIT" "\$current_main"; then[\s\S]*?return 2/,
  );
  assert.match(
    backfill,
    /if verifyMainHeadAtDispatch; then\n\s+:\n\s+else[\s\S]*?\n\s+break\n\s+fi\n\s+if ! gh_api_timeout -X POST "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$WF\/dispatches"/,
    'ogni dispatch deve essere preceduto dalla verifica della HEAD corrente',
  );
});

function workflowStep(source, name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n      - name: ', start);
  return source.slice(start, end < 0 ? undefined : end);
}

function stepScript(step) {
  const run = step.match(/^        run: \|\n((?:^ {10}.*\n?)+)/m);
  assert.ok(run, 'blocco shell mancante');
  return run[1].replace(/^ {10}/gm, '');
}

test('il backfill manuale richiede dry_run=false esplicito', () => {
  const dispatch = workflow.match(/^  workflow_dispatch:\n    inputs:\n(?:^ {6}.*\n)*/m)?.[0] ?? '';
  assert.match(dispatch, /^      dry_run:\n        description: [^\n]+\n        required: false\n        default: true\n        type: boolean$/m);

  const mode = workflowStep(workflow, 'Resolve backfill mode');
  assert.match(mode, /^        id: mode$/m);
  assert.match(
    stepScript(mode),
    /^if \[ "\$\{\{ github\.event_name \}\}" = "workflow_dispatch" \] && \[ "\$\{\{ inputs\.dry_run \}\}" != "false" \]; then\n  allow=false;/m,
  );
  assert.match(stepScript(mode), /^echo "allow=\$allow" >> "\$GITHUB_OUTPUT"$/m);

  const backfill = workflowStep(workflow, 'Backfill (dispatch fast-publish-article per gli id selezionati)');
  assert.match(
    backfill,
    /^        if: steps\.mode\.outputs\.allow == 'true' && steps\.arm\.outputs\.allow == 'true' && steps\.detect\.outputs\.head_guard == 'true' && steps\.detect\.outputs\.selected != '0'$/m,
  );
});

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const validation = workflowStep(publisherWorkflow, 'Validate source commit pin');

test('il dispatch su main passa lo SHA verificato al dispatch a entrambi i checkout', () => {
  const backfill = workflowStep(workflow, 'Backfill (dispatch fast-publish-article per gli id selezionati)');
  assert.match(backfill, /-f ref=main \\\n +-f "inputs\[source_commit\]=\$\{dispatch_source\}"/);
  assert.match(publisherWorkflow, /\n      source_commit:\n        description: [^\n]+\n        required: false\n        default: ''\n        type: string\n/);
  assert.match(validation, /id: source_pin\n *env:\n *SOURCE_COMMIT: \$\{\{ inputs\.source_commit \}\}/);
  assert.match(publisherWorkflow, /    outputs:\n      source_commit: \$\{\{ steps\.source_pin\.outputs\.source_commit \}\}/);
  for (const [name, pin] of [
    ['Checkout (resolve)', 'steps.source_pin.outputs.source_commit'],
    ['Checkout', 'needs.resolve.outputs.source_commit'],
  ]) {
    const checkout = workflowStep(publisherWorkflow, name);
    assert.ok(checkout.includes(`\n          ref: \${{ ${pin} || (github.event_name == 'workflow_dispatch' && github.ref || github.sha) }}\n`));
    assert.match(checkout, /^          fetch-depth: 0$/m);
  }
  assert.ok(publisherWorkflow.indexOf(validation) < publisherWorkflow.indexOf('      - name: Checkout (resolve)'));
});

test('resolve e publish verificano lo stesso pin prima di proseguire', () => {
  const resolve = workflowStep(publisherWorkflow, 'Verify source commit pin (resolve)');
  const publish = workflowStep(publisherWorkflow, 'Verify source commit pin (publish)');
  for (const [guard, output, next] of [
    [resolve, 'steps.source_pin.outputs.source_commit', 'Resolve mode, article ids and section'],
    [publish, 'needs.resolve.outputs.source_commit', 'Install dependencies'],
  ]) {
    assert.ok(guard.includes(`if: ${output} != ''`));
    assert.ok(guard.includes(`SOURCE_COMMIT: \${{ ${output} }}`));
    assert.ok(publisherWorkflow.indexOf(guard) < publisherWorkflow.indexOf(`      - name: ${next}`));
  }
  assert.equal(stepScript(resolve), stepScript(publish));
  assert.match(publisherWorkflow, /if: always\(\).*needs\.resolve\.outputs\.source_commit == '' \|\| steps\.verify_source_pin\.outcome == 'success'/);
});

test('la validazione shell accetta solo un pin lowercase su dispatch main', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shard-pin-'));
  try {
    const output = join(cwd, 'output');
    for (const [pin, event, ref, status] of [
      ['', 'push', 'refs/heads/main', 0],
      ['', 'workflow_dispatch', 'refs/heads/side', 0],
      [shaA, 'workflow_dispatch', 'refs/heads/main', 0],
      [shaA, 'workflow_dispatch', 'refs/tags/main', 1],
      [shaA, 'workflow_dispatch', 'refs/heads/side', 1],
      [shaA, 'push', 'refs/heads/main', 1],
      ['bad', 'workflow_dispatch', 'refs/heads/main', 1],
      [shaA.toUpperCase(), 'workflow_dispatch', 'refs/heads/main', 1],
    ]) {
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', stepScript(validation)], {
        cwd,
        env: {
          PATH: process.env.PATH, SOURCE_COMMIT: pin, GITHUB_EVENT_NAME: event,
          GITHUB_REF: ref, GITHUB_OUTPUT: output,
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, status, JSON.stringify({ pin, event, ref, result }));
      assert.equal(readFileSync(output, 'utf8'), status === 0 ? `source_commit=${pin}\n` : '');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('la chiusura issue ammette solo una main compatibile con la detection', () => {
  const close = workflowStep(workflow, 'Close ghost-articles issue (coda drenata)');
  assert.match(close, /continue-on-error: true/);
  assert.match(close, /if: steps\.detect\.outcome == 'success' && steps\.detect\.outputs\.head_guard == 'true' && steps\.detect\.outputs\.missing == '0'/);
  assert.match(close, /SOURCE_COMMIT: \$\{\{ steps\.detect\.outputs\.source_commit \}\}/);
  const script = stepScript(close).replace(/\$\{\{ github\.(?:server_url|repository|run_id) \}\}/g, 'synthetic');
  assert.doesNotMatch(script, /\$\{\{/);
  const cwd = mkdtempSync(join(tmpdir(), 'shard-close-'));
  try {
    mkdirSync(join(cwd, 'scripts/ci'), { recursive: true });
    mkdirSync(join(cwd, 'data/sections/canton-fr'), { recursive: true });
    writeFileSync(join(cwd, 'scripts/ci/section-source-unaffected.sh'),
      readFileSync(new URL('../../scripts/ci/section-source-unaffected.sh', import.meta.url)));
    writeFileSync(join(cwd, 'scripts/ci/read-main-head.sh'),
      '[ -n "$FAKE_MAIN" ] || exit 1\nprintf "%s\\n" "$FAKE_MAIN"\n');
    writeFileSync(join(cwd, 'scripts/ci/resolve-issue-verified.mjs'),
      'import { appendFileSync } from "node:fs";\nappendFileSync("calls", "close\\n");\n');
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const commit = (file, text) => {
      writeFileSync(join(cwd, file), text);
      git('add', file);
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', file);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q');
    const detected = commit('article.txt', 'article content\n');
    const ledger = commit('data/sections/canton-fr/topic-candidates-evergreen-rejected.json', '{}\n');
    const newArticle = commit('article.txt', 'changed article\n');
    for (const [pin, main, calls] of [
      [detected, detected, 'close\n'],
      [detected, ledger, 'close\n'],
      [detected, newArticle, ''],
      [ledger, detected, ''],
      [detected, '', ''],
      ['bad', 'bad', ''],
    ]) {
      writeFileSync(join(cwd, 'calls'), '');
      const result = spawnSync('bash', ['-c', script], {
        cwd,
        env: { PATH: process.env.PATH, SOURCE_COMMIT: pin, FAKE_MAIN: main },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(cwd, 'calls'), 'utf8'), calls);
      if (!calls) assert.match(result.stdout, /^::notice::main non verificabile o avanzata; issue fantasma lasciata aperta$/m);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
    /gh_api_timeout --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$run_id\/jobs\?per_page=100"/,
  );
  assert.match(guard, /jobs_page_count/);
  assert.match(guard, /jobs\?per_page=100&page=\$\(\(jobs_page_count \+ 1\)\)/);
  assert.match(guard, /jobs_sentinel_json/);
  assert.match(guard, /\.jobs \| length\) == 0/);
  assert.match(workflow, /jobs \| length/);
  assert.match(guard, /total_count/);
  assert.doesNotMatch(guard, /map\(\.total_count\) \| unique/);
  assert.doesNotMatch(guard, /map\(\.jobs \| length\) \| add/);
  assert.match(guard, /all\(\$pages\[\]; \(\.jobs \| length\) <= 100\)/);
  assert.match(guard, /all\(\$pages\[0:-1\]\[\]; \(\.jobs \| length\) == 100\)/);
  assert.match(workflow, /validate_workflow_runs\(\)/);
  assert.match(guard, /\.name == "resolve"/);
  assert.doesNotMatch(guard, /\.status == "queued" or \.status == "in_progress"/);
  assert.match(guard, /run_event.*workflow_dispatch/);
  assert.match(guard, /cover-publish-article\[\[:space:\]\]/);
  assert.match(guard, /dispatch_section="\$\{BASH_REMATCH\[1\]\}"/);
  assert.match(guard, /dispatch_section.*!= "auto"/);
  assert.match(guard, /validate_workflow_runs_for_status/);
  assert.match(guard, /actions\/workflows\/\$WF\/runs\?per_page=100&status=\$status/);
  assert.match(guard, /done < <\(jq -r '\.\[\]' <<<"\$IN_FLIGHT_STATUSES"\)/);
  assert.match(workflow, /runStatusIsCurrent\(\) \{/);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$run_id/);
  assert.match(guard, /runStatusIsCurrent "\$run_id" "\$run_status"/);
  assert.match(guard, /\[\.id, \.event, \.display_title, \.status\] \| @tsv/);
  assert.doesNotMatch(
    guard,
    /actions\/workflows\/\$WF\/runs\?per_page=100"/,
    'il guard non deve paginare la storia completa del workflow',
  );
  assert.match(
    publisherWorkflow,
    /\n  publish:\n    name: publish \(shard, \$\{\{ matrix\.target\.shard \}\}\)\n/,
  );
  assert.match(
    workflow,
    /while \[ "\$\(active_runs_for_shard "\$section" "\$target_shard"\)" -gt 0 \]/,
  );
  assert.doesNotMatch(
    workflow,
    /-f 'inputs\[article_only\]=true'/,
    'il ghost backfill deve aggiornare anche aggregate e landing, non solo la pagina articolo',
  );
  assert.match(
    workflow,
    /\.selected\[\].*\[\.id, \.section, \.shard\]/,
  );
  assert.doesNotMatch(workflow, /active_runs\(\)/, 'il gate non deve tornare a contare il workflow globalmente');
  assert.match(workflow, /recent_pages_json=.*gh_api_timeout --paginate --slurp/);
  assert.match(workflow, /recent_runs_json=.*validate_workflow_runs/);
  assert.match(workflow, /recent_since/);
  assert.match(workflow, /created=%3E%3D\$recent_since&event=workflow_dispatch/);
  assert.match(workflow, /\.created_at_epoch >= \(\$t \| fromdateiso8601\)/);
});

test('i gemelli del guard usano listing completi, stati completi e fail-closed', () => {
  const start = republishWorkflow.indexOf('          active_runs_for_shard() {');
  const end = republishWorkflow.indexOf('\n\n          # Tetto assoluto', start);
  assert.ok(start >= 0 && end > start, 'il guard republish non è riconoscibile');
  const republishGuard = republishWorkflow.slice(start, end);

  assert.match(republishWorkflow, /IN_FLIGHT_STATUSES='\["queued","in_progress","requested","waiting","pending"\]'/);
  assert.match(republishWorkflow, /validate_workflow_runs_for_status/);
  assert.match(republishGuard, /actions\/workflows\/\$WF\/runs\?per_page=100&status=\$status/);
  assert.match(republishGuard, /done < <\(jq -r '\.\[\]' <<<"\$IN_FLIGHT_STATUSES"\)/);
  assert.match(republishWorkflow, /runStatusIsCurrent\(\) \{/);
  assert.match(republishWorkflow, /repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$run_id/);
  assert.match(republishGuard, /runStatusIsCurrent "\$run_id" "\$run_status"/);
  assert.match(republishGuard, /\[\.id, \.event, \.display_title, \.status\] \| @tsv/);
  assert.doesNotMatch(
    republishGuard,
    /actions\/workflows\/\$WF\/runs\?per_page=100"/,
    'il guard republish non deve paginare la storia completa del workflow',
  );
  assert.match(republishGuard, /gh_api_timeout --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$run_id\/jobs\?per_page=100"/);
  assert.match(republishGuard, /jobs_page_count/);
  assert.match(republishGuard, /jobs\?per_page=100&page=\$\(\(jobs_page_count \+ 1\)\)/);
  assert.match(republishGuard, /jobs_sentinel_json/);
  assert.match(republishGuard, /\.jobs \| length\) == 0/);
  assert.match(republishWorkflow, /total_count/);
  assert.doesNotMatch(republishWorkflow, /map\(\.total_count\) \| unique/);
  assert.doesNotMatch(republishWorkflow, /map\(\.jobs \| length\) \| add/);
  assert.match(republishWorkflow, /all\(\$pages\[\]; \(\.jobs \| length\) <= 100\)/);
  assert.match(republishWorkflow, /all\(\$pages\[0:-1\]\[\]; \(\.jobs \| length\) == 100\)/);
  assert.match(republishWorkflow, /validate_workflow_runs/);
  assert.match(republishWorkflow, /\.status == \$expected/);
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
    assert.match(source, /gh_api_timeout --paginate --slurp/,
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
