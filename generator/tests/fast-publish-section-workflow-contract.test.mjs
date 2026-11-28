import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workflow = readFileSync(
  new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url),
  'utf8',
);
const apiOnlyListenerWorkflow = readFileSync(
  new URL('../../.github/workflows/fast-publish-api-only-listener.yml', import.meta.url),
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

const boundedDispatch = readFileSync(new URL('../../scripts/ci/dispatch-bounded-section-replay.sh', import.meta.url), 'utf8');
const coordinatorScript = readFileSync(new URL('../../scripts/ci/fast-publish-section-coordinate.sh', import.meta.url), 'utf8');
const lateApiRecovery = readFileSync(new URL('../../scripts/ci/fast-publish-section-late-api-recovery.sh', import.meta.url), 'utf8');

function triggerBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  assert.ok(start >= 0, `trigger ${name} missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:/u);
  return next < 0 ? rest : rest.slice(0, next);
}

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:`, workflow.indexOf('\njobs:'));
  assert.ok(start >= 0, `job ${name} missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:/u);
  return next < 0 ? rest : rest.slice(0, next);
}

test('stage, coordinator e finalize rispettano la barriera e un solo slot pending per sezione', () => {
  const stage = jobBlock('stage');
  const coordinator = jobBlock('coordinate_api_release');
  const finalize = jobBlock('finalize');
  assert.match(stage, /^    name: stage \(\$\{\{ matrix\.target\.section \}\}\)$/mu,
    'il nome effettivo della matrix stage deve mantenere la sezione leggibile da M3');
  assert.match(finalize, /^    name: finalize \(\$\{\{ matrix\.target\.section \}\}\)$/mu,
    'il nome effettivo della matrix finalize deve mantenere la sezione leggibile da M3');

  for (const [name, job] of [
    ['stage', stage],
    ['finalize', finalize],
  ]) {
    assert.match(job, /^    concurrency:\n(?: {6}[^\n]*\n)*/mu);
    assert.match(job, /^      group: \$\{\{ matrix\.target\.group \|\| format\('fast-publish-\{0\}', matrix\.target\.section\) \}\}$/mu);
    assert.match(job, /^      cancel-in-progress: false$/mu);
    assert.match(job, /^      queue: single$/mu, `${name} must keep one waiting run per section`);
  }
  assert.match(stage, /fromJSON\(needs\.resolve\.outputs\.stage_matrix\)/u);
  assert.match(finalize, /fromJSON\(needs\.coordinate_api_release\.outputs\.final_matrix\)/u);
  assert.match(stage, /max-parallel: 4/u);
  assert.match(coordinator, /needs: \[resolve, stage\]/u);
  assert.match(coordinator, /needs\.resolve\.outputs\.any == 'true'/u);
  assert.doesNotMatch(coordinator, /needs\.stage\.result == 'success'/u, 'nessuna barriera tutto-o-niente sullo stage');
  assert.match(coordinator, /final_matrix: \$\{\{ steps\.decision\.outputs\.final_matrix \}\}/u);
  assert.ok(workflow.indexOf('\n  stage:') < workflow.indexOf('\n  coordinate_api_release:'));
  assert.ok(workflow.indexOf('\n  coordinate_api_release:') < workflow.indexOf('\n  finalize:'));

  const dispatch = coordinator.indexOf('- name: Dispatch publish-api for the staged release');
  assert.ok(dispatch >= 0, 'coordinator must dispatch after the stage barrier');
  assert.doesNotMatch(coordinator, /wait-fast-publish-api-readiness.mjs|Wait for the served API release/u,
    'the unscoped coordinator must finish without an API wait');
  assert.equal((coordinator.match(/gh workflow run publish-api\.yml/g) ?? []).length, 1);
  assert.match(finalize, /Wait for API release readiness while holding the section slot/u);
  assert.match(finalize, /FAST_PUBLISH_API_WAIT_MS: '5400000'/u);
  assert.ok(finalize.indexOf('Wait for API release readiness while holding the section slot')
    < finalize.indexOf('- name: Render and finalize latest section pages'));
  assert.match(finalize, /needs: \[resolve, stage, coordinate_api_release\]/u);
  assert.match(finalize, /needs\.coordinate_api_release\.result == 'success' \|\| needs\.coordinate_api_release\.result == 'skipped'/u);
  assert.doesNotMatch(finalize, /needs\.stage\.result == 'success'/u);
  assert.match(finalize, /Read latest main after acquiring the section slot/u);
});

test('la matrix finalize compare solo dopo l output del coordinator globale', () => {
  const coordinator = jobBlock('coordinate_api_release');
  const finalize = jobBlock('finalize');
  assert.match(finalize, /needs: \[resolve, stage, coordinate_api_release\]/u);
  assert.match(finalize, /target: \$\{\{ fromJSON\(needs\.coordinate_api_release\.outputs\.final_matrix\) \}\}/u);
  assert.match(coordinator, /final_matrix: \$\{\{ steps\.decision\.outputs\.final_matrix \}\}/u);
  assert.doesNotMatch(coordinator, /wait-fast-publish-api-readiness\.mjs/u,
    'il coordinator resta un barrier job globale breve; il wait avviene solo quando esiste finalize per target');
  assert.match(finalize, /Wait for API release readiness while holding the section slot/u);
});

test('la classificazione separa lo stage API dal render code-only e mantiene la riconciliazione API-only', () => {
  assert.match(resolver, /r2-api-data-range/);
  assert.match(resolver, /r2-api-stage-plan-range "\$before" "\$\{after:-HEAD\}"/u);
  assert.match(resolver, /api_action=dispatch/u);
  assert.match(resolver, /--push-trigger "\$before" "\$\{after:-HEAD\}" \.github\/workflows\/publish-api\.yml/u);
  assert.match(resolver, /publish_api_push_owner.*?api_action=wait/su);
  assert.match(resolver, /api_action=none/u);
  assert.match(resolver, /WORKFLOW_RUN_EVENT" = 'push'[\s\S]*?range_has_api_data[\s\S]*?matrix='\[\]'/u);
  assert.match(resolver, /api_action=wait/u);
  assert.match(resolver, /api_wait_commit="\$\{after:-\$\(git rev-parse HEAD\)\}"/u);
  assert.match(workflow, /stage_matrix: \$\{\{ steps\.plan\.outputs\.stage_matrix \}\}/u);
  assert.match(workflow, /api_action: \$\{\{ steps\.plan\.outputs\.api_action \}\}/u);
  assert.match(render, /TARGET_BOOTSTRAP:-false.*true[\s\S]*ARTICLE_IDS_JSON='\[\]'[\s\S]*BOOTSTRAP=true/u);
  assert.match(jobBlock('stage'), /ARTICLE_IDS_JSON: '\[\]'[\s\S]*BOOTSTRAP: true/u);
  assert.match(jobBlock('finalize'), /ALLOW_DEFERRED_LIVE_RELEASE: false/u);
});

test('i target stale cedono al pending per sezione senza dispatchare altri run', () => {
  assert.match(jobBlock('stage'), /steps\.render\.outputs\.stale_handoff == 'true'[\s\S]*nessun dispatch API effettuato/u);
  assert.match(jobBlock('finalize'), /section-source-unaffected\.sh --section "\$SECTION" "\$stage_source" "\$observed"/u);
  assert.match(jobBlock('stage'), /DEFER_STALE_HANDOFF: true/u);
  assert.match(jobBlock('finalize'), /DEFER_STALE_HANDOFF: true/u);
  assert.match(render, /defer_stale_handoff\(\)/u);
  assert.doesNotMatch(workflow, /Dispatch bounded replay with current corpus checkout/u);
  assert.doesNotMatch(workflow, /gh run list --repo .*fast-publish-section/u);
});

test('il finalize recupera una stage cross-phase sostituita con bootstrap latest nello stesso slot', () => {
  const finalize = jobBlock('finalize');
  assert.match(finalize, /group: \$\{\{ matrix\.target\.group \|\| format\('fast-publish-\{0\}', matrix\.target\.section\) \}\}/u);
  assert.match(finalize, /queue: single/u);
  assert.match(finalize, /CLEANUP_INACTIVE_SURFACE: \$\{\{ matrix\.target\.cleanupInactiveSurface \|\| false \}\}/u);
  assert.match(finalize, /if \[ "\$CLEANUP_INACTIVE_SURFACE" = 'true' \]; then[\s\S]*?eligible=true[\s\S]*?r2-section-eligible/u);
  assert.match(finalize, /sectionChanged:\$sectionChanged[\s\S]*?r2-late-finalize-recovery/u);
  assert.match(finalize, /DEFER_API_WAIT: \$\{\{ needs\.coordinate_api_release\.outputs\.defer_api_wait \|\| false \}\}/u);
  assert.match(finalize, /name: Restage latest section before API readiness/u);
  assert.match(finalize, /name: Wait for recovered API release readiness/u);
  assert.match(finalize, /TARGET_BOOTSTRAP: true/u);
  assert.match(finalize, /ALLOW_DEFERRED_LIVE_RELEASE: true/u);
  assert.match(finalize, /queue: single[\s\S]*?Read latest main after acquiring the section slot/u);
  assert.match(finalize, /Acquire bootstrap R2 gate for recovery stage[\s\S]*?Restage latest section before API readiness[\s\S]*?Release bootstrap R2 gate after recovery stage[\s\S]*?Resolve late API release after recovery stage[\s\S]*?Wait for recovered API release readiness[\s\S]*?Acquire bootstrap R2 gate for finalization[\s\S]*?Render and finalize latest section pages/u);
  assert.match(finalize, /FULL_SECTION_LATEST_RECOVERY: true/u);
  assert.match(finalize, /PREFLIGHT_HEAD: \$\{\{ needs\.resolve\.outputs\.preflight_head \}\}/u);
  assert.match(finalize, /elif \[ "\$CLEANUP_INACTIVE_SURFACE" != 'true' \][\s\S]*?\[\[ "\$\{PREFLIGHT_HEAD:-\}" =~ \^\[a-f0-9\]\{40\}\$ \]\][\s\S]*?stage_source="\$PREFLIGHT_HEAD"/u);
  assert.match(finalize, /force_full_section=false[\s\S]*?stage_source="\$PREFLIGHT_HEAD"[\s\S]*?force_full_section=true/u,
    'qualunque target attivo senza artifact forza full-section latest, anche con ids vuoti e preflight già latest');
  assert.match(finalize, /--argjson forceFullSection "\$force_full_section"[\s\S]*?forceFullSection:\$forceFullSection[\s\S]*?r2-late-finalize-recovery/u);
  assert.match(finalize, /\[ "\$targeted" != 'true' \][\s\S]*?force_full_section=true/u,
    'il full-section forzato vale solo per i bounded senza ID e senza pagine 404 note (dispatch mirati: render mirato)');
  assert.match(finalize, /if \[ "\$CLEANUP_INACTIVE_SURFACE" != 'true' \][\s\S]*?section-source-unaffected\.sh --section/u,
    'cleanup-only non deve essere convertito in full-section render');
  assert.match(finalize, /ARTICLE_IDS_JSON: \$\{\{ steps\.start_source\.outputs\.rebootstrap == 'true' && '\[\]' \|\| toJSON\(matrix\.target\.ids\) \}\}/u);
  assert.match(finalize, /MISSING_PAGE_PATHS_JSON: \$\{\{ toJSON\(matrix\.target\.missingPagePaths/u,
    'il recovery full-section conserva i path 404 verificati');
  assert.match(finalize, /KNOWN_MISSING_PAGE_PATHS_JSON: \$\{\{ toJSON\(matrix\.target\.knownMissingPagePaths/u,
    'il recovery full-section conserva il set dei 404 noti');
  assert.match(lateApiRecovery, /r2-api-data-range "\$baseline" "\$STAGED_HEAD"/u);
  assert.match(lateApiRecovery, /wait-fast-publish-api-readiness\.mjs --probe-once/u);
  assert.match(lateApiRecovery, /r2-late-api-recovery/u);
  assert.match(lateApiRecovery, /automaticPublisherOwner/);
  assert.match(lateApiRecovery, /gh workflow run publish-api\.yml[\s\S]*?source_commit=\$api_commit/u);
});

test('fast-publish-section non crea run push sui branch di PR', () => {
  const push = triggerBlock('push');
  assert.match(push, /\n    branches: \[main\]/u);
  assert.doesNotMatch(push, /branches-ignore/u);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\non:')), /\n  pull_request:/u);
});

test('il listener separato ascolta solo publish-api verde su main', () => {
  const runStart = apiOnlyListenerWorkflow.indexOf('\n  workflow_run:');
  assert.ok(runStart >= 0, 'manca il trigger workflow_run nel listener');
  const run = apiOnlyListenerWorkflow.slice(runStart + 1, apiOnlyListenerWorkflow.indexOf('\npermissions:', runStart));
  assert.match(run, /workflows: \['Publish article data API'\]/u);
  assert.match(run, /types: \[completed\]/u);
  assert.match(run, /branches: \[main\]/u);
  assert.match(apiOnlyListenerWorkflow, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(apiOnlyListenerWorkflow, /github\.event\.workflow_run\.head_branch == 'main'/u);
  assert.doesNotMatch(workflow, /^  workflow_run:/mu, 'la workflow Fast non deve creare run di follow-up');
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

test('il coordinator usa il marker range e fa readiness HTTP senza polling GitHub', () => {
  const coordinator = jobBlock('coordinate_api_release');
  const finalize = jobBlock('finalize');
  const pushRange = workflow.slice(
    workflow.indexOf('- name: Resolve originating push range'),
    workflow.indexOf('- name: Fetch push base (resolve)'),
  );
  assert.match(coordinator, /bing_seo_nonce="fast-publish-range-\$\{before\}-\$\{API_COMMIT\}"/u);
  assert.doesNotMatch(coordinator, /wait-fast-publish-api-readiness\.mjs/u);
  assert.match(finalize, /Wait for API release readiness while holding the section slot/u);
  assert.match(finalize, /steps\.start_source\.outputs\.rebootstrap != 'true' && needs\.coordinate_api_release\.outputs\.wait_api == 'true'/u);
  assert.match(finalize, /run: node scripts\/ci\/wait-fast-publish-api-readiness\.mjs/u);
  assert.doesNotMatch(coordinator, /gh run list|gh api .*actions\/runs/u);
  assert.match(resolver, /workflow_run del dispatch API gia' coperto dal push Fast Publish/u);
  assert.match(pushRange, /if \[ "\$range_source" != 'fast-publish-range-title' \][\s\\]*&& \[ "\$after" != "\$WORKFLOW_RUN_HEAD_SHA" \]/u);
});

test('il coordinator dispatcha e il finalize attende HTTP sotto lo slot della sezione', () => {
  const dispatchBranch = coordinatorScript.slice(coordinatorScript.indexOf('if [ "$API_ACTION" = \'dispatch\' ]; then'));
  assert.match(dispatchBranch, /if \[ "\$can_dispatch" = 'true' \]; then\n\s+action=dispatch\n\s+wait_api=true\n\s+api_commit="\$latest"/u);
  const coordinator = jobBlock('coordinate_api_release');
  const finalize = jobBlock('finalize');
  assert.match(coordinator, /- name: Dispatch publish-api for the staged release/u);
  assert.doesNotMatch(coordinator, /Wait for the served API release|wait-fast-publish-api-readiness\.mjs/u);
  assert.match(finalize, /group: \$\{\{ matrix\.target\.group[\s\S]*?queue: single/u);
  assert.match(finalize, /if: steps\.start_source\.outputs\.fresh == 'true' && steps\.start_source\.outputs\.rebootstrap != 'true' && needs\.coordinate_api_release\.outputs\.wait_api == 'true'[\s\S]*?wait-fast-publish-api-readiness\.mjs/u);
});

test('il producer stage artifactizza la revisione completa osservata nello slot', () => {
  const stage = jobBlock('stage');
  assert.match(stage, /Read main after acquiring the section slot/u);
  assert.match(stage, /sourceCommit: \$sourceCommit, staged: true/u);
  assert.match(stage, /Upload stage artifact/u);
  assert.match(stage, /name: fast-publish-stage-\$\{\{ matrix\.target\.section \}\}/u);
  assert.match(stage, /SOURCE_COMMIT: \$\{\{ steps\.start_source\.outputs\.head \}\}/u);
});

test('il dispatcher riconosce il run-name con coorte dopo dry-run', () => {
  assert.match(workflow, /run-name:.*dry=\$\{\{ inputs\.dry_run \}\} \/ c=/u);
  assert.match(replayDispatcher, /test\(" \/ dry=false\(\?: \/ c=\[\^\/\]\+\)\?\$"\)/u);
  assert.match(replayDispatcher, /test\(" \/ dry=true\(\?: \/ c=\[\^\/\]\+\)\?\$"\)/u);
});

test('il wait API rimane sotto lo slot cantonale e il coordinator non attende fuori gruppo', () => {
  const coordinator = jobBlock('coordinate_api_release');
  const finalize = jobBlock('finalize');
  assert.doesNotMatch(coordinator, /^    concurrency:/mu);
  assert.match(coordinator, /needs: \[resolve, stage\]/u);
  assert.match(coordinator, /timeout-minutes: 190/u);
  assert.doesNotMatch(coordinator, /FAST_PUBLISH_API_WAIT_MS|wait-fast-publish-api-readiness\.mjs/u);
  assert.match(finalize, /group: \$\{\{ matrix\.target\.group[\s\S]*?queue: single/u);
  assert.match(finalize, /FAST_PUBLISH_API_WAIT_MS: '5400000'/u);
  assert.match(finalize, /Wait for API release readiness while holding the section slot/u);
});

test('fast-publish-section richiama resolver esterni senza incorporare script nel workflow', () => {
  assert.match(workflow, /- name: Materialize resolver from workflow revision/u);
  assert.match(workflow, /scripts\/ci\/fast-publish-section-resolve\.sh/u);
  const resolve = jobBlock('resolve');
  assert.match(resolve, /run: \|\n\s+bash scripts\/ci\/fast-publish-section-resolve\.sh/u);
  assert.ok(resolve.length < 21_000, `inline resolver job too large: ${resolve.length}`);
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

test('la guardia di sezione distingue gli input di pubblicazione dai file di controllo e dai test', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'section-source-unaffected-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const guard = fileURLToPath(new URL('../../scripts/ci/section-source-unaffected.sh', import.meta.url));
  git('init', '--quiet', '--object-format=sha1');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('commit', '--quiet', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  const check = (expected, current, status, label) => {
    const result = spawnSync('bash', [guard, expected, current], { cwd: root, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, status, `${label}\n${result.stderr}`);
  };

  const commitFiles = (label, ...files) => {
    for (const file of files) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${label}\n`);
    }
    git('add', '.');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };

  const generationHead = commitFiles('translator e test alla radice',
    'generator/scripts/lib/free-translate.mjs', 'generator/tests/translation.test.mjs');
  check(base, generationHead, 0, 'translator e test alla radice');
  const nestedTestHead = commitFiles('test annidato', 'generator/tests/translation/recovery.test.mjs');
  check(generationHead, nestedTestHead, 0, 'test annidato');
  check(nestedTestHead, base, 1, 'intervallo senza fast-forward con sole modifiche escluse');
  check('HEAD', nestedTestHead, 1, 'SHA malformata');

  const lintConfig = '.github/actionlint.yaml';
  const controlHead = commitFiles('configurazione lint', lintConfig);
  check(nestedTestHead, controlHead, 0, 'sola aggiunta della configurazione lint');
  const lintHead = commitFiles('aggiornamento della configurazione lint', lintConfig);
  check(controlHead, lintHead, 0, 'solo aggiornamento della configurazione lint');

  const admissionGate = 'scripts/ci/canton-generation-admit.mjs';
  const syncManifest = 'scripts/ci/loop-sync-manifest.json';
  const admissionHead = commitFiles('gate di ammissione, test e manifest',
    admissionGate, 'generator/tests/canton-generation-admit.test.mjs', syncManifest);
  check(lintHead, admissionHead, 0, 'gate di ammissione, test e manifest');

  const article = 'content/blog-body-canton-ti/it/article.ts';
  const cases = [
    ['contenuto di sezione e test', article, 'generator/tests/content.test.mjs'],
    ['aggiornamento del contenuto di sezione e configurazione lint', article, lintConfig],
    ['workflow di pubblicazione', '.github/workflows/fast-publish-section.yml'],
    ['script di pubblicazione e test', 'scripts/publish-section-pages.mjs', 'generator/tests/publisher.test.mjs'],
    ['script di riconciliazione con gate di ammissione e manifest',
      'scripts/reconcile-section-pages.mjs', admissionGate, syncManifest],
    ['fixture', 'generator/tests/translation/fixture.json'],
    ['libreria sconosciuta', 'generator/scripts/lib/unknown.mjs'],
  ];
  let previous = admissionHead;
  for (const [label, ...files] of cases) {
    const current = commitFiles(label, ...files);
    check(previous, current, 1, label);
    previous = current;
  }

  const reconcilePath = '.github/workflows/reconcile-section-pages.yml';
  const beforeScheduling = `name: Reconcile section pages
on:
  workflow_dispatch:
    inputs:
      cap:
        default: '3'
      retry_pending:
        default: false
        type: boolean

concurrency:
  group: reconcile-section-pages
  cancel-in-progress: false

permissions:
  contents: read
  actions: write

jobs:
  reconcile:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    steps:
      - run: node scripts/reconcile-section-pages.mjs
`;
  const afterScheduling = beforeScheduling
    .replace('concurrency:\n  group: reconcile-section-pages\n', [
      '# Coalesce runs of the same event while reserving a pending slot for each trigger.',
      'concurrency:',
      '  group: reconcile-section-pages-${{ github.event_name }}',
      '  queue: single',
      '',
    ].join('\n'))
    .replace('  reconcile:\n', [
      '  reconcile:',
      '    concurrency:',
      '      group: reconcile-section-pages',
      '      queue: max',
      '      cancel-in-progress: false',
      '',
    ].join('\n'));
  const writeReconcile = (source) => writeFileSync(path.join(root, reconcilePath), source);
  const commitReconcile = (label) => {
    git('add', '.');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  writeReconcile(beforeScheduling);
  const schedulingBase = commitReconcile('workflow iniziale');
  writeReconcile(afterScheduling);
  const schedulingHead = commitReconcile('migrazione di scheduling approvata');
  check(schedulingBase, schedulingHead, 0, 'solo delta approvato');

  for (const [label, source] of [
    ['migrazione con modifica al cap di detection/backfill', afterScheduling.replace("default: '3'", "default: '4'")],
    ['migrazione con queue diversa', afterScheduling.replace('queue: single', 'queue: max')],
  ]) {
    git('checkout', '--quiet', '--detach', schedulingBase);
    writeReconcile(source);
    check(schedulingBase, commitReconcile(label), 1, label);
  }

  git('checkout', '--quiet', '--detach', schedulingHead);
  writeReconcile(afterScheduling.replace('contents: read', 'contents: write'));
  const bodyHead = commitReconcile('modifica al body del workflow');
  check(schedulingHead, bodyHead, 1, 'modifica al body dopo la migrazione');
  check(schedulingBase, bodyHead, 1, 'migrazione con modifica al body');
  git('checkout', '--quiet', '--detach', schedulingHead);
  git('update-index', '--chmod=+x', reconcilePath);
  git('commit', '--quiet', '-m', 'modifica al solo mode');
  const modeHead = git('rev-parse', 'HEAD');
  check(schedulingHead, modeHead, 1, 'modifica al solo mode dopo la migrazione');
  check(schedulingBase, modeHead, 1, 'migrazione con modifica al mode');

  const shardPath = '.github/workflows/reconcile-article-shards.yml';
  const readWorkflow = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const writeShard = (source) => writeFileSync(path.join(root, shardPath), source);
  const laneSuffix = "-${{ github.event_name == 'workflow_run' && format('workflow_run-{0}', github.event.workflow_run.event) || github.event_name }}";
  const sectionLanes = readWorkflow(reconcilePath);
  const shardLanes = readWorkflow(shardPath);
  const sectionBeforeLanes = sectionLanes
    .replace('# Keep one pending run per trigger, splitting workflow_run by parent event.\n# The shared job group serializes reconciliation across triggers.',
      '# Coalesce runs of the same event while reserving a pending slot for each trigger.')
    .replace(laneSuffix, '-${{ github.event_name }}');
  const shardBeforeLanes = shardLanes
    .replace('# Uno slot in attesa per trigger, con workflow_run distinto per evento padre.\n# Il gruppo condiviso del job serializza le riconciliazioni.',
      '# Una riconciliazione alla volta; mai cancellarne una a metà dei dispatch.')
    .replace(`${laneSuffix}\n  queue: single`, '')
    .replace('    concurrency:\n      group: reconcile-article-shards\n      queue: max\n      cancel-in-progress: false\n', '');

  git('checkout', '--quiet', '--force', '--detach', schedulingHead);
  writeReconcile(sectionBeforeLanes);
  writeShard(shardBeforeLanes);
  const laneBase = commitReconcile('workflow prima delle code per trigger');

  writeReconcile(sectionLanes);
  const sectionLaneHead = commitReconcile('delta della sezione');
  check(laneBase, sectionLaneHead, 0, 'solo delta della sezione');

  writeShard(shardLanes);
  const bothLaneHead = commitReconcile('delta degli shard');
  check(sectionLaneHead, bothLaneHead, 0, 'solo delta degli shard');
  check(laneBase, bothLaneHead, 0, 'entrambi i delta approvati');
  check(bothLaneHead, laneBase, 1, 'intervallo inverso');

  writeReconcile(sectionBeforeLanes);
  writeShard(shardBeforeLanes);
  check(bothLaneHead, commitReconcile('ripristino delle code precedenti'), 1, 'delta inversi in fast-forward');

  git('checkout', '--quiet', '--detach', laneBase);
  writeShard(shardLanes);
  const shardLaneHead = commitReconcile('delta degli shard sul ramo parallelo');
  check(laneBase, shardLaneHead, 0, 'delta degli shard con sezione invariata');
  check(sectionLaneHead, shardLaneHead, 1, 'rami divergenti');

  for (const [label, section, shard] of [
    ['sezione con modifica ai permessi', sectionLanes.replace('contents: read', 'contents: write'), shardLanes],
    ['shard con policy di coda diversa', sectionLanes, shardLanes.replace('queue: single', 'queue: max')],
  ]) {
    git('checkout', '--quiet', '--detach', laneBase);
    writeReconcile(section);
    writeShard(shard);
    check(laneBase, commitReconcile(label), 1, label);
  }

  for (const [label, file] of [
    ['delta approvati con modifica al contenuto', article],
    ['delta approvati con modifica alla guardia', 'scripts/ci/section-source-unaffected.sh'],
  ]) {
    git('checkout', '--quiet', '--detach', bothLaneHead);
    check(laneBase, commitFiles(label, file), 1, label);
  }
});

test('la guardia R2 scopa body, metadata, hub, registry e immagini alla sezione proprietaria', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'section-source-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const guard = fileURLToPath(new URL('../../scripts/ci/section-source-unaffected.sh', import.meta.url));
  const planner = fileURLToPath(new URL('../../scripts/ci/fast-publish-section.mjs', import.meta.url));
  git('init', '--quiet', '--object-format=sha1');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  mkdirSync(path.join(root, 'scripts/ci'), { recursive: true });
  symlinkSync(planner, path.join(root, 'scripts/ci/fast-publish-section.mjs'));

  const registry = (id, image) => `export const CANTON_ARTICLES = [{ id: '${id}', image: '/images/blog/${image}' }];\n`;
  const registryState = (ti, vd) => JSON.stringify({
    schema: 1,
    sections: {
      'canton-ti': { status: ti },
      'canton-vd': { status: vd },
    },
  });
  const baseFiles = new Map([
    ['sections/registry.json', registryState('draft', 'draft')],
    ['content/cantons/canton-ti/registry.ts', registry('ti-article', 'ti.webp')],
    ['content/cantons/canton-vd/registry.ts', registry('vd-article', 'vd.webp')],
    ['content/blog-meta-canton-ti-it.ts', `const META = {\n  'blog.article.ti-article.title': 'TI',\n};\n`],
    ['content/blog-meta-canton-vd-it.ts', `const META = {\n  'blog.article.vd-article.title': 'VD',\n};\n`],
  ]);
  for (const [file, source] of baseFiles) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  git('add', '.');
  git('commit', '--quiet', '-m', 'R2 fixture base');
  const base = git('rev-parse', 'HEAD');

  const commitFile = (label, file, source) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
    git('add', '.');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  const check = (section, expected, current, status, label) => {
    const result = spawnSync('bash', [guard, '--section', section, expected, current], { cwd: root, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, status, `${label} / ${section}\n${result.stderr}`);
  };

  let previous = base;
  let current = commitFile('body VD', 'content/blog-body-canton-vd/it/vd-article.ts', 'export default "VD";\n');
  check('canton-ti', previous, current, 0, 'body di VD non invalida TI');
  check('canton-vd', previous, current, 1, 'body di VD invalida VD');
  previous = current;

  current = commitFile('hub VD', 'content/cantons/canton-vd/hubs/local-news.json', '{"schema":1}\n');
  check('canton-ti', previous, current, 0, 'hub di VD non invalida TI');
  check('canton-vd', previous, current, 1, 'hub di VD invalida VD');
  previous = current;

  current = commitFile('metadata VD', 'content/blog-meta-canton-vd-it.ts', `const META = {\n  'blog.article.vd-article.title': 'VD aggiornato',\n};\n`);
  check('canton-ti', previous, current, 0, 'metadata VD non invalida TI');
  check('canton-vd', previous, current, 1, 'metadata VD invalida VD');
  previous = current;

  current = commitFile('immagine VD', 'public/images/blog/vd.webp', 'asset');
  check('canton-ti', previous, current, 0, 'asset di VD non invalida TI');
  check('canton-vd', previous, current, 1, 'asset di VD invalida VD');
  previous = current;

  current = commitFile('promozione VD', 'sections/registry.json', registryState('draft', 'live'));
  check('canton-ti', previous, current, 0, 'flip registry VD non invalida TI');
  check('canton-vd', previous, current, 1, 'flip registry VD invalida VD');
});

test('stage e finalize leggono latest soltanto dopo avere acquisito lo slot per sezione', () => {
  const materializer = workflow.slice(
    workflow.indexOf('\n      - name: Materialize resolver from workflow revision'),
    workflow.indexOf('\n      - name: Set up Node (resolve)'),
  );
  assert.match(materializer, /fallback git-transport/u);
  assert.match(materializer, /git ls-remote --refs/u);
  for (const name of ['stage', 'finalize']) {
    const job = jobBlock(name);
    assert.match(job, /Read main after acquiring the section slot|Read latest main after acquiring the section slot/u);
    assert.match(job, /bash scripts\/ci\/read-main-head\.sh/u);
    assert.match(job, /git checkout --detach "\$observed"/u);
  }
});

test('fast-publish-section delega preflight e render a script shell senza espressioni YAML', () => {
  for (const name of ['preflight', 'render']) {
    const path = `scripts/ci/fast-publish-section-${name}.sh`;
    const checkout = '';
    assert.ok(workflow.includes(`run: bash ${checkout}${path}\n`), `workflow must run ${checkout}${path}`);
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.match(source, /^#!\/usr\/bin\/env bash/u);
    assert.match(source, /^set -euo pipefail$/mu);
    assert.doesNotMatch(source, /\$\{\{/u);
  }
});

test('un target diventato stale cede al pending senza dispatchare un altro Fast Publish', () => {
  assert.match(render, /defer_stale_handoff\(\)/u);
  assert.match(render, /DEFER_STALE_HANDOFF:-false/u);
  assert.match(render, /target \$SECTION ceduto alla run latest/u);
  assert.match(jobBlock('stage'), /DEFER_STALE_HANDOFF: true/u);
  assert.match(jobBlock('finalize'), /DEFER_STALE_HANDOFF: true/u);
  assert.doesNotMatch(jobBlock('stage'), /dispatch-fast-publish-replay|dispatch-bounded-section-replay/u);
  assert.doesNotMatch(jobBlock('finalize'), /dispatch-fast-publish-replay|dispatch-bounded-section-replay/u);
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

test('il coordinator prepara Remote Config prima del dispatch API', () => {
  const coordinator = jobBlock('coordinate_api_release');
  const runtime = coordinator.indexOf('- name: Setup isolated article source runtime for Remote Config');
  const dispatch = coordinator.indexOf('- name: Dispatch publish-api for the staged release');
  assert.ok(runtime >= 0 && dispatch > runtime);
  assert.match(coordinator.slice(runtime, dispatch), /Install dependencies for Remote Config/u);
  assert.match(coordinator.slice(runtime, dispatch), /Load dispatch token from Remote Config/u);
  assert.ok(boundedDispatch.includes('import { resolveStaleReplayApiReleaseCommit } from "./scripts/publish-section-pages.mjs"'));
});

test('reconcile evita un backfill duplicato sulla stessa revisione e conserva la coorte del flip', () => {
  const source = readFileSync(new URL('../../.github/workflows/reconcile-section-pages.yml', import.meta.url), 'utf8');
  const start = source.indexOf('          set -euo pipefail', source.indexOf('- name: Backfill (dispatch'));
  const end = source.indexOf('\n      # Il workflow_run di un child', start);
  assert.ok(start >= 0 && end > start);
  const root = mkdtempSync(path.join(tmpdir(), 'section-reconcile-active-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commitFile = (file, content) => {
    writeFileSync(path.join(root, file), content);
    git('add', file);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const commit = commitFile('article.txt', 'article\n');
  const ledger = commitFile('data/discovery-attempt-state.json', '{}\n');
  const changed = commitFile('article.txt', 'changed article\n');
  const pending = (section, status, sha = commit) => ({
    head_sha: sha,
    status,
    display_title: `cover-publish-section / ${section} / nonce=reconcile-42-${section} / dry=false / c=reconcile-42-n1`,
  });
  try {
    mkdirSync(path.join(root, 'scripts/ci'), { recursive: true });
    writeFileSync(path.join(root, 'scripts/ci/read-main-head.sh'),
      'if [ -f main-after-dispatch ]; then cat main-after-dispatch; else printf "%s\\n" "$FAKE_MAIN"; fi\n');
    writeFileSync(path.join(root, 'scripts/ci/section-source-unaffected.sh'),
      readFileSync(new URL('../../scripts/ci/section-source-unaffected.sh', import.meta.url)));
    writeFileSync(path.join(root, 'reconcile-sections.json'), JSON.stringify({
      sections: ['canton-appenzello', 'canton-ti', 'canton-ne'].map((section) => ({
        section, dispatch: true, selected: [], missingPagePaths: [], knownMissingPagePaths: [],
      })),
    }));
    const run = (pendingFlip, main = commit, afterDispatch = '', activeRuns, release = commit) => execFileSync('bash', ['-c', [
      'rm -f main-after-dispatch',
      'gh() { if [ "$1" = api ]; then '
        + 'case "$PENDING_EDGE_FLIP:$*" in true:*created*|false:*created*) [ "$PENDING_EDGE_FLIP" = false ] || return 1;; false:*) return 1;; esac; '
        + 'printf "%s" "$ACTIVE_RUNS"; else printf "%s\\n" "$@"; '
        + 'if [ -n "$MAIN_AFTER_DISPATCH" ]; then printf "%s\\n" "$MAIN_AFTER_DISPATCH" > main-after-dispatch; fi; fi; }',
      'date() { echo 2026-11-19T04:00:00Z; }',
      source.slice(start, end),
    ].join('\n')], {
      cwd: root,
      env: {
        ...process.env, RUNNER_TEMP: root, GITHUB_PAT_NANAKO: 'test-token', GITHUB_REPOSITORY: 'test/corpus',
        GITHUB_RUN_ID: '123', PENDING_EDGE_FLIP: pendingFlip, SOURCE_COMMIT: commit, API_RELEASE_COMMIT: release,
        FAKE_MAIN: main, MAIN_AFTER_DISPATCH: afterDispatch,
        ACTIVE_RUNS: JSON.stringify([{ workflow_runs: activeRuns ?? [
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
    const key = flip.match(/dispatch_nonce=reconcile-123-([a-f0-9]{32})-canton-ti/)[1];
    const cohort = ['canton-ne', 'canton-ti', 'canton-appenzello'].map((section) => ({
      ...pending(section, section === 'canton-ti' ? 'completed' : 'queued'),
      conclusion: section === 'canton-ti' ? 'success' : null,
      created_at: '2026-11-18T12:00:00Z',
      display_title: `cover-publish-section / ${section} / nonce=reconcile-42-${key}-${section} / dry=false / c=reconcile-42-n3`,
    }));
    const reused = run('true', commit, '', [pending('canton-ti', 'queued'), ...cohort]);
    assert.match(reused, /Coorte equivalente/);
    assert.doesNotMatch(reused, /dispatch_nonce=/);
    assert.match(run('true', commit, '', cohort.slice(1)), /dispatch_cohort=reconcile-123-n3/);
    assert.match(run('true', commit, '', cohort, ledger), /dispatch_cohort=reconcile-123-n3/);
    cohort[1].conclusion = 'failure';
    assert.match(run('true', commit, '', cohort), /dispatch_cohort=reconcile-123-n3/);

    const repinned = run('true', ledger);
    assert.equal(repinned.match(new RegExp(`^source_commit=${ledger}$`, 'gm'))?.length, 3);
    assert.equal(repinned.match(new RegExp(`^source_main_commit=${ledger}$`, 'gm'))?.length, 3);
    const advancing = run('true', commit, ledger);
    assert.equal(advancing.match(new RegExp(`^source_commit=${commit}$`, 'gm'))?.length, 3);
    assert.equal(advancing.match(new RegExp(`^source_main_commit=${commit}$`, 'gm'))?.length, 3);
    assert.doesNotMatch(run('true', changed), /dispatch_nonce=/);
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

test('il recovery shallow verifica le finestre bounded prima del fallback storico', async (t) => {
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
  for (let index = 1; index <= 130; index += 1) {
    git(origin, 'commit', '--allow-empty', '-m', `main ${index}`);
  }
  const pin = git(origin, 'rev-parse', 'HEAD');
  const shortBase = git(origin, 'rev-parse', 'HEAD~6');
  const deeperBase = git(origin, 'rev-parse', 'HEAD~35');
  git(origin, 'switch', '-c', 'advanced-main');
  git(origin, 'commit', '--allow-empty', '-m', 'advanced main');
  git(origin, 'switch', 'main');
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
    if [ "$arg" = --depth=128 ] && [ "$MOVE_SECOND_TIP" = true ]; then
      exec "$REAL_GIT" fetch --no-tags "$arg" origin advanced-main:refs/remotes/origin/main
    fi
  done
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const refspec = 'origin main:refs/remotes/origin/main';
  const shortFetch = `fetch --no-tags --depth=32 ${refspec}`;
  const deeperFetch = `fetch --no-tags --depth=128 ${refspec}`;
  const fullFetch = `fetch --no-tags --unshallow ${refspec}`;
  const cases = [
    { name: 'sei commit di ancestry', base: shortBase, shallow: true, fetches: [shortFetch] },
    { name: '35 commit di ancestry', base: deeperBase, shallow: true, fetches: [shortFetch, deeperFetch] },
    { name: 'mixed con scope esplicito', base: '0'.repeat(40), mixed: true, shallow: true, fetches: [shortFetch] },
    { name: 'stale con primo parent', base: '', shallow: true, fetches: [shortFetch] },
    { name: 'tip diverso dal pin', base: oldBase, expectedPin: shortBase, shallow: true,
      fetches: [shortFetch], error: /main e' avanzata durante il fetch breve/u },
    { name: 'tip diverso dal pin al secondo fetch', base: deeperBase, moveSecondTip: true, shallow: true,
      fetches: [shortFetch, deeperFetch], error: /main e' avanzata durante il fetch breve/u },
    { name: 'base fuori finestra', base: oldBase, shallow: false, fetches: [shortFetch, deeperFetch, fullFetch] },
    { name: 'fetch breve fallito', base: shortBase, rejectShort: true, shallow: false,
      fetches: [shortFetch, fullFetch] },
    { name: 'fallback esaurito', base: oldBase, shallow: true,
      fetches: [shortFetch, deeperFetch, fullFetch, fullFetch, fullFetch],
      error: /storia Git non verificabile prima del recovery staged/u },
    { name: 'base divergente anche dopo il fallback', base: divergentBase, shallow: false,
      fetches: [shortFetch, deeperFetch, fullFetch, `fetch --no-tags origin ${divergentBase}`],
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
          MOVE_SECOND_TIP: String(scenario.moveSecondTip ?? false),
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

test('replay equivalenti condividono il nonce anche quando avanza il codice operativo', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'section-replay-identity-'));
  const helper = fileURLToPath(new URL('../../scripts/ci/section-source-unaffected.sh', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = (file) => {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), file);
    git('add', file);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };
  const nonce = (head, slug = 'first') => execFileSync('bash', [
    helper, '--replay-nonce', head, 'canton-tg',
    '-f', `source_commit=${head}`, '-f', `source_main_commit=${head}`,
    '-f', `push_after=${head}`, '-f', `article_ids=["${slug}"]`,
  ], { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    const original = commit('content/article.ts');
    commit('generator/scripts/create-article.mjs');
    commit('generator/data/crawler-cross-repo-contract.json');
    const equivalent = commit('.github/workflows/translate-pending.yml');
    const changed = commit('content/another.ts');
    assert.match(nonce(original), /^stale-late-[0-9a-f]{12}-canton-tg-[0-9a-f]{16}$/u);
    assert.equal(nonce(original), nonce(equivalent));
    assert.notEqual(nonce(original), nonce(changed));
    assert.notEqual(nonce(equivalent), nonce(equivalent, 'second'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il verificatore riusa solo prove stale-late di revisioni equivalenti', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'section-cohort-bookkeeping-'));
  const fixture = path.join(root, 'corpus');
  const verifier = fileURLToPath(new URL('../../scripts/ci/verify-fast-publish-section-cohort.sh', import.meta.url));
  const freshness = new URL('../../scripts/ci/section-source-unaffected.sh', import.meta.url);
  try {
    mkdirSync(path.join(fixture, 'scripts/ci'), { recursive: true });
    mkdirSync(path.join(fixture, 'data'));
    writeFileSync(path.join(fixture, 'scripts/ci/section-source-unaffected.sh'), readFileSync(freshness));
    const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim();
    git('init', '-q');
    const commit = (file, content) => {
      writeFileSync(path.join(fixture, file), content);
      git('add', file);
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', file);
      return git('rev-parse', 'HEAD');
    };
    const source = commit('article.txt', 'Original article\n');
    const bookkeeping = commit('data/discovery-attempt-state.json', '{}\n');
    for (let index = 0; index < 70; index += 1) {
      commit('data/discovery-attempt-state.json', `${JSON.stringify({ index })}\n`);
    }
    const current = commit('data/blog-cover-cdn-sync-queue.json', '[]\n');
    const changed = commit('article.txt', 'Changed article\n');
    const origin = path.join(root, 'origin.git');
    git('clone', '--quiet', '--bare', fixture, origin);
    git('remote', 'add', 'origin', `file://${origin}`);
    const nonce = 'stale-late-fixture';
    const fakeGh = path.join(root, 'gh');
    writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  api) printf '%s\\n' "$FIXTURE_RUN" ;;
  run)
    if [[ "$2" == download && "$3" == 43 ]]; then
      printf '%s\\n' "$FIXTURE_ARTIFACT_SIBLING" > "${'${!#}'}/fast-publish-result.json"
    else
      printf '%s\\n' "$FIXTURE_ARTIFACT" > "${'${!#}'}/fast-publish-result.json"
    fi ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const check = (mode, expected, {
      artifactSource = source,
      renderedHead = artifactSource,
      runHead = source,
      siblingHead,
      siblingPin = artifactSource,
      cohort = 'stale-late-42-canton-ur-n1',
    } = {}) => {
      const output = path.join(root, 'output');
      writeFileSync(output, '');
      execFileSync('bash', [verifier], {
        cwd: fixture,
        env: {
          ...process.env, PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root, GITHUB_OUTPUT: output,
          REPOSITORY: 'fixture/corpus', MODE: mode, EXPECTED_SOURCE_COMMIT: expected,
          WORKFLOW_RUN_ID: '42', WORKFLOW_RUN_HEAD_SHA: runHead, CHILD_NONCE: nonce, CHILD_COHORT: cohort,
          FIXTURE_RUN: [
            {
              databaseId: 42, displayTitle: `cover-publish-section / canton-ur / nonce=${nonce} / dry=false / c=${cohort}`,
              status: 'completed', conclusion: 'success', headSha: runHead, createdAt: '2026-11-21T10:00:00Z',
            },
            ...(siblingHead ? [{
              databaseId: 43, displayTitle: `cover-publish-section / canton-ti / nonce=sibling / dry=false / c=${cohort}`,
              status: 'completed', conclusion: 'success', headSha: siblingHead, createdAt: '2026-11-21T10:01:00Z',
            }] : []),
          ].map((run) => JSON.stringify(run)).join('\n'),
          FIXTURE_ARTIFACT: JSON.stringify({
            section: 'canton-ur', dispatch_nonce: nonce, dispatch_cohort: cohort,
            source_commit: artifactSource, source_main_commit: artifactSource, rendered_head: renderedHead,
            fresh: 'true', coordinated_recovery: 'true',
          }),
          FIXTURE_ARTIFACT_SIBLING: JSON.stringify({
            section: 'canton-ti', dispatch_nonce: 'sibling', dispatch_cohort: cohort,
            source_commit: siblingPin, source_main_commit: siblingPin, rendered_head: siblingPin,
            fresh: 'true', coordinated_recovery: 'true',
          }),
        },
      });
      return readFileSync(output, 'utf8').split('\n')[0];
    };
    assert.equal(
      check('event', current, { artifactSource: source, runHead: bookkeeping }),
      'verified=true',
      'event validates the pinned source separately from the event HEAD',
    );
    for (const mode of ['event', 'schedule']) {
      const reconcile = { cohort: 'reconcile-42-n1', artifactSource: source, runHead: bookkeeping };
      assert.equal(check(mode, current, reconcile), 'verified=true', `${mode} accepts reconciled bookkeeping drift`);
      const siblings = { ...reconcile, cohort: 'reconcile-42-n2', siblingHead: current };
      assert.equal(check(mode, current, siblings), 'verified=true', `${mode} accepts sibling runs with equivalent heads`);
      assert.equal(
        check(mode, current, { ...siblings, siblingPin: bookkeeping }),
        'verified=false',
        `${mode} requires one pinned source for the entire cohort`,
      );
      assert.equal(check(mode, changed, reconcile), 'verified=false', `${mode} rejects changed publication inputs`);
      assert.equal(
        check(mode, current, { artifactSource: source, runHead: bookkeeping }),
        'verified=true',
        `${mode} accepts an equivalent run HEAD`,
      );
      assert.equal(
        check(mode, changed, { artifactSource: source, runHead: changed }),
        'verified=false',
        `${mode} rejects a changed publication source`,
      );
    }
    assert.equal(
      check('event', current, { artifactSource: source, renderedHead: bookkeeping, runHead: bookkeeping }),
      'verified=false',
      'event artifact rendered HEAD must match its pinned source',
    );
    assert.equal(
      check('schedule', current, { artifactSource: source, renderedHead: bookkeeping, runHead: bookkeeping }),
      'verified=false',
      'schedule artifact rendered HEAD must match its pinned source',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
