import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workflow = readFileSync(
  new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url),
  'utf8',
);
const resolver = readFileSync(
  new URL('../../scripts/ci/fast-publish-section-resolve.sh', import.meta.url),
  'utf8',
);
const render = readFileSync(
  new URL('../../scripts/ci/fast-publish-section-render.sh', import.meta.url),
  'utf8',
);
const recovery = readFileSync(
  new URL('../../scripts/ci/fast-publish-section-recovery.sh', import.meta.url),
  'utf8',
);
const resultRecorder = readFileSync(
  new URL('../../scripts/ci/record-fast-publish-result.sh', import.meta.url),
  'utf8',
);
const replayDispatcher = readFileSync(
  new URL('../../scripts/ci/dispatch-fast-publish-replay.sh', import.meta.url),
  'utf8',
);

function triggerBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  assert.ok(start >= 0, `trigger ${name} missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:/u);
  return next < 0 ? rest : rest.slice(0, next);
}

test('il job publish accoda le richieste per sezione e limita il parallelismo della matrice', () => {
  const publish = workflow.match(/\n  publish:\n[\s\S]*?(?=\n\S|\n  \S|$)/u)?.[0];
  assert.ok(publish, 'manca il job publish');

  const strategy = publish.match(/^    strategy:\n(?: {6}[^\n]*\n)*/mu)?.[0];
  assert.ok(strategy, 'manca la strategia del job publish');
  assert.match(strategy, /^      max-parallel: 4$/mu);

  const concurrency = publish.match(/^    concurrency:\n(?: {6}[^\n]*\n)*/mu)?.[0];
  assert.ok(concurrency, 'manca il blocco concurrency del job publish');
  assert.match(concurrency, /^      group: fast-publish-\$\{\{ matrix\.target\.section \}\}$/mu);
  assert.match(concurrency, /^      cancel-in-progress: false$/mu);
  assert.match(concurrency, /^      queue: max$/mu);
});

test('un replay pinned superato usa un nuovo nonce per la revisione di destinazione', () => {
  const step = workflow.split('      - name: Dispatch bounded replay with current corpus checkout\n')[1]
    .split('\n      - name:')[0];
  assert.doesNotMatch(step, /DISPATCH_NONCE|DISPATCH_COHORT|inputs\.dispatch_(nonce|cohort)/u);
  assert.match(step, /nonce_hash=.*"\$GITHUB_RUN_ID" "\$CURRENT_MAIN" "\$SECTION"/u);
  assert.match(step, /dispatch_nonce="stale-late-\$\{CURRENT_MAIN:0:12\}-\$\{SECTION\}-\$\{nonce_hash\}"/u);
  assert.match(step, /-f dispatch_nonce="\$dispatch_nonce"/u);
  assert.match(step, /dispatch_cohort="stale-late-\$\{GITHUB_RUN_ID\}-\$\{SECTION\}-n1"/u);
  assert.match(step, /-f dispatch_cohort="\$dispatch_cohort"/u);
});

test('fast-publish-section non crea run push sui branch di PR', () => {
  const push = triggerBlock('push');
  assert.match(push, /\n    branches: \[main\]/u);
  assert.doesNotMatch(push, /branches-ignore/u);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\non:')), /\n  pull_request:/u);
});

test('fast-publish-section limita i replay workflow_run a publish-api verde su main', () => {
  const run = triggerBlock('workflow_run');
  assert.match(run, /workflows: \['Publish article data API'\]/u);
  assert.match(run, /types: \[completed\]/u);
  assert.match(run, /branches: \[main\]/u);

  const resolve = workflow.slice(workflow.indexOf('\n  resolve:'), workflow.indexOf('\n  plan:'));
  assert.match(resolve, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(resolve, /github\.event\.workflow_run\.head_branch == 'main'/u);
});

test('fast-publish-section mantiene il contratto dispatch esplicito', () => {
  const dispatch = triggerBlock('workflow_dispatch');
  assert.match(dispatch, /section:/u);
  assert.match(dispatch, /required: true/u);
  assert.match(dispatch, /bootstrap:/u);
  assert.match(dispatch, /push_before:/u);
  assert.match(dispatch, /push_after:/u);
  assert.match(dispatch, /dispatch_cohort:/u);
  assert.match(dispatch, /dispatch_cohort:\n\s+description:/u);
  assert.match(dispatch, /dispatch_cohort:[\s\S]*?required: false/u);
  assert.match(dispatch, /dispatch_cohort:[\s\S]*?default: ''/u);
  assert.match(dispatch, /dispatch_cohort:[\s\S]*?type: string/u);
});

test('fast-publish-section ricontrolla main subito prima del replay API', () => {
  const replay = workflow.slice(workflow.indexOf('\n  replay-api-after-staged-release:'));
  const dispatchStep = replay.slice(replay.indexOf('- name: Replay publish-api after staged release'));
  const guardIndex = dispatchStep.indexOf('verifyMainHeadAtDispatch() {');
  const dispatchIndex = dispatchStep.indexOf('gh workflow run publish-api.yml');

  assert.ok(guardIndex >= 0, 'manca il controllo finale della HEAD di main');
  assert.ok(dispatchIndex > guardIndex, 'il dispatch deve avvenire dopo il controllo finale');
  assert.match(dispatchStep, /current_main="\$\(bash scripts\/ci\/read-main-head\.sh\)"/u);
  assert.match(dispatchStep, /\[ "\$current_main" != "\$SOURCE_COMMIT" \]/u);
  assert.match(dispatchStep, /replay API interrotto/u);
  assert.match(dispatchStep, /if verifyMainHeadAtDispatch; then/u);
});

test('fast-publish-section artifactizza nonce e revisione del child', () => {
  const record = workflow.slice(workflow.indexOf('- name: Record publish result'));
  assert.match(record, /DISPATCH_NONCE: \$\{\{ inputs\.dispatch_nonce \}\}/u);
  assert.match(record, /DISPATCH_COHORT: \$\{\{ inputs\.dispatch_cohort \}\}/u);
  assert.match(record, /COORDINATED_RECOVERY: \$\{\{ inputs\.coordinated_recovery \}\}/u);
  assert.match(record, /SOURCE_COMMIT: \$\{\{ needs\.resolve\.outputs\.source_commit \|\| inputs\.source_commit \}\}/u);
  assert.match(workflow, /scripts\/ci\/record-fast-publish-result\.sh/u);
  assert.match(resultRecorder, /source_main_commit: \$source_main_commit/u);
  assert.match(resultRecorder, /dispatch_nonce: \$dispatch_nonce/u);
  assert.match(resultRecorder, /dispatch_cohort: \$dispatch_cohort/u);
});

test('il dispatcher riconosce il run-name con coorte dopo dry-run', () => {
  assert.match(workflow, /run-name:.*dry=\$\{\{ inputs\.dry_run \}\} \/ c=/u);
  assert.match(replayDispatcher, /test\(" \/ dry=false\(\?: \/ c=\[\^\/\]\+\)\?\$"\)/u);
  assert.match(replayDispatcher, /test\(" \/ dry=true\(\?: \/ c=\[\^\/\]\+\)\?\$"\)/u);
});

test('il replay checkout mantiene tutti gli helper nel profilo sparse', () => {
  const replay = workflow.slice(workflow.indexOf('\n  replay-api-after-staged-release:'));
  const checkout = replay.slice(
    replay.indexOf('- name: Checkout replay dispatcher from workflow revision'),
    replay.indexOf('- name: Materialize freshness helper from workflow revision'),
  );

  assert.match(checkout, /sparse-checkout:\s*\|/u);
  assert.match(checkout, /scripts\/ci\/dispatch-fast-publish-replay\.sh[\s\S]*scripts\/ci\/read-main-head\.sh/u);
});

test('fast-publish-section mantiene il resolver sotto il limite del parser GitHub', () => {
  assert.match(workflow, /- name: Materialize resolver from workflow revision/u);
  assert.match(workflow, /scripts\/ci\/fast-publish-section-resolve\.sh/u);
  const resolve = workflow.slice(
    workflow.indexOf('\n      - name: Resolve sections and article ids'),
    workflow.indexOf('\n      - name: Arm normal push staged replay'),
  );
  assert.match(resolve, /run: \|\n\s+bash scripts\/ci\/fast-publish-section-resolve\.sh/u);
  assert.ok(resolver.length < 21_000, `resolver too large: ${resolver.length}`);
  assert.match(resolver, /reconcile_edge_matrix\(\)/u);
  assert.match(resolver, /GITHUB_OUTPUT/u);
  assert.match(resolver, /FAST_PUBLISH_ARMED/u);
  assert.doesNotMatch(resolver, /\$\{\{/u);
});

test('il replan stale ripristina tutti gli helper materializzati prima di cambiare HEAD', () => {
  const materializer = workflow.slice(
    workflow.indexOf('\n      - name: Materialize resolver from workflow revision'),
    workflow.indexOf('\n      - name: Set up Node (resolve)'),
  );
  const targetAssignments = [...materializer.matchAll(/\b[a-z_]+_target='([^']+)'/gu)]
    .map((match) => match[1]);
  const symlinkTargets = [...materializer.matchAll(/ln -sfn [^\n]+ (scripts\/ci\/[a-z0-9-]+\.sh)/gu)]
    .map((match) => match[1]);
  const materializedTargets = [...new Set([...targetAssignments, ...symlinkTargets])].sort();
  const declaredBlock = resolver.match(/MATERIALIZED_RESOLVE_PATHS=\(\n([\s\S]*?)\n\)/u)?.[1] ?? '';
  const restoredTargets = declaredBlock.trim().split(/\s+/u).filter(Boolean).sort();

  assert.deepEqual(restoredTargets, materializedTargets);
  const restore = resolver.indexOf('if ! restore_materialized_resolve_paths; then');
  const checkout = resolver.indexOf('git checkout --detach "$current_main"');
  assert.ok(restore >= 0, 'manca il ripristino fail-closed degli helper di runtime');
  assert.ok(checkout > restore, 'il checkout della HEAD corrente deve seguire il ripristino degli helper');
  assert.match(resolver, /git cat-file -e "HEAD:\$runtime_path"/u);
  assert.match(resolver, /git restore --source=HEAD --worktree -- "\$runtime_path"/u);
  assert.match(resolver, /elif \[ -e "\$runtime_path" \] \|\| \[ -L "\$runtime_path" \]; then[\s\S]*rm -f -- "\$runtime_path"/u);
  assert.match(resolver, /impossibile ripristinare gli helper materializzati prima del replan stale/u);
});

test('il restore stale ripristina i target tracciati e rimuove quelli assenti dalla vecchia HEAD', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fast-section-stale-restore-'));
  const declared = resolver.match(/MATERIALIZED_RESOLVE_PATHS=\(\n[\s\S]*?\n\)/u)?.[0];
  const restoreFunction = resolver.match(/restore_materialized_resolve_paths\(\) \{\n[\s\S]*?\n\}/u)?.[0];
  assert.ok(declared && restoreFunction, 'contratto restore non estraibile');
  const tracked = [
    'scripts/ci/fast-publish-section-resolve.sh',
    'scripts/ci/read-main-head.sh',
    'scripts/ci/fast-publish-section-edge-candidate.sh',
    'scripts/ci/fetch-push-base-if-missing.sh',
  ];
  const absent = 'scripts/ci/fast-publish-section-preflight.sh';
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    for (const target of tracked) {
      mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
      writeFileSync(path.join(root, target), `tracked:${target}\n`);
    }
    git('add', '.');
    git('commit', '--quiet', '-m', 'old pinned head');

    for (const target of tracked) writeFileSync(path.join(root, target), `runtime:${target}\n`);
    symlinkSync('/runtime/only/preflight.sh', path.join(root, absent));
    execFileSync('bash', ['-c', `${declared}\n${restoreFunction}\nrestore_materialized_resolve_paths`], {
      cwd: root,
      stdio: 'pipe',
    });

    for (const target of tracked) {
      assert.equal(readFileSync(path.join(root, target), 'utf8'), `tracked:${target}\n`, target);
    }
    assert.equal(existsSync(path.join(root, absent)), false, 'il target runtime assente dalla HEAD deve sparire');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fast-publish-section conserva la guardia di freschezza anche con checkout pinned precedente', () => {
  const materializers = [...workflow.matchAll(/- name: Materialize (?:resolver|freshness helper) from workflow revision[\s\S]*?(?=\n      - name:|\n  [A-Za-z_][A-Za-z0-9_-]*:|$)/gu)]
    .map((match) => match[0]);
  assert.equal(materializers.length, 3, 'ogni job che legge main deve materializzare la guardia');
  for (const block of materializers) {
    assert.match(block, /if \[ -f "\$(?:source|main_head_source)" \]; then/u);
    assert.match(block, /elif \[ -f "\$(?:target|main_head_target)" \]; then/u);
    assert.match(block, /fallback git-transport/u);
    assert.match(block, /git ls-remote --refs/u);
    assert.match(block, /timeout 60/u);
    assert.doesNotMatch(block, /helper della punta di main non presente.*exit 1/u);
  }
});

test('fast-publish-section delega i blocchi shell grandi a script senza espressioni YAML', () => {
  for (const name of [
    'preflight',
    'render',
    'recovery',
  ]) {
    const path = `scripts/ci/fast-publish-section-${name}.sh`;
    assert.match(workflow, new RegExp(`run: bash ${path.replaceAll('/', '\\/')}`));
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.match(source, /^#!\/usr\/bin\/env bash/u);
    assert.match(source, /^set -euo pipefail$/mu);
    assert.doesNotMatch(source, /\$\{\{/u);
  }
});

test('una gara stale consegna la sezione al coordinatore senza dichiarare una pubblicazione', () => {
  assert.match(render, /dispatch_stale_replay\(\)/u);
  assert.match(render, /echo "stale_handoff=true" >> "\$GITHUB_OUTPUT"/u);
  assert.match(render, /echo "stale_handoff_head=\$handoff_head" >> "\$GITHUB_OUTPUT"/u);
  assert.match(render, /echo "stale_handoff_nonce=\$stale_handoff_nonce" >> "\$GITHUB_OUTPUT"/u);
  assert.match(render, /echo "stale_handoff_title=\$stale_handoff_title" >> "\$GITHUB_OUTPUT"/u);
  assert.match(render, /coordinatore sulla HEAD/u);
  assert.doesNotMatch(
    render,
    /main e' avanzata durante tre tentativi di render del publisher[\s\S]*exit 1/u,
    'tre avanzamenti concorrenti devono accodare il replay, non lasciare il producer rosso',
  );
  assert.match(workflow, /STALE_HANDOFF: \$\{\{ steps\.render\.outputs\.stale_handoff \}\}/u);
  assert.match(resultRecorder, /stale_handoff: \$stale_handoff/u);
  assert.match(workflow, /stale_handoff: \$\{\{ steps\.collect\.outputs\.stale_handoff \}\}/u);
  assert.match(workflow, /echo 'mixed_matrix=true' >> "\$GITHUB_OUTPUT"/u);
  assert.doesNotMatch(workflow, /needs\.publish_release_head\.outputs\.stale_handoff != 'true'/u);
  assert.match(
    workflow,
    /all\(\.\[\]; \(\.rendered_head == "" and \(\(\.stale_handoff == "true"\) or \(\.fresh == "false"\)\)\)\)/u,
  );
  assert.ok(
    workflow.includes('(.stale_handoff // "") == "true"'),
    'una matrix mista deve ricorrere al recovery, non annunciare una release parziale',
  );
  assert.match(workflow, /steps\.stale\.outputs\.recovery_head \|\| steps\.replay_freshness\.outputs\.current_main \|\| needs\.publish_release_head\.outputs\.rendered_head/u);
  assert.match(workflow, /steps\.replay_freshness\.outputs\.fresh == 'false'[\s\S]*needs\.publish_release_head\.outputs\.mixed_matrix == 'true'/u);
  assert.match(render, /-f dispatch_cohort="\$dispatch_cohort"/u);
  assert.match(render, /child_replay_api_after_publish=false/u);
  assert.match(render, /child_coordinated_recovery=true/u);
  assert.match(render, /-f coordinated_recovery="\$child_coordinated_recovery"/u);
  assert.match(workflow, /child_replay_api_after_publish=false/u);
  assert.match(workflow, /child_coordinated_recovery=true/u);
});

test('il replay pinned consegna la sezione se main avanza durante il render', () => {
  const start = render.indexOf('if [ "$normal_dispatch" !=');
  const end = render.indexOf('\nwhile :; do', start);
  assert.ok(start >= 0 && end > start);
  const root = mkdtempSync(path.join(tmpdir(), 'section-late-handoff-'));
  try {
    const output = path.join(root, 'output');
    const source = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const block = render.slice(start, end);
    const run = (error) => execFileSync('bash', ['-c', [
      'set -euo pipefail',
      'normal_dispatch=false',
      `pinned_replay_main=${source}`,
      'build_publish_args() { args=(--section canton-ti); }',
      'bash() { case "$1" in',
      '  *retry-cmd.sh) printf "%s\\n" "$PUBLISH_ERROR"; return 1 ;;',
      `  *read-main-head.sh) echo "${head}" ;;`,
      'esac; }',
      'dispatch_stale_replay() {',
      `  [ "$1" = "${source}" ] && [ "$2" = "${head}" ] || return 1`,
      '  stale_handoff_nonce=nonce; stale_handoff_title=title',
      '}',
      block,
    ].join('\n')], {
      cwd: root,
      env: { ...process.env, DRY: 'false', RUNNER_TEMP: root, GITHUB_OUTPUT: output, PUBLISH_ERROR: error },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.throws(() => run('HTML validation failed'), { status: 1 });
    assert.equal(existsSync(output), false);
    run(`main e' avanzato durante il render (${source} → ${head}); pubblicazione interrotta`);
    assert.equal(readFileSync(output, 'utf8'), [
      'stale_handoff=true', `stale_handoff_head=${head}`, 'stale_handoff_nonce=nonce', 'stale_handoff_title=title', '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il replay stale installa il parser prima di risolvere la release API', () => {
  const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  const runtime = publish.indexOf('- name: Setup isolated article source runtime');
  const staleDispatch = publish.indexOf('- name: Dispatch bounded replay with current corpus checkout');

  assert.ok(runtime >= 0, 'il publish deve inizializzare il runtime TypeScript');
  assert.ok(staleDispatch > runtime, 'il runtime deve precedere il dispatch stale');
  assert.match(
    publish.slice(runtime, staleDispatch),
    /if: steps\.replay_freshness\.outputs\.fresh == 'true' \|\| github\.event\.workflow_run\.head_sha != ''/u,
  );
  assert.match(
    publish.slice(runtime, staleDispatch),
    /uses: \.\/\.replay-dispatcher-source\/\.github\/actions\/setup-article-source-runtime/u,
  );
  assert.match(
    publish.slice(staleDispatch),
    /import \{ resolveStaleReplayApiReleaseCommit \} from "\.\/scripts\/publish-section-pages\.mjs"/u,
  );
});

test('reconcile evita un backfill duplicato sulla stessa revisione e conserva la coorte del flip', () => {
  const source = readFileSync(new URL('../../.github/workflows/reconcile-section-pages.yml', import.meta.url), 'utf8');
  const start = source.indexOf('          set -euo pipefail', source.indexOf('- name: Backfill (dispatch'));
  const end = source.indexOf('\n      # Il workflow_run di un child', start);
  assert.ok(start >= 0 && end > start);
  const root = mkdtempSync(path.join(tmpdir(), 'section-reconcile-active-'));
  const commit = 'a'.repeat(40);
  const pending = (section, status, sha = commit) => ({
    head_sha: sha,
    status,
    display_title: `cover-publish-section / ${section} / nonce=reconcile-42-${section} / dry=false / c=reconcile-42-n1`,
  });
  try {
    writeFileSync(path.join(root, 'reconcile-sections.json'), JSON.stringify({
      sections: ['canton-appenzello', 'canton-ti', 'canton-ne'].map((section) => ({
        section, dispatch: true, selected: [], missingPagePaths: [], knownMissingPagePaths: [],
      })),
    }));
    const run = (pendingFlip) => execFileSync('bash', ['-c', [
      'gh() { if [ "$1" = api ]; then printf "%s" "$ACTIVE_RUNS"; else printf "%s\\n" "$@"; fi; }',
      'date() { echo 2026-11-19T04:00:00Z; }',
      source.slice(start, end),
    ].join('\n')], {
      cwd: root,
      env: {
        ...process.env, RUNNER_TEMP: root, GITHUB_PAT_NANAKO: 'test-token', GITHUB_REPOSITORY: 'test/corpus',
        GITHUB_RUN_ID: '123', PENDING_EDGE_FLIP: pendingFlip, SOURCE_COMMIT: commit, API_RELEASE_COMMIT: commit,
        ACTIVE_RUNS: JSON.stringify([{ workflow_runs: [
          pending('canton-appenzello', 'pending'),
          pending('canton-ti', 'completed'),
          { ...pending('canton-ti', 'queued'), display_title: 'cover-publish-section / canton-ti / nonce=manual / dry=false / c=none' },
          { ...pending('canton-ne', 'queued'), display_title: 'cover-publish-section / canton-ne / nonce=reconcile-42-canton-ne / dry=true / c=reconcile-42-n1' },
          pending('canton-ne', 'in_progress', 'b'.repeat(40)),
        ] }]),
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const ordinary = run('false');
    assert.doesNotMatch(ordinary, /section=canton-appenzello/);
    assert.match(ordinary, /section=canton-ti/);
    assert.match(ordinary, /section=canton-ne/);
    assert.match(ordinary, /dispatch_cohort=reconcile-123-n2/);
    const flip = run('true');
    assert.match(flip, /section=canton-appenzello/);
    assert.match(flip, /dispatch_cohort=reconcile-123-n3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('un recovery stale dispatcha i child e lascia il barrier al reconcile event-driven', () => {
  assert.match(recovery, /dispatch_children_wave[\s\S]*The recovery is a dispatcher, not a coordinator/u);
  assert.doesNotMatch(recovery, /wait_for_dispatched_children/u);
  assert.doesNotMatch(recovery, /rebuild_recovery_head/u);
  assert.doesNotMatch(recovery, /VERIFY_STALE_HANDOFF_HEAD/u);
  assert.doesNotMatch(recovery, /REPLAY_CHILD_WAIT_MAX_S/u);
  assert.doesNotMatch(recovery, /gh run list --repo "\$REPOSITORY" --workflow fast-publish-section\.yml/u);
  assert.match(recovery, /readiness verra' verificata dal reconcile event-driven/u);
  assert.match(recovery, /printf 'recovery_head=%s\\n' "\$CURRENT_MAIN" >> "\$GITHUB_OUTPUT"/u);
  assert.match(recovery, /dispatch_cohort_size="\$\(jq 'length'/u);
  assert.match(recovery, /-f dispatch_cohort="\$dispatch_cohort"/u);
  assert.match(recovery, /dispatch_cohort="stale-staged-\$\{GITHUB_RUN_ID\}-n\$\{dispatch_cohort_size\}"/u);
  assert.match(recovery, /child_replay_api_after_publish=false/u);
  assert.match(recovery, /child_coordinated_recovery=true/u);
  assert.match(resolver, /git checkout --detach "\$current_main"/u);
  assert.match(resolver, /echo "source_commit=\$current_main"/u);
  assert.match(resolver, /echo "matrix=\$replay_matrix"/u);
  assert.doesNotMatch(resolver, /riuso il nonce del coordinator/u);
});

test('il recovery verifica l ancestry della base prima di ricostruire la matrice', () => {
  assert.match(recovery, /validate_recovery_base_ancestry\(\)/u);
  assert.match(recovery, /git merge-base --is-ancestor "\$recovery_base" "\$CURRENT_MAIN"/u);
  assert.match(recovery, /base della push non antenata di CURRENT_MAIN: force-push o storia non lineare/u);
  assert.match(recovery, /\[ -z "\$recovery_base" \] \|\| \[\[ "\$recovery_base" =~ \^0\+\$ \]\]/u);

  const mixedPlan = recovery.indexOf('target_matrix="$(git diff --name-status "$plan_before" "$CURRENT_MAIN"');
  const rebuildPlan = recovery.lastIndexOf('target_matrix="$(git diff --name-status "$plan_before" "$CURRENT_MAIN"');
  assert.ok(mixedPlan >= 0, 'manca il piano mixed iniziale');
  assert.equal(rebuildPlan, mixedPlan, 'il recovery non deve ricostruire wave mentre aspetta child');
  assert.ok(
    recovery.lastIndexOf('if ! validate_recovery_base_ancestry; then', mixedPlan) >= 0,
    'il mixed recovery deve validare la base prima del r2-plan',
  );
});

test('il recovery shallow verifica la finestra breve prima del fallback storico', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'section-recovery-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const origin = path.join(root, 'origin');
  git(root, 'init', '--initial-branch=main', origin);
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.invalid');
  git(origin, 'commit', '--allow-empty', '-m', 'base');
  const oldBase = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'switch', '-c', 'other');
  git(origin, 'commit', '--allow-empty', '-m', 'divergent base');
  const divergentBase = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'switch', 'main');
  for (let index = 1; index <= 38; index += 1) {
    git(origin, 'commit', '--allow-empty', '-m', `main ${index}`);
  }
  const pin = git(origin, 'rev-parse', 'HEAD');
  const shortBase = git(origin, 'rev-parse', 'HEAD~6');
  const start = recovery.indexOf('ensure_recovery_history() {');
  const end = recovery.indexOf('\nif [ "${MIXED_MATRIX:-false}"', start);
  assert.ok(start >= 0 && end > start);
  const historyBlock = recovery.slice(start, end);
  const guardPath = new URL('../../scripts/ci/fetch-push-base-if-missing.sh', import.meta.url);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
if [ "$1" = fetch ]; then
  printf '%s\\n' "$*" >> "$FETCH_LOG"
  for arg in "$@"; do
    if [ "$arg" = --unshallow ] && [ "$REJECT_UNSHALLOW" = true ]; then
      exit 1
    fi
    if [ "$arg" = --depth=32 ] && [ "$REJECT_SHORT_FETCH" = true ]; then
      exit 1
    fi
  done
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const refspec = 'origin main:refs/remotes/origin/main';
  const shortFetch = `fetch --no-tags --depth=32 ${refspec}`;
  const fullFetch = `fetch --no-tags --unshallow ${refspec}`;
  const cases = [
    { name: 'sei commit di ancestry', base: shortBase, shallow: true, fetches: [shortFetch] },
    { name: 'mixed con scope esplicito', base: '0'.repeat(40), mixed: true, shallow: true, fetches: [shortFetch] },
    { name: 'stale con primo parent', base: '', shallow: true, fetches: [shortFetch] },
    { name: 'tip diverso dal pin', base: oldBase, expectedPin: shortBase, shallow: true,
      fetches: [shortFetch], error: /main e' avanzata durante il fetch breve/u },
    { name: 'base fuori finestra', base: oldBase, shallow: false, fetches: [shortFetch, fullFetch] },
    { name: 'fetch breve fallito', base: shortBase, rejectShort: true, shallow: false,
      fetches: [shortFetch, fullFetch] },
    { name: 'fallback esaurito', base: oldBase, shallow: true,
      fetches: [shortFetch, fullFetch, fullFetch, fullFetch],
      error: /storia Git non verificabile prima del recovery staged/u },
    { name: 'base divergente anche dopo il fallback', base: divergentBase, shallow: false,
      fetches: [shortFetch, fullFetch, `fetch --no-tags origin ${divergentBase}`],
      error: /base della push non antenata di CURRENT_MAIN/u },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, () => {
      const checkout = path.join(root, `checkout-${index}`);
      const fetchLog = path.join(checkout, 'fetch.log');
      git(root, 'clone', '--depth=1', pathToFileURL(origin).href, checkout);
      assert.equal(git(checkout, 'rev-parse', '--is-shallow-repository'), 'true');
      mkdirSync(path.join(checkout, 'scripts/ci'), { recursive: true });
      writeFileSync(path.join(checkout, 'scripts/ci/fetch-push-base-if-missing.sh'), readFileSync(guardPath));

      const result = spawnSync('bash', ['-c', `set -euo pipefail
${historyBlock}
ensure_recovery_history || exit 1
validate_recovery_base_ancestry || exit 1
printf 'history verified\\n'
`], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          REAL_GIT: realGit,
          FETCH_LOG: fetchLog,
          REJECT_UNSHALLOW: String(scenario.shallow),
          REJECT_SHORT_FETCH: String(scenario.rejectShort ?? false),
          CURRENT_MAIN: scenario.expectedPin ?? pin,
          ORIGINAL_PUSH_BEFORE: scenario.base,
          MIXED_MATRIX: String(scenario.mixed ?? false),
          HISTORY_FETCH_ATTEMPTS: '3',
          HISTORY_FETCH_DELAY_S: '0',
          HISTORY_FETCH_TIMEOUT_S: '30',
        },
      });
      assert.ifError(result.error);
      assert.equal(result.status, scenario.error ? 1 : 0, result.stdout + result.stderr);
      if (scenario.error) {
        assert.match(result.stdout, scenario.error);
        assert.doesNotMatch(result.stdout, /history verified/u);
      } else {
        assert.match(result.stdout, /history verified/u);
      }
      assert.deepEqual(readFileSync(fetchLog, 'utf8').trim().split('\n'), scenario.fetches);
      assert.equal(git(checkout, 'rev-parse', '--is-shallow-repository'), String(scenario.shallow));
      if (scenario.base === shortBase) {
        git(checkout, 'merge-base', '--is-ancestor', shortBase, pin);
      }
    });
  }
});
