// Round 14 di F1: listener API-only anche per rilasci non-push (sul commit
// effettivamente pubblicato, solo sezioni indietro), recovery del finalize dopo
// readiness-timeout, nessun restage per i dispatch API-only, durata dei run
// completati. Ogni test gira sul codice vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideApiOnlyDispatch } from '../../scripts/ci/fast-publish-api-only-decision.mjs';
import {
  markReadinessTimeout,
  sectionsBehindRelease,
} from '../../scripts/ci/wait-fast-publish-api-readiness.mjs';
import { publishRunDurationMinutes } from '../../scripts/ci/measure-section-cadence.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');
const sectionWorkflow = read('.github/workflows/fast-publish-section.yml');
const listenerWorkflow = read('.github/workflows/fast-publish-api-only-listener.yml');

function writeExec(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function stepBlock(name) {
  const marker = `      - name: ${name}\n`;
  const start = sectionWorkflow.indexOf(marker);
  assert.ok(start >= 0, `step "${name}" assente`);
  const rest = sectionWorkflow.slice(start + marker.length);
  const next = rest.search(/\n      (?:#[^\n]*\n      )*- name: /u);
  return next < 0 ? rest : rest.slice(0, next);
}

const PUBLISHED = 'b'.repeat(40);
const live = (section) => ({ section, ids: [], bootstrap: true });

// ───────── 1. listener: rilasci non-push ─────────

test('1: il listener accetta ogni completion riuscita su main, non solo push', () => {
  assert.doesNotMatch(listenerWorkflow, /workflow_run\.event == 'push'/u);
  assert.match(listenerWorkflow, /workflow_run\.conclusion == 'success'/u);
  assert.match(listenerWorkflow, /workflow_run\.head_branch == 'main'/u);
});

test('1: decisione non-push con sezioni indietro dispatcha solo quelle; senza misura resta ignorata', () => {
  const targets = [live('canton-ti'), live('canton-gr'), live('canton-vs'),
    { section: 'canton-zz', ids: [], bootstrap: false, cleanupInactiveSurface: true }];
  const behind = decideApiOnlyDispatch({ isPush: false, reconciliationTargets: targets, behindSections: ['canton-gr'] });
  assert.equal(behind.skip, false);
  assert.deepEqual(behind.targets.map(({ section }) => section), ['canton-gr']);
  const current = decideApiOnlyDispatch({ isPush: false, reconciliationTargets: targets, behindSections: [] });
  assert.deepEqual(current, { skip: true, reason: 'non-push-api-release-current', targets: [] });
  const unmeasured = decideApiOnlyDispatch({ isPush: false, reconciliationTargets: targets });
  assert.deepEqual(unmeasured, { skip: true, reason: 'non-push-api-event', targets: [] });
  assert.throws(() => decideApiOnlyDispatch({ isPush: false, reconciliationTargets: targets, behindSections: ['canton-xx'] }), /assente dal piano/u);
});

function readinessReport({ api = PUBLISHED, edge = PUBLISHED, pendingEdgeFlip = false, missing = [] } = {}) {
  const sections = ['canton-ti', 'canton-gr'];
  return {
    skipped: null,
    apiCommit: api,
    edgeCommit: edge,
    pendingEdgeFlip,
    sectionStatuses: Object.fromEntries(sections.map((s) => [s, 'live'])),
    sections: sections.map((section) => ({
      section,
      pageManifest: 'ok',
      expectedMissingPagePaths: missing.includes(section) ? ['/x/'] : [],
      missingIds: [],
      leftover: [],
      unknown: [],
      dispatch: false,
    })),
  };
}

test('1: sectionsBehindRelease elenca solo le sezioni R2 indietro e rifiuta uno stato globale instabile', async () => {
  const sections = ['canton-ti', 'canton-gr'];
  const ok = await sectionsBehindRelease({ sections, expectedCommit: PUBLISHED, reconcileImpl: async () => readinessReport() });
  assert.deepEqual(ok.behind, []);
  const some = await sectionsBehindRelease({ sections, expectedCommit: PUBLISHED, reconcileImpl: async () => readinessReport({ missing: ['canton-gr'] }) });
  assert.deepEqual(some.behind, ['canton-gr']);
  await assert.rejects(
    sectionsBehindRelease({ sections, expectedCommit: PUBLISHED, isDescendant: () => false, reconcileImpl: async () => readinessReport({ edge: 'c'.repeat(40) }) }),
    /non ancora stabile/u,
  );
  await assert.rejects(
    sectionsBehindRelease({ sections, expectedCommit: PUBLISHED, reconcileImpl: async () => readinessReport({ pendingEdgeFlip: true }) }),
    /non ancora stabile/u,
  );
});

/** Esegue il listener in un repo git temporaneo con gli script di piano stubbati. */
function runListener(root, { event, behind, edgeCommit: edgeCommitOverride = null, marked = false }) {
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  mkdirSync(path.join(repo, 'scripts/ci'), { recursive: true });
  mkdirSync(path.join(repo, '.github/workflows'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'n');
  writeFileSync(path.join(repo, 'f'), '1');
  mkdirSync(path.join(repo, 'sections'), { recursive: true });
  writeFileSync(path.join(repo, 'sections/registry.json'), '{"schema":1}\n');
  git('add', 'f', 'sections/registry.json');
  git('commit', '-qm', 'one');
  const headSha = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'f'), '2');
  git('commit', '-qam', 'two');
  const published = git('rev-parse', 'HEAD');
  const workflowHeadSha = event === 'push' ? published : headSha;
  const edgeCommit = edgeCommitOverride ?? published;
  const log = path.join(root, 'calls.log');
  copyFileSync(path.join(repoRoot, 'scripts/ci/fast-publish-api-only-decision.mjs'), path.join(repo, 'scripts/ci/fast-publish-api-only-decision.mjs'));
  copyFileSync(path.join(repoRoot, 'scripts/ci/fast-publish-section-edge-candidate.sh'), path.join(repo, 'scripts/ci/fast-publish-section-edge-candidate.sh'));
  copyFileSync(path.join(repoRoot, '.github/workflows/fast-publish-section.yml'), path.join(repo, '.github/workflows/fast-publish-section.yml'));
  const rangeScript = [
    `if (process.argv.includes('--fast-publish-range')) process.exit(${marked ? 0 : 1});`,
    event === 'push'
      ? `console.log(${JSON.stringify(`before=${headSha}\nafter=${published}`)});`
      : 'process.exit(1);',
  ].join('\n');
  writeFileSync(path.join(repo, 'scripts/ci/resolve-workflow-run-push-range.mjs'), `${rangeScript}\n`);
  writeFileSync(path.join(repo, 'scripts/ci/fast-publish-section.mjs'), `
import { appendFileSync } from 'node:fs';
const [cmd, arg] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, cmd + ' ' + (arg ?? '') + '\\n');
if (cmd === 'r2-edge-release-commit') console.log(${JSON.stringify(edgeCommit)});
else if (cmd === 'r2-reconcile-plan') {
  if (arg !== ${JSON.stringify(edgeCommit)}) {
    console.error('registro edge sul commit ${edgeCommit}, atteso ' + arg);
    process.exit(1);
  }
  console.log(JSON.stringify([
    { section: 'canton-ti', ids: [], bootstrap: true }, { section: 'canton-gr', ids: [], bootstrap: true },
    { section: 'canton-vs', ids: [], bootstrap: true },
    { section: 'canton-zz', ids: [], bootstrap: false, cleanupInactiveSurface: true }]));
}
else if (cmd === 'r2-api-stage-plan-range') console.log(JSON.stringify([
  { section: 'canton-gr', ids: ['article-a'], bootstrap: false }]));
else process.exit(2);
`);
  writeFileSync(path.join(repo, 'scripts/ci/wait-fast-publish-api-readiness.mjs'), `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, 'behind ' + process.env.EXPECTED_API_COMMIT + ' ' + process.env.SECTIONS_JSON + '\\n');
console.log(JSON.stringify({ behind: ${JSON.stringify(behind)} }));
`);
  writeExec(bin, 'gh', `echo "$*" >> ${JSON.stringify(path.join(root, 'dispatch.log'))}`);
  const output = path.join(root, 'output');
  writeFileSync(output, '');
  const result = spawnSync('bash', [path.join(repoRoot, 'scripts/ci/fast-publish-api-only-listener.sh')], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: '777',
      REPO: 'owner/repo',
      WORKFLOW_RUN_EVENT: event,
      WORKFLOW_RUN_HEAD_SHA: workflowHeadSha,
      WORKFLOW_RUN_DISPLAY_TITLE: 'Publish article data API (automatic)',
      GITHUB_PAT_NANAKO: 'x',
    },
  });
  const dispatchLog = path.join(root, 'dispatch.log');
  return {
    result,
    published,
    headSha,
    workflowHeadSha,
    edgeCommit,
    dispatches: existsSync(dispatchLog) ? readFileSync(dispatchLog, 'utf8').trim().split('\n').filter(Boolean) : [],
    calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
    output: readFileSync(output, 'utf8'),
  };
}

function withRoot(prefix, fn) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const event of ['schedule', 'workflow_dispatch']) {
  test(`1: completion ${event}: riconcilia sul commit pubblicato (non head_sha) e dispatcha solo la sezione indietro`, () => withRoot(`f1-r14-${event}-`, (root) => {
    const { result, published, headSha, dispatches, calls, output } = runListener(root, { event, behind: ['canton-gr'] });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.notEqual(published, headSha);
    assert.match(calls, new RegExp(`r2-reconcile-plan ${published}`, 'u'));
    assert.match(calls, new RegExp(`behind ${published} \\["canton-gr","canton-ti","canton-vs"\\]`, 'u'), 'misura solo le live, non il cleanup');
    assert.equal(dispatches.length, 1, 'nessun fan-out sulle altre sezioni');
    assert.match(dispatches[0], /section=canton-gr/u);
    assert.match(dispatches[0], new RegExp(`api_release_commit=${published}`, 'u'));
    assert.doesNotMatch(dispatches[0], new RegExp(headSha, 'u'));
    assert.match(output, /dispatch_count=1/u);
  }), { timeout: 60_000 });
}

test('1: il listener push usa il registro edge antenato se la HEAD API è più nuova e il registry non è cambiato', () => withRoot('f1-r14-push-edge-ancestor-', (root) => {
  const { result, published, headSha, workflowHeadSha, edgeCommit, dispatches, calls, output } = runListener(root, {
    event: 'push',
    behind: [],
    edgeCommit: headSha,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(workflowHeadSha, published);
  assert.equal(edgeCommit, headSha);
  assert.notEqual(edgeCommit, workflowHeadSha);
  assert.match(calls, new RegExp(`r2-edge-release-commit\\n`));
  assert.match(calls, new RegExp(`r2-reconcile-plan ${edgeCommit}\\n`, 'u'));
  assert.doesNotMatch(calls, new RegExp(`r2-reconcile-plan ${workflowHeadSha}`, 'u'));
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0], /section=canton-gr/u);
  assert.match(dispatches[0], new RegExp(`api_release_commit=${workflowHeadSha}`, 'u'));
  assert.match(output, /dispatch_count=1/u);
}), { timeout: 60_000 });

test('1: lo schedule settimanale con tutte le sezioni aggiornate non dispatcha niente', () => withRoot('f1-r14-schedule-current-', (root) => {
  const { result, dispatches, output } = runListener(root, { event: 'schedule', behind: [] });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(dispatches, []);
  assert.match(output, /dispatch_count=0/u);
}), { timeout: 60_000 });

test('1: il workflow_dispatch API marcato Fast resta escluso e non legge nemmeno il registro', () => withRoot('f1-r14-marked-', (root) => {
  const { result, dispatches, calls } = runListener(root, { event: 'workflow_dispatch', behind: ['canton-gr'], marked: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(dispatches, []);
  assert.equal(calls, '');
}), { timeout: 60_000 });

// ───────── 2. readiness-timeout ─────────

test('2: il timeout della readiness marca l output dello step, gli altri errori no', () => withRoot('f1-r14-mark-', (root) => {
  const out = path.join(root, 'out');
  writeFileSync(out, '');
  assert.equal(markReadinessTimeout(new Error('esito=readiness-timeout: readiness ...'), out), true);
  assert.equal(readFileSync(out, 'utf8'), 'readiness_timeout=true\n');
  assert.equal(markReadinessTimeout(new Error('boom'), out), false);
  assert.equal(readFileSync(out, 'utf8'), 'readiness_timeout=true\n');
}));

test('2: il finalize accoda la recovery solo dopo un readiness-timeout, con la release attesa', () => {
  for (const id of ['wait_recovered_api', 'wait_slot_api']) {
    assert.match(sectionWorkflow, new RegExp(`id: ${id}\\n`, 'u'));
  }
  const step = stepBlock('Queue recovery after API readiness timeout');
  assert.match(step, /steps\.wait_recovered_api\.outputs\.readiness_timeout == 'true'/u);
  assert.match(step, /steps\.wait_slot_api\.outputs\.readiness_timeout == 'true'/u);
  assert.match(step, /needs\.resolve\.outputs\.dry != 'true'/u);
  assert.match(step, /continue-on-error: true/u);
  assert.match(step, /API_COMMIT: \$\{\{ steps\.late_api_recovery\.outputs\.api_commit \|\| needs\.coordinate_api_release\.outputs\.api_commit \}\}/u);
  assert.ok(sectionWorkflow.indexOf('- name: Queue recovery after API readiness timeout')
    < sectionWorkflow.indexOf('- name: Render and finalize latest section pages'));
  assert.match(sectionWorkflow, /- 'scripts\/ci\/fast-publish-section-readiness-recovery\.sh'/u);
});

/** `gh` finto: tiene i dispatch e li espone come run completate in `run list`. */
function runRecovery(root, { parentNonce = '', preexisting = false, apiCommit = PUBLISHED, runId = '5150', dispatchFails = false }) {
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeExec(bin, 'sleep', 'exit 0');
  writeExec(bin, 'gh', `
state="${state}"
case "$1 $2" in
  "workflow run")
    echo "$*" >> "$state/dispatch.log"
    ${dispatchFails ? 'exit 1' : 'for a in "$@"; do case "$a" in dispatch_nonce=*) echo "\${a#dispatch_nonce=}" >> "$state/nonces";; esac; done; exit 0'}
    ;;
  "run list")
    if [ -s "$state/nonces" ]; then
      while IFS= read -r n; do
        printf '{"databaseId":900,"displayTitle":"cover-publish-section / canton-ow / nonce=%s / dry=false / c=none","status":"completed","conclusion":"success"}\\n' "$n"
      done < "$state/nonces" | jq -sc .
    else echo '[]'; fi
    ;;
  *) echo "gh inatteso: $*" >&2; exit 1 ;;
esac
`);
  if (preexisting) writeFileSync(path.join(state, 'nonces'), `readiness-recovery-g1-${runId}-canton-ow\n`);
  const result = spawnSync('bash', [path.join(repoRoot, 'scripts/ci/fast-publish-section-readiness-recovery.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_RUN_ID: runId,
      SECTION: 'canton-ow',
      REPOSITORY: 'owner/repo',
      API_COMMIT: apiCommit,
      PARENT_NONCE: parentNonce,
      TARGET_IDS_JSON: '[]',
      TARGET_BOOTSTRAP: 'true',
      GITHUB_PAT_NANAKO: 'pat',
      REPLAY_PENDING_POLL_DELAY_SECONDS: '0',
    },
  });
  const log = path.join(state, 'dispatch.log');
  return { result, dispatches: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [] };
}

test('2: la recovery dispatcha la sezione con api_release_commit atteso e nonce legato al run', () => withRoot('f1-r14-rec-', (root) => {
  const { result, dispatches } = runRecovery(root, {});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0], new RegExp(`api_release_commit=${PUBLISHED}`, 'u'));
  assert.match(dispatches[0], /dispatch_nonce=readiness-recovery-g1-5150-canton-ow/u);
  assert.match(dispatches[0], /section=canton-ow/u);
  assert.match(dispatches[0], /dry_run=false/u);
}), { timeout: 60_000 });

test('2: un rerun dello stesso run non accoda una seconda recovery', () => withRoot('f1-r14-rec-rerun-', (root) => {
  const { result, dispatches } = runRecovery(root, { preexisting: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(dispatches, []);
}), { timeout: 60_000 });

test('2: la catena di recovery ha un tetto di 3 generazioni', () => {
  withRoot('f1-r14-rec-g2-', (root) => {
    const { result, dispatches } = runRecovery(root, { parentNonce: 'readiness-recovery-g2-1-canton-ow' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(dispatches[0], /dispatch_nonce=readiness-recovery-g3-5150-canton-ow/u);
  });
  withRoot('f1-r14-rec-g3-', (root) => {
    const { result, dispatches } = runRecovery(root, { parentNonce: 'readiness-recovery-g3-1-canton-ow' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(dispatches, []);
    assert.match(result.stdout, /nessuna ulteriore recovery/u);
  });
}, { timeout: 60_000 });

test('2: commit atteso non valido o token assente falliscono senza dispatch', () => withRoot('f1-r14-rec-bad-', (root) => {
  const { result, dispatches } = runRecovery(root, { apiCommit: 'zz' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(dispatches, []);
}), { timeout: 60_000 });

// ───────── 3. nessun restage per i dispatch API-only ─────────

test('3: un dispatch con api_release_commit non forza il bootstrap full-section prima del finalize', () => {
  const start = stepBlock('Read latest main after acquiring the section slot');
  assert.match(start, /API_RELEASE_COMMIT_INPUT: \$\{\{ inputs\.api_release_commit \}\}/u);
  assert.match(start, /\[ "\$targeted" != 'true' \] \\\n\s+&& \[ -z "\$\{API_RELEASE_COMMIT_INPUT:-\}" \] \\\n\s+&& \[\[ "\$\{PREFLIGHT_HEAD:-\}" =~/u);
  // Senza api_release_commit il comportamento storico resta: stage-less => full-section.
  assert.match(start, /force_full_section=true/u);
});

// ───────── 4. misura della cadenza ─────────

test('4(b): la durata di un run non completato e null, quella di un run chiuso e updatedAt - startedAt', () => {
  const base = { createdAt: '2026-11-28T10:00:00Z', startedAt: '2026-11-28T10:00:00Z', updatedAt: '2026-11-28T10:10:00Z' };
  assert.equal(publishRunDurationMinutes({ ...base, status: 'in_progress' }), null);
  assert.equal(publishRunDurationMinutes({ ...base, status: 'queued' }), null);
  assert.equal(publishRunDurationMinutes({ ...base, status: 'completed' }), 10);
  assert.equal(publishRunDurationMinutes(base), 10, 'senza status resta il comportamento storico');
});
