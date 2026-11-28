// Round 13 di F1: replay delle gambe di stage fallite non bloccante e
// idempotente, probe del finalize sostituito per sezione, conteggio degli stage
// artifact senza i marcatori `failed`. Ogni test gira sul codice vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(path.join(repoRoot, '.github/workflows/fast-publish-section.yml'), 'utf8');
const probe = path.join(repoRoot, 'scripts/ci/fast-publish-section-pending-probe.sh');
const coordinate = path.join(repoRoot, 'scripts/ci/fast-publish-section-coordinate.sh');

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

function writeExec(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

// ───────── MEDIUM 1: replay delle gambe fallite ─────────

test('MEDIUM 1: il replay sta dopo il dispatch API, non e bloccante e usa il dispatcher con retry', () => {
  const coordinator = jobBlock('coordinate_api_release');
  const step = stepBlock(coordinator, 'Replay full-section for failed stage legs');
  assert.ok(coordinator.indexOf('- name: Replay full-section for failed stage legs')
    > coordinator.indexOf('- name: Dispatch publish-api for the staged release'), 'dopo il dispatch API');
  assert.match(step, /continue-on-error: true/u);
  assert.match(step, /!cancelled\(\)/u);
  assert.match(step, /scripts\/ci\/dispatch-fast-publish-replay\.sh/u);
  assert.doesNotMatch(step, /^\s*gh workflow run/mu, 'nessun gh workflow run secco');
  assert.match(step, /nonce="replay-failed-stage-\$\{GITHUB_RUN_ID\}-\$\{section\}"/u);
  assert.match(step, /GITHUB_STEP_SUMMARY/u);
  assert.ok(coordinator.indexOf('- name: Replay full-section for failed stage legs')
    < coordinator.lastIndexOf('- name: Cleanup Firebase credentials'));
});

/** Esegue lo step del workflow con un `gh` finto che tiene lo stato dei dispatch. */
function runReplayStep(root, { failedSections, dispatchFails = false, preexisting = false, runId = '4242' }) {
  const step = stepBlock(jobBlock('coordinate_api_release'), 'Replay full-section for failed stage legs');
  const script = step.split('        run: |\n')[1].split('\n').map((l) => l.replace(/^ {10}/u, '')).join('\n');
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
    ${dispatchFails ? 'echo "HTTP 502" >&2; exit 1' : 'for a in "$@"; do case "$a" in dispatch_nonce=*) echo "\${a#dispatch_nonce=}" >> "$state/nonces";; section=*) echo "\${a#section=}" >> "$state/sections";; esac; done; exit 0'}
    ;;
  "run list")
    # Un replay gia' dispatchato compare come run completata con successo.
    if [ -s "$state/nonces" ]; then
      paste -d'|' "$state/sections" "$state/nonces" | while IFS='|' read -r s n; do
        printf '{"databaseId":900,"displayTitle":"cover-publish-section / %s / nonce=%s / dry=false / c=none","status":"completed","conclusion":"success"}\\n' "$s" "$n"
      done | jq -sc .
    else echo '[]'; fi
    ;;
  *) echo "gh inatteso: $*" >&2; exit 1 ;;
esac
`);
  if (preexisting) {
    const sections = JSON.parse(failedSections);
    writeFileSync(path.join(state, 'sections'), `${sections.join('\n')}\n`);
    writeFileSync(path.join(state, 'nonces'), `${sections.map((s) => `replay-failed-stage-${runId}-${s}`).join('\n')}\n`);
  }
  const summary = path.join(root, 'summary.md');
  const result = spawnSync('bash', ['-c', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_RUN_ID: runId,
      GITHUB_STEP_SUMMARY: summary,
      REPOSITORY: 'owner/repo',
      FAILED_SECTIONS: failedSections,
      REPLAY_PENDING_POLL_DELAY_SECONDS: '0',
    },
  });
  const log = path.join(state, 'dispatch.log');
  return {
    result,
    dispatches: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
  };
}

test('MEDIUM 1: il replay passa dal dispatcher con nonce legato al run e riporta l esito', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r13-replay-'));
  try {
    const { result, dispatches, summary } = runReplayStep(root, { failedSections: '["canton-ow"]' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(dispatches.length, 1);
    assert.match(dispatches[0], /dispatch_nonce=replay-failed-stage-4242-canton-ow/u);
    assert.match(dispatches[0], /dry_run=false/u);
    assert.match(summary, /replay dispatchati o gia presenti: canton-ow/u);
    assert.match(summary, /replay non confermati \(li riprende il reconciler\): nessuno/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test('MEDIUM 1: un rerun dello stesso run non dispatcha un secondo replay', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r13-replay-rerun-'));
  try {
    const { result, dispatches } = runReplayStep(root, { failedSections: '["canton-ow","canton-nw"]', preexisting: true });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(dispatches, [], 'replay gia accettato: nessun nuovo dispatch');
    assert.match(result.stdout, /replay completato con successo/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test('MEDIUM 1: un errore residuo del dispatch non fa fallire lo step ed e dichiarato nel summary', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r13-replay-fail-'));
  try {
    const { result, dispatches, summary } = runReplayStep(root, { failedSections: '["canton-ow"]', dispatchFails: true });
    assert.equal(result.status, 0, 'uno step che fallisce salterebbe i finalize');
    assert.equal(dispatches.length, 2, 'il dispatcher ritenta prima di arrendersi');
    assert.match(result.stdout, /::warning::replay full-section NON confermato per la gamba di stage fallita canton-ow/u);
    assert.match(summary, /replay non confermati \(li riprende il reconciler\): canton-ow/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 120_000 });

// ───────── MEDIUM 2: probe per sezione ─────────

const CURRENT_START = '2026-11-28T10:00:00Z';
const BEFORE = '2026-11-28T09:00:00Z';
const AFTER = '2026-11-28T10:30:00Z';

function job(name, status, conclusion = null, completedAt = null) {
  return { name, status, conclusion, completed_at: completedAt };
}

/** `gh` finto che serve fixture JSON per endpoint; assente = lettura fallita. */
function runProbe(root, { runs, jobs = {}, current = { id: 100, run_started_at: CURRENT_START }, section = 'canton-ow', omitCurrent = false }) {
  const bin = path.join(root, 'bin');
  const fix = path.join(root, 'fix');
  mkdirSync(bin, { recursive: true });
  mkdirSync(fix, { recursive: true });
  writeFileSync(path.join(fix, 'runs.json'), JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
  if (!omitCurrent) writeFileSync(path.join(fix, 'run-100.json'), JSON.stringify(current));
  for (const [id, list] of Object.entries(jobs)) {
    writeFileSync(path.join(fix, `jobs-${id}.json`), JSON.stringify({ total_count: list.length, jobs: list }));
  }
  writeExec(bin, 'gh', `
fix="${fix}"
all="$*"
case "$all" in
  *workflows/fast-publish-section.yml/runs*) f="$fix/runs.json" ;;
  *runs/*/jobs*) id="\${all#*runs/}"; id="\${id%%/jobs*}"; f="$fix/jobs-$id.json" ;;
  *actions/runs/*) id="\${all#*actions/runs/}"; id="\${id%% *}"; f="$fix/run-$id.json" ;;
  *) exit 1 ;;
esac
[ -f "$f" ] || exit 1
cat "$f"
`);
  return spawnSync('bash', [probe], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REPO: 'owner/repo',
      CURRENT_RUN_ID: '100',
      SECTION: section,
      PENDING_PROBE_RETRY_DELAY: '0',
    },
  });
}

function withRoot(prefix, fn) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const live = (id) => ({ id, status: 'in_progress', conclusion: null, updated_at: AFTER });
const done = (id, conclusion, updated = AFTER) => ({ id, status: 'completed', conclusion, updated_at: updated });
const coordinated = job('coordinate_api_release', 'completed', 'success', BEFORE);

test('MEDIUM 2: run push vivi o cancellati di ALTRE sezioni non rendono full-section il figlio mirato', () => {
  withRoot('f1-r13-probe-other-', (root) => {
    const result = runProbe(root, {
      runs: [live(1), done(2, 'cancelled'), done(3, 'success'), { id: 100, status: 'in_progress', conclusion: null, updated_at: AFTER }],
      jobs: {
        1: [coordinated, job('stage (canton-nw)', 'completed', 'success', BEFORE), job('finalize (canton-nw)', 'in_progress')],
        2: [job('stage (canton-ti)', 'completed', 'cancelled', AFTER), job('finalize (canton-ti)', 'completed', 'cancelled', AFTER)],
      },
    });
    assert.equal(result.stdout.trim(), 'true', result.stderr);
  });
});

test('MEDIUM 2: un run push vivo con il finalize pending della stessa sezione = full-section', () => {
  withRoot('f1-r13-probe-live-', (root) => {
    const result = runProbe(root, {
      runs: [live(1)],
      jobs: { 1: [coordinated, job('finalize (canton-ow)', 'queued')] },
    });
    assert.equal(result.stdout.trim(), 'false');
  });
});

test('MEDIUM 2: run vivo con la matrix non ancora materializzata = non posso escludere', () => {
  withRoot('f1-r13-probe-unmaterialized-', (root) => {
    const result = runProbe(root, {
      runs: [live(1)],
      jobs: { 1: [job('resolve', 'completed', 'success', BEFORE), job('stage (canton-nw)', 'in_progress')] },
    });
    assert.equal(result.stdout.trim(), 'false');
  });
});

test('MEDIUM 2: run vivo con matrix definita e finalize della sezione assente o gia concluso = esclusa', () => {
  withRoot('f1-r13-probe-settled-', (root) => {
    const result = runProbe(root, {
      runs: [live(1), live(2)],
      jobs: {
        1: [coordinated, job('finalize (canton-nw)', 'in_progress')],
        2: [coordinated, job('finalize (canton-ow)', 'completed', 'success', AFTER)],
      },
    });
    assert.equal(result.stdout.trim(), 'true', result.stderr);
  });
});

test('MEDIUM 2: run cancellato con un job della stessa sezione cancellato dopo l inizio del corrente = full-section', () => {
  withRoot('f1-r13-probe-cancelled-', (root) => {
    const result = runProbe(root, {
      runs: [done(1, 'cancelled')],
      jobs: { 1: [job('finalize (canton-ow)', 'completed', 'cancelled', AFTER)] },
    });
    assert.equal(result.stdout.trim(), 'false');
  });
});

test('MEDIUM 2: un job della sezione cancellato PRIMA del run corrente non puo essere opera sua', () => {
  withRoot('f1-r13-probe-before-', (root) => {
    const result = runProbe(root, {
      runs: [done(1, 'cancelled', AFTER)],
      jobs: { 1: [job('finalize (canton-ow)', 'completed', 'cancelled', BEFORE)] },
    });
    assert.equal(result.stdout.trim(), 'true');
  });
});

test('LOW 1: un finalize sostituito dentro un run concluso failure per un altra gamba conta come sostituzione', () => {
  withRoot('f1-r13-probe-failure-', (root) => {
    const runs = [done(1, 'failure')];
    const replaced = runProbe(root, {
      runs,
      jobs: { 1: [job('stage (canton-nw)', 'completed', 'failure', AFTER), job('finalize (canton-ow)', 'completed', 'cancelled', AFTER)] },
    });
    assert.equal(replaced.stdout.trim(), 'false');
    const unrelated = runProbe(root, {
      runs,
      jobs: { 1: [job('stage (canton-nw)', 'completed', 'failure', AFTER), job('finalize (canton-ow)', 'completed', 'success', AFTER)] },
    });
    assert.equal(unrelated.stdout.trim(), 'true');
  });
});

test('MEDIUM 2: letture fallite o non valide = fail-safe full-section', () => {
  withRoot('f1-r13-probe-failsafe-', (root) => {
    // jobs del candidato non leggibile
    assert.equal(runProbe(root, { runs: [live(1)], jobs: {} }).stdout.trim(), 'false');
  });
  withRoot('f1-r13-probe-failsafe-current-', (root) => {
    // inizio del run corrente non leggibile
    assert.equal(runProbe(root, { runs: [], omitCurrent: true }).stdout.trim(), 'false');
  });
  withRoot('f1-r13-probe-failsafe-section-', (root) => {
    assert.equal(runProbe(root, { runs: [], section: '' }).stdout.trim(), 'false');
  });
  withRoot('f1-r13-probe-failsafe-trunc-', (root) => {
    const fix = path.join(root, 'fix');
    const result = runProbe(root, { runs: [] });
    writeFileSync(path.join(fix, 'runs.json'), JSON.stringify({ total_count: 150, workflow_runs: [] }));
    const again = spawnSync('bash', [probe], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, REPO: 'o/r', CURRENT_RUN_ID: '100', SECTION: 'canton-ow', PENDING_PROBE_RETRY_DELAY: '0' },
    });
    assert.equal(result.stdout.trim(), 'true');
    assert.equal(again.stdout.trim(), 'false', 'elenco troncato');
  });
}, { timeout: 60_000 });

test('MEDIUM 2: lo step del finalize passa SECTION e il run corrente al probe', () => {
  const start = stepBlock(jobBlock('finalize'), 'Read latest main after acquiring the section slot');
  assert.match(start, /SECTION: \$\{\{ matrix\.target\.section \}\}/u);
  assert.match(start, /CURRENT_RUN_ID: \$\{\{ github\.run_id \}\}/u);
  assert.match(start, /GH_TOKEN:/u);
  assert.match(start, /REPO: /u);
});

// ───────── LOW 2: conteggio degli stage artifact ─────────

test('LOW 2: il conteggio degli stage artifact esclude i marcatori fast-publish-stage-failed-*', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r13-count-'));
  try {
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    // Il run ha SOLO marcatori di gamba fallita: nessuno stage, si procede.
    // Il `gh` finto applica davvero il filtro --jq dello script.
    writeExec(bin, 'gh', `
expr=''
for ((i=1; i<=$#; i++)); do [ "\${!i}" = '--jq' ] && j=$((i+1)) && expr="\${!j}"; done
printf '%s' '{"artifacts":[{"name":"fast-publish-stage-failed-canton-ow"},{"name":"fast-publish-stage-failed-canton-nw"}]}' | jq -r "$expr"
`);
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(artifacts);
    // Estrae il solo blocco del download fallito, eseguito sul codice vero.
    const source = readFileSync(coordinate, 'utf8');
    const block = source.slice(source.indexOf("if [ \"${STAGE_DOWNLOAD_FAILED:-false}\""), source.indexOf('requested_stage_sections='));
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${block}\necho DONE`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STAGE_DOWNLOAD_FAILED: 'true', REPO: 'o/r', RUN_ID: '77' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nessun artifact di stage nel run/u);
    assert.doesNotMatch(result.stderr, /fallito 3 volte ma il run ne ha/u);
    assert.match(result.stdout, /DONE/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('LOW 2: marcatori failed piu stage veri = conta solo gli stage veri', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r13-count2-'));
  try {
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeExec(bin, 'gh', `
expr=''
for ((i=1; i<=$#; i++)); do [ "\${!i}" = '--jq' ] && j=$((i+1)) && expr="\${!j}"; done
printf '%s' '{"artifacts":[{"name":"fast-publish-stage-canton-ti"},{"name":"fast-publish-stage-failed-canton-ow"},{"name":"other"}]}' | jq -r "$expr"
`);
    const source = readFileSync(coordinate, 'utf8');
    const block = source.slice(source.indexOf("if [ \"${STAGE_DOWNLOAD_FAILED:-false}\""), source.indexOf('requested_stage_sections='));
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${block}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STAGE_DOWNLOAD_FAILED: 'true', REPO: 'o/r', RUN_ID: '77' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ma il run ne ha 1:/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
