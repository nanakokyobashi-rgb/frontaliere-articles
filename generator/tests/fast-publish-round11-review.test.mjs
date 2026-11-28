// Round 11 di F1: scenari della review indipendente (BLOCK) che le fixture
// precedenti non vedevano. Ogni test riproduce uno scenario sul codice vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  annotateSlotGroups,
  r2FinalizeIsTargetedDispatch,
  r2LateFinalizeRecoveryDecision,
} from '../../scripts/ci/fast-publish-section.mjs';
import {
  fastPublishReadiness,
  isCommitDescendantOf,
  waitForFastPublishApiReadiness,
} from '../../scripts/ci/wait-fast-publish-api-readiness.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(path.join(repoRoot, '.github/workflows/fast-publish-section.yml'), 'utf8');
const resolver = readFileSync(path.join(repoRoot, 'scripts/ci/fast-publish-section-resolve.sh'), 'utf8');

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:`, workflow.indexOf('\njobs:'));
  assert.ok(start >= 0, `job ${name} missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:/u);
  return next < 0 ? rest : rest.slice(0, next);
}

function stepBlock(job, name) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  assert.ok(start >= 0, `step "${name}" assente`);
  const rest = job.slice(start + marker.length);
  const next = rest.search(/\n      - name: /u);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Valuta le sole espressioni del workflow usate negli env degli step. */
function evaluateExpression(expression, context) {
  const atoms = expression.split('||').map((atom) => atom.trim());
  for (const atom of atoms) {
    let value;
    if (/^'.*'$/u.test(atom)) value = atom.slice(1, -1);
    else if (atom === 'false' || atom === 'true') value = atom;
    else if (Object.hasOwn(context, atom)) value = context[atom];
    else throw new Error(`espressione non risolvibile nel test: ${atom}`);
    if (value !== '' && value !== undefined && value !== false) return String(value);
  }
  return '';
}

function stepEnv(step, context, keys = null) {
  const env = {};
  const block = step.slice(step.indexOf('        env:\n'), step.indexOf('        run:'));
  for (const line of block.split('\n')) {
    const match = line.match(/^ {10}([A-Z_]+): (.*)$/u);
    if (!match || (keys && !keys.includes(match[1]))) continue;
    env[match[1]] = match[2].replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_, expression) => evaluateExpression(expression, context));
    if (/^'.*'$/u.test(env[match[1]])) env[match[1]] = env[match[1]].slice(1, -1);
  }
  return env;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd, file, content) {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

// ───────── HIGH 1: artifact di coorte prodotto dal workflow ─────────

test('HIGH 1: il finalize registra e carica fast-publish-result con i valori reali degli input', () => {
  const finalize = jobBlock('finalize');
  const record = stepBlock(finalize, 'Record publish result');
  const upload = stepBlock(finalize, 'Upload publish result');
  assert.match(record, /if: always\(\)/u);
  assert.match(upload, /name: fast-publish-result-\$\{\{ matrix\.target\.section \}\}/u);
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/fast-publish-result\.json/u);

  const source = 'c'.repeat(40);
  const context = {
    'matrix.target.section': 'canton-ti',
    'inputs.dispatch_nonce': 'reconcile-9-plan-canton-ti',
    'inputs.dispatch_cohort': 'reconcile-9-n1',
    'inputs.coordinated_recovery': 'true',
    'inputs.source_commit': source,
    'inputs.source_main_commit': source,
    'needs.resolve.outputs.source_commit': '',
    'steps.render.outputs.rendered_head': source,
    'steps.render.outputs.stale_handoff': '',
    'steps.render.outputs.stale_handoff_head': '',
    'steps.render.outputs.stale_handoff_nonce': '',
    'steps.render.outputs.stale_handoff_title': '',
    'steps.start_source.outputs.fresh': 'true',
    'github.event_name': 'workflow_dispatch',
  };
  const render = stepEnv(
    stepBlock(finalize, 'Render and finalize latest section pages'),
    context,
    ['COORDINATED_RECOVERY', 'DISPATCH_NONCE', 'DISPATCH_COHORT'],
  );
  assert.equal(render.COORDINATED_RECOVERY, 'true', 'il render finale non forza piu coordinated_recovery=false');
  assert.equal(render.DISPATCH_NONCE, 'reconcile-9-plan-canton-ti');
  assert.equal(render.DISPATCH_COHORT, 'reconcile-9-n1');

  // Esegue il recorder del workflow con l'env che il workflow stesso calcola.
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r11-cohort-'));
  try {
    const recorderEnv = stepEnv(record, context);
    const runnerTemp = path.join(root, 'runner');
    mkdirSync(runnerTemp);
    execFileSync('bash', [path.join(repoRoot, 'scripts/ci/record-fast-publish-result.sh')], {
      env: { ...process.env, ...recorderEnv, RUNNER_TEMP: runnerTemp },
    });
    const produced = JSON.parse(readFileSync(path.join(runnerTemp, 'fast-publish-result.json'), 'utf8'));
    assert.deepEqual(
      { ...produced },
      {
        section: 'canton-ti',
        rendered_head: source,
        stale_handoff: 'false',
        stale_handoff_head: '',
        stale_handoff_nonce: '',
        stale_handoff_title: '',
        fresh: 'true',
        dispatch_nonce: 'reconcile-9-plan-canton-ti',
        dispatch_cohort: 'reconcile-9-n1',
        coordinated_recovery: 'true',
        source_commit: source,
        source_main_commit: source,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIGH 1: il verificatore di coorte del reconciler accetta l artifact prodotto dal workflow del figlio', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r11-e2e-'));
  const fixture = path.join(root, 'corpus');
  try {
    mkdirSync(path.join(fixture, 'scripts/ci'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'scripts/ci/section-source-unaffected.sh'),
      readFileSync(path.join(repoRoot, 'scripts/ci/section-source-unaffected.sh')),
    );
    git(fixture, 'init', '-q');
    const source = commit(fixture, 'article.txt', 'article\n');
    const origin = path.join(root, 'origin.git');
    git(fixture, 'clone', '--quiet', '--bare', fixture, origin);
    git(fixture, 'remote', 'add', 'origin', `file://${origin}`);

    const finalize = jobBlock('finalize');
    const nonce = 'reconcile-7-canton-ti';
    const cohort = 'reconcile-7-n1';
    const context = {
      'matrix.target.section': 'canton-ti',
      'inputs.dispatch_nonce': nonce,
      'inputs.dispatch_cohort': cohort,
      'inputs.coordinated_recovery': 'true',
      'inputs.source_commit': source,
      'inputs.source_main_commit': source,
      'needs.resolve.outputs.source_commit': '',
      'steps.render.outputs.rendered_head': source,
      'steps.render.outputs.stale_handoff': '',
      'steps.render.outputs.stale_handoff_head': '',
      'steps.render.outputs.stale_handoff_nonce': '',
      'steps.render.outputs.stale_handoff_title': '',
      'steps.start_source.outputs.fresh': 'true',
    };
    const runnerTemp = path.join(root, 'runner');
    mkdirSync(runnerTemp);
    execFileSync('bash', [path.join(repoRoot, 'scripts/ci/record-fast-publish-result.sh')], {
      env: { ...process.env, ...stepEnv(stepBlock(finalize, 'Record publish result'), context), RUNNER_TEMP: runnerTemp },
    });
    const artifact = readFileSync(path.join(runnerTemp, 'fast-publish-result.json'), 'utf8');

    const fakeGh = path.join(root, 'gh');
    writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  api) printf '%s\\n' "$FIXTURE_RUN" ;;
  run) printf '%s\\n' "$FIXTURE_ARTIFACT" > "\${!#}/fast-publish-result.json" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const output = path.join(root, 'output');
    writeFileSync(output, '');
    const verifyOut = execFileSync('bash', [path.join(repoRoot, 'scripts/ci/verify-fast-publish-section-cohort.sh')], {
      encoding: 'utf8',
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: output,
        REPOSITORY: 'fixture/corpus',
        MODE: 'event',
        EXPECTED_SOURCE_COMMIT: source,
        WORKFLOW_RUN_ID: '42',
        WORKFLOW_RUN_HEAD_SHA: source,
        CHILD_NONCE: nonce,
        CHILD_COHORT: cohort,
        FIXTURE_ARTIFACT: artifact,
        FIXTURE_RUN: JSON.stringify({
          databaseId: 42,
          displayTitle: `cover-publish-section / canton-ti / nonce=${nonce} / dry=false / c=${cohort}`,
          status: 'completed',
          conclusion: 'success',
          headSha: source,
          createdAt: '2026-11-28T10:00:00Z',
        }),
      },
    });
    assert.match(readFileSync(output, 'utf8'), /^verified=true$/mu, verifyOut);

    // Controllo negativo: con i valori che il finalize forzava prima del fix
    // (coordinated_recovery=false, coorte vuota) la coorte non e verificata.
    const forced = { ...context, 'inputs.coordinated_recovery': 'false', 'inputs.dispatch_cohort': '' };
    execFileSync('bash', [path.join(repoRoot, 'scripts/ci/record-fast-publish-result.sh')], {
      env: { ...process.env, ...stepEnv(stepBlock(finalize, 'Record publish result'), forced), RUNNER_TEMP: runnerTemp },
    });
    writeFileSync(output, '');
    execFileSync('bash', [path.join(repoRoot, 'scripts/ci/verify-fast-publish-section-cohort.sh')], {
      cwd: fixture,
      env: {
        ...process.env, PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root, GITHUB_OUTPUT: output,
        REPOSITORY: 'fixture/corpus', MODE: 'event', EXPECTED_SOURCE_COMMIT: source, WORKFLOW_RUN_ID: '42',
        WORKFLOW_RUN_HEAD_SHA: source, CHILD_NONCE: nonce, CHILD_COHORT: cohort,
        FIXTURE_ARTIFACT: readFileSync(path.join(runnerTemp, 'fast-publish-result.json'), 'utf8'),
        FIXTURE_RUN: JSON.stringify({
          databaseId: 42,
          displayTitle: `cover-publish-section / canton-ti / nonce=${nonce} / dry=false / c=${cohort}`,
          status: 'completed', conclusion: 'success', headSha: source, createdAt: '2026-11-28T10:00:00Z',
        }),
      },
    });
    assert.match(readFileSync(output, 'utf8'), /^verified=false$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIGH 1: un figlio pinnato rende la revisione attestata se la sezione non e cambiata', () => {
  const pinned = 'a'.repeat(40);
  const latest = 'b'.repeat(40);
  assert.equal(r2LateFinalizeRecoveryDecision({
    latestCommit: latest, pinnedCommit: pinned, pinnedUnaffected: true, targeted: true,
  }).renderCommit, pinned);
  assert.equal(r2LateFinalizeRecoveryDecision({
    latestCommit: latest, pinnedCommit: pinned, pinnedUnaffected: false, targeted: true,
  }).renderCommit, latest, 'sezione cambiata: si pubblica la HEAD osservata');
  assert.equal(r2LateFinalizeRecoveryDecision({ latestCommit: latest }).renderCommit, latest);
  const start = stepBlock(jobBlock('finalize'), 'Read latest main after acquiring the section slot');
  assert.match(start, /echo "head=\$render_commit"/u);
});

// ───────── HIGH 2: readiness con release discendente ─────────

test('HIGH 2: B attende C_B, publish-api salta C_B e pubblica C_A discendente: la readiness passa', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r11-ready-'));
  try {
    git(root, 'init', '-q');
    const base = commit(root, 'a.txt', '0\n');
    const cB = commit(root, 'b.txt', 'B\n');
    const cA = commit(root, 'a.txt', 'A\n');
    git(root, 'checkout', '-q', '-b', 'side', base);
    const unrelated = commit(root, 'c.txt', 'C\n');

    assert.equal(isCommitDescendantOf(cA, cB, { cwd: root }), true, 'C_A discende da C_B');
    assert.equal(isCommitDescendantOf(cB, cB, { cwd: root }), true);
    assert.equal(isCommitDescendantOf(base, cB, { cwd: root }), false, 'un antenato non copre il commit atteso');
    assert.equal(isCommitDescendantOf(unrelated, cB, { cwd: root }), false, 'un ramo non discendente non copre');

    const report = (commitSha, extra = {}) => ({
      skipped: null,
      apiCommit: commitSha,
      edgeCommit: commitSha,
      pendingEdgeFlip: false,
      sectionStatuses: { 'canton-ti': 'live' },
      sections: [{
        section: 'canton-ti', expectedMissingPagePaths: [], missingIds: [], leftover: [], unknown: [], pageManifest: 'ok', dispatch: false,
        ...extra,
      }],
    });
    const isDescendant = (actual, expected) => isCommitDescendantOf(actual, expected, { cwd: root });
    assert.equal(fastPublishReadiness(report(cA), { section: 'canton-ti', expectedCommit: cB, isDescendant }).ready, true);
    assert.equal(fastPublishReadiness(report(unrelated), { section: 'canton-ti', expectedCommit: cB, isDescendant }).ready, false);
    assert.equal(fastPublishReadiness(report(base), { section: 'canton-ti', expectedCommit: cB, isDescendant }).ready, false);
    // La copertura delle pagine della sezione resta obbligatoria.
    assert.equal(fastPublishReadiness(
      report(cA, { expectedMissingPagePaths: ['/articoli-ticino/x/'] }),
      { section: 'canton-ti', expectedCommit: cB, isDescendant },
    ).ready, false);
    assert.equal(fastPublishReadiness(
      { ...report(cA), edgeCommit: cB, pendingEdgeFlip: true },
      { section: 'canton-ti', expectedCommit: cB, isDescendant },
    ).ready, false, 'un flip edge pendente blocca anche con release discendente');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIGH 2: senza release discendente il wait si chiude con un esito dichiarato entro il tetto', async () => {
  let now = 0;
  const expected = 'a'.repeat(40);
  const served = 'b'.repeat(40);
  await assert.rejects(waitForFastPublishApiReadiness({
    sections: ['canton-ti'],
    expectedCommit: expected,
    waitMs: 1000,
    attemptBudgetMs: 100,
    retryDelayMs: 400,
    now: () => now,
    sleepImpl: async (delay) => { now += delay; },
    log: () => {},
    isDescendant: () => false,
    reconcileImpl: async () => ({
      skipped: null, apiCommit: served, edgeCommit: served, pendingEdgeFlip: false, sectionStatuses: {}, sections: [],
    }),
  }), (error) => {
    assert.match(error.message, /esito=readiness-timeout/u);
    assert.ok(error.message.includes(expected) && error.message.includes(served), 'atteso e osservato nel messaggio');
    return true;
  });
  const waits = [...workflow.matchAll(/FAST_PUBLISH_API_WAIT_MS: '(\d+)'/gu)].map((match) => Number(match[1]));
  assert.ok(waits.length >= 2 && waits.every((ms) => ms <= 90 * 60 * 1000), 'tetto di attesa <= 90 minuti sotto lo slot');
});

// ───────── MEDIUM 3: barriera non tutto-o-niente ─────────

test('MEDIUM 3: con X sostituito (senza artifact) e Y staged, il coordinator procede con Y soltanto', () => {
  const coordinator = jobBlock('coordinate_api_release');
  const finalize = jobBlock('finalize');
  assert.match(coordinator, /!cancelled\(\)/u);
  assert.doesNotMatch(coordinator, /needs\.stage\.result/u);
  assert.doesNotMatch(finalize, /needs\.stage\.result/u);
  assert.match(finalize, /!cancelled\(\)/u);
  assert.match(finalize, /contains\(fromJSON\(needs\.coordinate_api_release\.outputs\.staged_sections/u);

  const root = mkdtempSync(path.join(tmpdir(), 'f1-r11-barrier-'));
  try {
    const fixture = path.join(root, 'corpus');
    mkdirSync(path.join(fixture, 'scripts/ci'), { recursive: true });
    git(fixture, 'init', '-q');
    const latest = commit(fixture, 'a.txt', '1\n');
    writeFileSync(path.join(fixture, 'scripts/ci/read-main-head.sh'), `#!/usr/bin/env bash\necho ${latest}\n`);
    writeFileSync(path.join(fixture, 'scripts/ci/section-source-unaffected.sh'), '#!/usr/bin/env bash\nexit 0\n');
    const realModule = path.join(repoRoot, 'scripts/ci/fast-publish-section.mjs');
    writeFileSync(path.join(fixture, 'scripts/ci/fast-publish-section.mjs'), `
import { readFileSync } from 'node:fs';
const mod = await import(${JSON.stringify(realModule)});
const [cmd] = process.argv.slice(2);
const input = () => JSON.parse(readFileSync(0, 'utf8'));
if (cmd === 'r2-api-stage-barrier') console.log(JSON.stringify(mod.r2ApiStageBarrierDecision(input())));
else if (cmd === 'r2-api-wait-defer') console.log(String(mod.r2ShouldDeferApiReadinessToFinalize(input())));
else if (cmd === 'r2-api-data-range') console.log('false');
else process.exit(2);
`);
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(path.join(artifacts, 'fast-publish-stage-canton-ow.json'),
      JSON.stringify({ section: 'canton-ow', sourceCommit: latest, staged: true }));
    const output = path.join(root, 'output');
    writeFileSync(output, '');
    const matrix = JSON.stringify([
      { section: 'canton-ti', ids: [], bootstrap: true },
      { section: 'canton-ow', ids: [], bootstrap: true },
    ]);
    execFileSync('bash', [path.join(repoRoot, 'scripts/ci/fast-publish-section-coordinate.sh')], {
      cwd: fixture,
      env: {
        ...process.env,
        API_ACTION: 'dispatch',
        STAGE_MATRIX: matrix,
        FINAL_MATRIX: matrix,
        EVENT_NAME: 'push',
        PUSH_AFTER: latest,
        GITHUB_OUTPUT: output,
        ARTIFACTS_DIR: artifacts,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
    assert.equal(outputs.action, 'dispatch');
    assert.equal(outputs.api_commit, latest);
    assert.deepEqual(JSON.parse(outputs.staged_sections), ['canton-ow']);
    assert.deepEqual(JSON.parse(outputs.final_matrix).map(({ section }) => section), ['canton-ow'],
      'canton-ti, senza stage, esce dalla matrix finale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ───────── MEDIUM 4: gruppo di concorrenza separato ─────────

test('MEDIUM 4: dry-run e target non eleggibili non condividono lo slot pending del push reale', () => {
  const matrix = [
    { section: 'canton-ti', ids: [], bootstrap: true },
    { section: 'canton-xx', ids: [], bootstrap: false },
    { section: 'canton-zz', ids: [], bootstrap: false, cleanupInactiveSurface: true },
  ];
  const eligible = (section) => section === 'canton-ti';
  assert.deepEqual(
    annotateSlotGroups(matrix, { dry: false, eligible }).map(({ group }) => group),
    ['fast-publish-canton-ti', 'fast-publish-idle-canton-xx', 'fast-publish-canton-zz'],
    'non eleggibile fuori slot; la pulizia di una sezione disattivata resta nel suo slot',
  );
  assert.deepEqual(
    annotateSlotGroups(matrix, { dry: true, eligible }).map(({ group }) => group),
    ['fast-publish-idle-canton-ti', 'fast-publish-idle-canton-xx', 'fast-publish-idle-canton-zz'],
    'un workflow_dispatch dry_run=true (default) non sostituisce un pending reale',
  );
  for (const name of ['stage', 'finalize']) {
    assert.match(jobBlock(name), /group: \$\{\{ matrix\.target\.group \|\| format\('fast-publish-\{0\}', matrix\.target\.section\) \}\}/u);
  }
  assert.equal((resolver.match(/r2-annotate-slots/gu) ?? []).length >= 3, true,
    'matrix e stage_matrix (percorso normale) e matrix (replan stale) sono annotate');
  const result = spawnSync('node', [path.join(repoRoot, 'scripts/ci/fast-publish-section.mjs'), 'r2-annotate-slots', 'true'], {
    input: '[]', encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '[]');
});

// ───────── MEDIUM 5: render mirato per i dispatch con ID/404 ─────────

test('MEDIUM 5: un figlio del reconciler con ids o missing_page_paths non diventa full-section doppio', () => {
  assert.equal(r2FinalizeIsTargetedDispatch({ eventName: 'workflow_dispatch', ids: ['a'] }), true);
  assert.equal(r2FinalizeIsTargetedDispatch({ eventName: 'workflow_dispatch', missingPagePaths: ['/x/'] }), true);
  assert.equal(r2FinalizeIsTargetedDispatch({ eventName: 'workflow_dispatch', ids: [], missingPagePaths: [] }), false,
    'bounded senza ID ne pagine: full-section');
  assert.equal(r2FinalizeIsTargetedDispatch({ eventName: 'workflow_dispatch', bootstrap: true, ids: ['a'] }), false);
  assert.equal(r2FinalizeIsTargetedDispatch({ eventName: 'push', ids: ['a'] }), false);

  const latest = 'f'.repeat(40);
  const stage = 'e'.repeat(40);
  const forced = { latestCommit: latest, stageCommit: stage, forceFullSection: true, deferApiWait: true, sectionChanged: true };
  assert.equal(r2LateFinalizeRecoveryDecision({ ...forced, targeted: false }).rebootstrap, true);
  assert.equal(r2LateFinalizeRecoveryDecision({ ...forced, targeted: true }).rebootstrap, false,
    'targeted: nessun render full-section sotto lock');
  assert.equal(r2LateFinalizeRecoveryDecision({ ...forced, targeted: true }).fullSection, false);

  const start = stepBlock(jobBlock('finalize'), 'Read latest main after acquiring the section slot');
  assert.match(start, /r2-targeted-dispatch/u);
  assert.match(start, /--argjson targeted "\$targeted"/u);
});

// ───────── LOW 6/7 ─────────

test('LOW 6/7: paths documentati e senza script non piu usati dal workflow', () => {
  const pushBlock = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('  workflow_dispatch:'));
  assert.match(pushBlock, /canton-sections\.json e canton-url-slugs\.json NON sono qui[\s\S]*fast-publish-api-only-listener\.yml/u);
  assert.doesNotMatch(pushBlock, /dispatch-bounded-section-replay\.sh|fast-publish-section-recovery\.sh/u);
  const jobs = workflow.slice(workflow.indexOf('\njobs:'));
  assert.doesNotMatch(jobs, /dispatch-bounded-section-replay\.sh|fast-publish-section-recovery\.sh/u);
});
